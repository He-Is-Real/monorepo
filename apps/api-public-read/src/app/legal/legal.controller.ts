import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import { ProblemException } from '@heisreal/http';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { collectionETag, representationETag, sendCached } from '../caching';
/**
 * The feature columns of the social sharing form (D93, `socialSharingFormVersion`): the
 * platforms (`share<Platform>`) and uses (`allow<Use>`) a version allows. Adding one is a schema
 * column, a new form version, and an entry here.
 */
export const SOCIAL_FEATURES = [
  'shareYouTube',
  'shareInstagram',
  'shareTikTok',
  'shareFacebook',
  'allowEditingAndClipping',
  'allowChurchAndPartnerMedia',
  'allowPrintAndEvents',
  'allowPaidPromotion',
] as const;

const VERSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NUMBER = /^[1-9][0-9]{0,8}$/;

/**
 * D121, D125: the two legal documents, each with its own numbered versions. Every version that
 * counts (the privacy policy's: published standard versions, dev's placeholders in dev only,
 * D75; the terms': every version, dev's placeholder in dev only), newest first, and the one in
 * force with its words.
 */
const DOCUMENT_VERSIONS = {
  privacy: `
    SELECT id, number, effectiveFrom ?? createdAt AS publishedAt, contentHash
      FROM dpaVersion
      WHERE status = 'published' AND kind = 'standard' AND number != NONE AND fn::legal::counts(id)
        AND (effectiveFrom = NONE OR effectiveFrom <= time::now())
      ORDER BY number DESC;
    LET $c = fn::legal::dpa_in_force();
    RETURN IF $c = NONE { NONE } ELSE { (SELECT id, text FROM ONLY $c) };`,
  terms: `
    SELECT id, number, publishedAt, contentHash
      FROM termsVersion WHERE fn::legal::terms_counts(id)
      ORDER BY number DESC;
    LET $c = fn::legal::terms_in_force();
    RETURN IF $c = NONE { NONE } ELSE { (SELECT id, text FROM ONLY $c) };`,
} as const;
type DocumentName = keyof typeof DOCUMENT_VERSIONS;
const isDocument = (d: string): d is DocumentName =>
  Object.hasOwn(DOCUMENT_VERSIONS, d);
/** One version that counts, with its words, and the number of the one in force. */
const DOCUMENT_VERSION = {
  privacy: `
    SELECT id, number, effectiveFrom ?? createdAt AS publishedAt, contentHash, text
      FROM dpaVersion
      WHERE number = $number AND status = 'published' AND kind = 'standard' AND fn::legal::counts(id)
        AND (effectiveFrom = NONE OR effectiveFrom <= time::now());
    RETURN fn::legal::dpa_in_force().number;`,
  terms: `
    SELECT id, number, publishedAt, contentHash, text
      FROM termsVersion WHERE number = $number AND fn::legal::terms_counts(id);
    RETURN fn::legal::terms_in_force().number;`,
} as const;

/** `LegalDocumentVersion`. */
const versionOf = (r: Record<string, unknown>) => ({
  id: key(String(r['id'])),
  number: r['number'] as number,
  publishedAt: new Date(String(r['publishedAt'])).toISOString(),
  contentHash: r['contentHash'] as string,
});

const noQuery = (query: Record<string, unknown>) => {
  const name = Object.keys(query)[0];
  if (name !== undefined) {
    throw new ProblemException(
      HttpStatus.BAD_REQUEST,
      'validation_failed',
      'Validation failed',
      undefined,
      [
        {
          pointer: `/${name}`,
          code: 'unknown_parameter',
          message: 'This route takes no query parameters.',
        },
      ],
    );
  }
};
const FORMS = {
  signup: 'signupFormVersion',
  testimony: 'testimonyFormVersion',
  social: 'socialSharingFormVersion',
};

/** `table:id` → `id`. */
const key = (id: string) => id.slice(id.indexOf(':') + 1);

const notFound = (what: string) =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    `${what} isn’t published.`,
  );

const DPA_FIELDS = `id, kind, status, materiality, contentHash, changeSummary, supersedes,
  effectiveFrom, version`;

/**
 * The DPA in force (or the one asked for), with its words, and every published version. Only
 * published standard versions that count (D20; dev's placeholder only in dev, D75):
 * `fn::legal::counts`, the same rule as consent.
 */
const DPA = `
  LET $current = IF $version = NONE { fn::legal::dpa_in_force() }
    ELSE { type::record('dpaVersion', $version) };
  SELECT ${DPA_FIELDS}, text FROM dpaVersion
    WHERE id = $current AND status = 'published' AND kind = 'standard' AND fn::legal::counts(id);
  SELECT ${DPA_FIELDS}, effectiveFrom ?? createdAt AS since, createdAt FROM dpaVersion
    WHERE status = 'published' AND kind = 'standard' AND fn::legal::counts(id)
    ORDER BY since DESC, createdAt DESC, id DESC;`;

interface DpaRow {
  id: string;
  kind: string;
  status: string;
  materiality?: string | null;
  contentHash: string;
  changeSummary?: string | null;
  supersedes?: string | null;
  effectiveFrom?: string | null;
  version: number;
  text?: string | null;
}

/** `components.yaml#/components/schemas/DpaVersion`. */
function dpaVersion(r: DpaRow) {
  return {
    id: key(r.id),
    kind: r.kind,
    status: r.status,
    materiality: r.materiality ?? null,
    contentHash: r.contentHash,
    changeSummary: r.changeSummary ?? null,
    supersedes: r.supersedes ? key(r.supersedes) : null,
    effectiveFrom: r.effectiveFrom ?? null,
    version: r.version,
  };
}

/**
 * api-public-read.yaml, tag Legal (M2): the privacy document and the consent forms a person
 * reads before agreeing (D20, D73, D84, D93). Published versions only, from the database's copies of
 * the texts in libs/legal (kept in step with the files by the migration).
 */
@Controller('v1/legal')
export class LegalController {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  /**
   * D121, D125: one legal document (`privacy`, the privacy policy; `terms`, the terms of use):
   * the version in force with its words (Markdown the site renders), and every version anyone
   * may read, newest first (/privacy and /terms, and the consent pages, which bind the versions
   * in force).
   */
  @Get('documents/:document')
  async getDocument(
    @Param('document') document: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    noQuery(query);
    if (!isDocument(document)) throw notFound('That legal document');
    const results = (await runQuery(
      this.db,
      DOCUMENT_VERSIONS[document],
    )) as unknown[];
    const rows = results[0] as Record<string, unknown>[];
    const current = results[results.length - 1] as {
      id: string;
      text: string;
    } | null;
    const versions = rows.map(versionOf);
    const currentId = current ? key(String(current.id)) : null;
    const shown = versions.find((v) => v.id === currentId);
    const body = {
      document,
      current:
        shown && current && typeof current.text === 'string'
          ? { ...shown, text: current.text }
          : null,
      versions,
    };
    return sendCached(res, ifNoneMatch, body, collectionETag(body));
  }

  /**
   * One version of a legal document, by its number, with its words (/privacy/versions/<n>):
   * kept for ever, so a person can read what they agreed to.
   */
  @Get('documents/:document/versions/:number')
  async getDocumentVersion(
    @Param('document') document: string,
    @Param('number') number: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    noQuery(query);
    if (!isDocument(document) || !NUMBER.test(number)) {
      throw notFound('That version');
    }
    const results = (await runQuery(this.db, DOCUMENT_VERSION[document], {
      number: Number(number),
    })) as unknown[];
    const [row] = results[0] as Record<string, unknown>[];
    if (!row || typeof row['text'] !== 'string') throw notFound('That version');
    const inForce = results[results.length - 1];
    const body = {
      document,
      ...versionOf(row),
      text: row['text'],
      current: inForce === row['number'],
    };
    return sendCached(res, ifNoneMatch, body, representationETag(body));
  }

  @Get('dpa')
  async getDpa(
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const unknown = Object.keys(query).filter((n) => n !== 'version');
    const version = query['version'];
    if (
      unknown.length > 0 ||
      (version !== undefined && typeof version !== 'string')
    ) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Validation failed',
        undefined,
        [
          {
            pointer: `/${unknown[0] ?? 'version'}`,
            code: 'unknown_parameter',
            message: 'This route takes only `version`, once.',
          },
        ],
      );
    }
    if (version !== undefined && !VERSION_ID.test(version)) {
      throw notFound('That privacy document version');
    }
    const results = (await runQuery(this.db, DPA, {
      version: version ?? undefined,
    })) as unknown[];
    const [current] = results[results.length - 2] as DpaRow[];
    const history = results[results.length - 1] as DpaRow[];
    if (!current || typeof current.text !== 'string') {
      throw notFound('A privacy document');
    }
    const body = {
      current: { ...dpaVersion(current), text: current.text },
      history: history.map(dpaVersion),
    };
    return sendCached(res, ifNoneMatch, body, representationETag(body));
  }

  @Get('forms/:form')
  async getForm(
    @Param('form') form: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (Object.keys(query).length > 0) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Validation failed',
        undefined,
        [
          {
            pointer: `/${Object.keys(query)[0]}`,
            code: 'unknown_parameter',
            message: 'This route takes no query parameters.',
          },
        ],
      );
    }
    if (!(form in FORMS)) throw notFound('That consent form');
    const results = (await runQuery(
      this.db,
      `LET $f = fn::form::latest($form);
       RETURN IF $f = NONE { NONE } ELSE {
         object::extend($f, { required: fn::form::statements($f.id) })
       };`,
      { form },
    )) as unknown[];
    const f = results[results.length - 1] as Record<string, unknown> | null;
    // D114: no version is shown without its boxes as structured data (the migration gives
    // every version them); a page can't be left with words and no boxes.
    const boxes = f?.['statements'];
    if (
      !f ||
      typeof f['text'] !== 'string' ||
      !Array.isArray(boxes) ||
      typeof f['statementsHash'] !== 'string'
    ) {
      throw notFound(`A ${form} consent form`);
    }
    const body = {
      form,
      id: key(String(f['id'])),
      status: f['status'],
      publishedAt: f['publishedAt'],
      dpaVersion: key(String(f['dpaVersion'])),
      textHash: f['textHash'],
      text: f['text'],
      statements: f['required'],
      // D114: the boxes, in order, with the exact words beside each (the version's
      // statements file); the page draws them from here, never from `text`.
      boxes: (boxes as { key: string; label: string; step?: string }[]).map(
        (b) => ({
          statement: b.key,
          label: b.label,
          // Where the box sits (testimony: start or submit), from the statements data too.
          step: b.step ?? null,
        }),
      ),
      statementsHash: f['statementsHash'],
      version: f['version'],
      ...(form === 'testimony'
        ? {
            features: {
              requiresAcceptanceForNewSubmissions:
                f['requiresAcceptanceForNewSubmissions'] === true,
              coversPublicPublishing: f['coversPublicPublishing'] === true,
              draftRetentionMonths: f['draftRetentionMonths'],
            },
          }
        : {}),
      ...(form === 'social'
        ? {
            // A column added after this version was published reads NONE: not allowed (D93).
            features: Object.fromEntries(
              SOCIAL_FEATURES.map((c) => [c, f[c] === true]),
            ),
          }
        : {}),
    };
    return sendCached(res, ifNoneMatch, body, representationETag(body));
  }
}

@Module({ controllers: [LegalController] })
export class LegalModule {}

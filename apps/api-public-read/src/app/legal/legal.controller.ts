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
import { createHash } from 'node:crypto';
import { runQuery, SURREAL } from '@heisreal/database';
import { ProblemException } from '@heisreal/http';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import {
  collectionETag,
  ifNoneMatchHits,
  publicCacheControl,
  representationETag,
  sendCached,
} from '../caching';
import {
  DOCUMENT_PDFS,
  type DocumentPdfs,
  documentPdfsFromEnv,
} from './document-pdfs';

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
const PDF_FILE = /^([a-z0-9][a-z0-9_-]{0,63})\.pdf$/;
/** CACHE_PUBLIC's long form for a PDF: its URL always names the same bytes. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * D121: the two legal documents, each with its own versions. Every version that counts (the
 * privacy policy's: published standard versions, dev's placeholder in dev only, D75; the terms':
 * every version, dev's placeholder in dev only), newest first, with the one in force.
 */
const DOCUMENT_VERSIONS = {
  privacy: `
    SELECT id, effectiveFrom ?? createdAt AS publishedAt, createdAt, changeSummary AS changeNote,
        contentHash AS textHash, pdfSha256, pdfSize
      FROM dpaVersion
      WHERE status = 'published' AND kind = 'standard' AND fn::legal::counts(id)
        AND (effectiveFrom = NONE OR effectiveFrom <= time::now())
      ORDER BY publishedAt DESC, createdAt DESC, id DESC;
    LET $c = fn::legal::dpa_in_force();
    RETURN IF $c = NONE { NONE } ELSE { (SELECT id, text FROM ONLY $c) };`,
  terms: `
    SELECT id, publishedAt, changeNote, textHash, pdfSha256, pdfSize
      FROM termsVersion WHERE fn::legal::terms_counts(id)
      ORDER BY publishedAt DESC, id DESC;
    LET $c = fn::legal::terms_in_force();
    RETURN IF $c = NONE { NONE } ELSE { (SELECT id, text FROM ONLY $c) };`,
} as const;
type DocumentName = keyof typeof DOCUMENT_VERSIONS;
const isDocument = (d: string): d is DocumentName =>
  Object.hasOwn(DOCUMENT_VERSIONS, d);
/** A document version's PDF of record, if it has one and counts. */
const DOCUMENT_PDF = {
  privacy: `SELECT pdfSha256, pdfPath FROM type::record('dpaVersion', $version)
    WHERE status = 'published' AND kind = 'standard' AND fn::legal::counts(id) AND pdfSha256 != NONE;`,
  terms: `SELECT pdfSha256, pdfPath FROM type::record('termsVersion', $version)
    WHERE fn::legal::terms_counts(id);`,
} as const;

/** `LegalDocumentPdf`, or null for a version published without one. */
const pdfOf = (r: Record<string, unknown>) =>
  typeof r['pdfSha256'] === 'string'
    ? { sha256: r['pdfSha256'], size: r['pdfSize'] }
    : null;

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
  materiality: string;
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
    materiality: r.materiality,
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
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(DOCUMENT_PDFS) private readonly pdfs: DocumentPdfs | null,
  ) {}

  /**
   * D121: one legal document (`privacy`, the privacy policy; `terms`, the terms of use): the
   * version in force with the words the site renders, and every version anyone may read, newest
   * first, each with its PDF of record (/privacy and /terms: "Download this version (PDF)" and
   * "Previous versions"; the consent pages bind the versions in force).
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
    const versions = rows.map((r) => ({
      id: key(String(r['id'])),
      publishedAt: new Date(String(r['publishedAt'])).toISOString(),
      changeNote: (r['changeNote'] as string | undefined) ?? null,
      textHash: r['textHash'],
      pdf: pdfOf(r),
    }));
    const currentId = current ? key(String(current.id)) : null;
    const body = {
      document,
      current:
        current && typeof current.text === 'string'
          ? {
              ...(versions.find((v) => v.id === currentId) ?? {
                id: currentId,
              }),
              text: current.text,
            }
          : null,
      versions,
    };
    return sendCached(res, ifNoneMatch, body, collectionETag(body));
  }

  /**
   * One version's PDF of record, as stored: inline, under a fixed file name, never sniffed, its
   * strong ETag the PDF's sha256, checked against the recorded sha256 before it's sent. The URL
   * always names the same bytes, so with shared caching on (D51, never in dev) caches may keep it
   * a year.
   */
  @Get('documents/:document/versions/:file')
  async getDocumentPdf(
    @Param('document') document: string,
    @Param('file') file: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    noQuery(query);
    const version = PDF_FILE.exec(file)?.[1];
    if (!isDocument(document) || !version) throw notFound('That PDF');
    const results = (await runQuery(this.db, DOCUMENT_PDF[document], {
      version,
    })) as unknown[];
    const [row] = results[results.length - 1] as {
      pdfSha256: string;
      pdfPath: string;
    }[];
    if (!row) throw notFound('That PDF');
    if (!this.pdfs) {
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'pdf_unavailable',
        'Service Unavailable',
      );
    }
    const etag = `"${row.pdfSha256}"`;
    const cacheControl =
      publicCacheControl() === 'no-store' ? 'no-store' : CACHE_IMMUTABLE;
    if (ifNoneMatchHits(ifNoneMatch, etag)) {
      res
        .status(HttpStatus.NOT_MODIFIED)
        .setHeader('ETag', etag)
        .setHeader('Cache-Control', cacheControl)
        .end();
      return;
    }
    const bytes = await this.pdfs.read(row.pdfPath);
    if (
      !bytes ||
      createHash('sha256').update(bytes).digest('hex') !== row.pdfSha256
    ) {
      // The row says the PDF is kept for ever: a missing or different object is our fault.
      throw new Error(
        `${document} ${version}: the stored PDF is ${bytes ? 'not the one recorded' : 'missing'}`,
      );
    }
    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', 'application/pdf')
      .setHeader(
        'Content-Disposition',
        `inline; filename="heisreal-${document === 'privacy' ? 'privacy-policy' : 'terms-of-use'}-${version}.pdf"`,
      )
      .setHeader('X-Content-Type-Options', 'nosniff')
      .setHeader('ETag', etag)
      .setHeader('Cache-Control', cacheControl)
      .setHeader('Content-Length', String(bytes.length))
      .end(bytes);
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

@Module({
  controllers: [LegalController],
  providers: [
    { provide: DOCUMENT_PDFS, useFactory: () => documentPdfsFromEnv() },
  ],
})
export class LegalModule {}

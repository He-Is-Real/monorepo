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

/** Plan 4e: the four legal texts (`LegalDocumentName`) and the table each one's versions live in. */
const DOCUMENTS = {
  'terms-of-use': 'termsOfUseAgreement',
  'testimony-consent': 'testimonyConsent',
  'social-media-sharing-consent': 'socialMediaSharingConsent',
  'privacy-notice': 'privacyNotice',
} as const;
type DocumentName = keyof typeof DOCUMENTS;
const isDocument = (d: string): d is DocumentName =>
  Object.hasOwn(DOCUMENTS, d);

/** A version number in the path: 0, 1, 2... */
const VERSION = /^(0|[1-9][0-9]{0,8})$/;

interface VersionRow {
  version: number;
  release_date: string;
}

/** `LegalDocumentVersion`. */
const versionOf = (r: VersionRow) => ({
  version: r.version,
  releaseDate: new Date(r.release_date).toISOString(),
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

const notFound = (what: string) =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    `${what} doesn’t exist.`,
  );

/**
 * api-public-read.yaml, tag Legal (plan 4e): the four legal texts, each a series of versions
 * numbered from 0 and kept for ever, unchanged. The latest is in force (a saved version takes
 * effect at once). Reference data anyone may read; never who saved a version (the audit log is
 * api-admin's).
 */
@Controller('v1/legal')
export class LegalController {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  /**
   * One legal text: its latest version with its words, and every version, newest first, without
   * words (the "Previous versions" lists on /privacy and /terms).
   */
  @Get('documents/:document')
  async getDocument(
    @Param('document') document: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    noQuery(query);
    if (!isDocument(document)) throw notFound('That legal text');
    const results = await runQuery(
      this.db,
      `SELECT record::id(id) AS version, release_date FROM type::table($table)
         ORDER BY version DESC;
       LET $l = fn::legal::latest($table);
       RETURN IF $l = NONE { NONE }
         ELSE { (SELECT record::id(id) AS version, release_date, content FROM ONLY $l) };`,
      { table: DOCUMENTS[document] },
    );
    const versions = results[0] as VersionRow[];
    const latest = results[results.length - 1] as
      | (VersionRow & { content: string })
      | null
      | undefined;
    // Every environment has version 0 of each text (data/0009); fail closed without one.
    if (!latest) throw notFound('That legal text');
    const body = {
      document,
      latest: { ...versionOf(latest), content: latest.content },
      versions: versions.map(versionOf),
    };
    return sendCached(res, ifNoneMatch, body, collectionETag(body));
  }

  /**
   * One version of a legal text, by its number, with its words (/privacy/versions/<n>, and the
   * version a person agreed to, for the redline from it to the latest).
   */
  @Get('documents/:document/versions/:version')
  async getDocumentVersion(
    @Param('document') document: string,
    @Param('version') version: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    noQuery(query);
    if (!isDocument(document) || !VERSION.test(version)) {
      throw notFound('That version');
    }
    const results = await runQuery(
      this.db,
      `SELECT record::id(id) AS version, release_date, content
         FROM type::record($table, $version);
       RETURN record::id(fn::legal::latest($table));`,
      { table: DOCUMENTS[document], version: Number(version) },
    );
    const [row] = results[0] as (VersionRow & { content: string })[];
    if (!row) throw notFound('That version');
    const body = {
      document,
      ...versionOf(row),
      content: row.content,
      latest: results[results.length - 1] === row.version,
    };
    return sendCached(res, ifNoneMatch, body, representationETag(body));
  }
}

@Module({ controllers: [LegalController] })
export class LegalModule {}

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import {
  isTransactionConflict,
  requireWritten,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import { ifNoneMatches, ProblemException, weakETag } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';

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

/** The text's limit, as the contract's and the schema's (characters). */
export const MAX_CONTENT = 100_000;

/** A field error, as RFC 9457 `errors[]` (D30). */
const invalid = (pointer: string, code: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, code, message }],
  );

const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    'There’s no such legal text.',
  );

/**
 * What a refused save answers (409), or null for any other error (a 5XX). The database refuses a
 * version that isn't one after the latest (`legal_version_number`); a record that already exists
 * or a transaction conflict means another admin saved that number at the same moment. Either
 * way: reload, then make the changes again.
 */
function saveRefusal(err: unknown): ProblemException | null {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /\blegal_version_number:/.test(message) ||
    /already exists/.test(message) ||
    isTransactionConflict(err)
  ) {
    return new ProblemException(
      HttpStatus.CONFLICT,
      'document_changed',
      'Conflict',
      'Another version of this text was saved meanwhile: reload, then make your changes again.',
    );
  }
  return null;
}

/** `PublishLegalDocument`'s body. */
export interface PublishInput {
  /** The number it is saved as: one after the latest the admin edited. */
  version: number;
  /** The new version's Markdown, with `\n` line ends. */
  content: string;
}

function parsePublish(body: unknown): PublishInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'invalid_body', 'A JSON object.');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find(
    (k) => k !== 'version' && k !== 'content',
  );
  if (unknown) {
    throw invalid(
      `/${unknown}`,
      'unknown_field',
      'Not a field of this command.',
    );
  }
  const version = b['version'];
  if (!(
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 0
  )) {
    throw invalid(
      '/version',
      'invalid_version',
      'The number this version is saved as: one after the latest.',
    );
  }
  if (typeof b['content'] !== 'string') {
    throw invalid('/content', 'required', 'Required.');
  }
  // One line ending, whatever the admin's browser or system sends (the contract's rule).
  const content = b['content'].replace(/\r\n?/g, '\n');
  if (content.trim() === '' || content.length > MAX_CONTENT) {
    throw invalid(
      '/content',
      'invalid_content',
      `The text is required, at most ${MAX_CONTENT} characters.`,
    );
  }
  return { version, content };
}

interface VersionRow {
  version: number;
  release_date: string;
}

const iso = (d: string) => new Date(d).toISOString();

/**
 * api-admin.yaml, tag LegalDocuments (plan 4e): the four legal texts, each a series of immutable
 * versions numbered from 0, for Admin and Super Admin at /admin/consent (D1). An admin edits the
 * latest version's Markdown and saves the result as the next number, in force at once. Nothing
 * here changes or deletes a version: the database refuses that anyway, whoever asks.
 */
@Controller('v1/admin/legal-documents')
export class LegalDocumentsController {
  private readonly logger = new Logger(LegalDocumentsController.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    private readonly people: PersonSessions,
  ) {}

  @Get(':document/versions')
  @RequiresRole('Admin')
  async listVersions(
    @Param('document') document: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    if (!isDocument(document)) throw notFound();
    const [versions, latest] = (await runQuery(
      this.db,
      `SELECT record::id(id) AS version, release_date FROM type::table($table)
         ORDER BY version DESC;
       LET $l = fn::legal::latest($table);
       RETURN IF $l = NONE { NONE }
         ELSE { (SELECT record::id(id) AS version, release_date, content FROM ONLY $l) };`,
      { table: DOCUMENTS[document] },
    ).then((r) => [r[0], r[r.length - 1]])) as [
      VersionRow[],
      (VersionRow & { content: string }) | null | undefined,
    ];
    // Every environment has version 0 of each text (data/0009); without one there's nothing to edit.
    if (!latest) throw notFound();
    const body = {
      document,
      latest: {
        version: latest.version,
        releaseDate: iso(latest.release_date),
        content: latest.content,
      },
      data: versions.map((v) => ({
        version: v.version,
        releaseDate: iso(v.release_date),
      })),
    };
    const etag = weakETag(body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return body;
  }

  /**
   * PublishLegalVersion: saves `content` as version `version`, which must be one after the
   * latest (409 `document_changed` otherwise: another admin saved meanwhile). One transaction
   * writes the version and its audit row (the admin, and the new version as the entity); the
   * database sets its release date. It is in force the moment it commits.
   */
  @Post(':document/versions')
  @RequiresRole('Admin')
  async publish(
    @Param('document') document: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    if (!isDocument(document)) throw notFound();
    const input = parsePublish(body);
    const { role } = await this.people.authenticate(req);
    // Who saves it: the admin's own user record, from their own database session (D27).
    const user = await this.people.run(req, async ({ user }) => user);
    let results: unknown[];
    try {
      results = await runQuery(
        this.db,
        `BEGIN TRANSACTION;
         LET $row = (CREATE ONLY type::record($table, $version) CONTENT { content: $content }
           RETURN record::id(id) AS version, release_date, id);
         IF $row = NONE { THROW 'the legal text version was not written' };
         LET $audit = (CREATE ONLY auditLog CONTENT {
             service: 'api-admin', action: 'PublishLegalVersion', actor: $user,
             actorRole: $role, entity: $row.id
           } RETURN id);
         IF $audit = NONE { THROW 'the audit row was not written' };
         $row;
         COMMIT TRANSACTION;`,
        {
          table: DOCUMENTS[document],
          version: input.version,
          content: input.content,
          user,
          role,
        },
      );
    } catch (err) {
      throw saveRefusal(err) ?? err;
    }
    const row = requireWritten<VersionRow>(
      results[results.length - 2],
      'legal text version',
    );
    this.logger.log(`Saved ${document} version ${row.version}`);
    res.status(HttpStatus.CREATED);
    res.setHeader('Location', `/v1/admin/legal-documents/${document}/versions`);
    return { version: row.version, releaseDate: iso(row.release_date) };
  }
}

@Module({ controllers: [LegalDocumentsController] })
export class LegalDocumentsModule {}

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
import {
  ifNoneMatches,
  NoConsentRequired,
  PersonSessions,
  weakETag,
} from '@heisreal/consent';
import {
  isTransactionConflict,
  requireWritten,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import { ProblemException } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';

/** D121: the two legal documents and the table each one's versions live in. */
const DOCUMENTS = {
  privacy: 'dpaVersion',
  terms: 'termsVersion',
} as const;
type DocumentName = keyof typeof DOCUMENTS;
const isDocument = (d: string): d is DocumentName =>
  Object.hasOwn(DOCUMENTS, d);

/** The text's limit, as the schema's (characters). */
const MAX_TEXT = 200_000;

/** `table:id` → `id`. */
const key = (id: string) => {
  const k = id.slice(id.indexOf(':') + 1);
  return k.startsWith('⟨') && k.endsWith('⟩') ? k.slice(1, -1) : k;
};

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
    'There’s no such legal document.',
  );

/**
 * What a refused publish answers (409), or null for any other error (a 5XX). The transaction
 * names `document_changed` when the version in force isn't the one the admin edited; a
 * transaction conflict or the unique version number means another admin published this
 * document at the same moment: the same answer, reload and edit again.
 */
export function publishRefusal(err: unknown): ProblemException | null {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('document_changed') ||
    /dpa_number|terms_number/.test(message) ||
    isTransactionConflict(err)
  ) {
    return new ProblemException(
      HttpStatus.CONFLICT,
      'document_changed',
      'Conflict',
      'Another version of this document was published meanwhile: reload, then make your changes again.',
    );
  }
  return null;
}

/** `PublishLegalDocument`'s body. */
export interface PublishInput {
  /** The new version's Markdown. */
  text: string;
  /** The number of the version in force the admin edited; null for the first version. */
  basedOn: number | null;
}

function parsePublish(body: unknown): PublishInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'invalid_body', 'A JSON object.');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => k !== 'text' && k !== 'basedOn');
  if (unknown) {
    throw invalid(
      `/${unknown}`,
      'unknown_field',
      'Not a field of this command.',
    );
  }
  if (typeof b['text'] !== 'string') {
    throw invalid('/text', 'required', 'Required.');
  }
  // One line ending, so the sha256 doesn't depend on the admin's browser or system.
  const text = b['text'].replace(/\r\n?/g, '\n');
  if (text.trim() === '' || text.length > MAX_TEXT) {
    throw invalid(
      '/text',
      'invalid_text',
      `The text is required, at most ${MAX_TEXT} characters.`,
    );
  }
  const based = b['basedOn'];
  if (
    based !== null &&
    !(typeof based === 'number' && Number.isInteger(based) && based > 0)
  ) {
    throw invalid(
      '/basedOn',
      'invalid_version',
      'The version number edited, or null for the first version.',
    );
  }
  return { text, basedOn: based };
}

/** The version in force, by document (SurrealQL). */
const IN_FORCE: Record<DocumentName, string> = {
  privacy: 'fn::legal::dpa_in_force()',
  terms: 'fn::legal::terms_in_force()',
};

/** The new version's row, by document (SurrealQL object; $-variables from publish). */
const NEW_ROW: Record<DocumentName, string> = {
  // D121, D125: a privacy policy version is a standard dpaVersion, published at once.
  privacy: `{ kind: 'standard', status: 'published', contentHash: crypto::sha256($text),
    text: $text, source: 'admin', publishedBy: $user }`,
  terms: `{ text: $text, contentHash: crypto::sha256($text), source: 'admin',
    publishedBy: $user }`,
};

/** Every published version of a document, newest first, and the one in force with its words. */
const VERSIONS: Record<DocumentName, string> = {
  privacy: `SELECT number, effectiveFrom ?? createdAt AS publishedAt, publishedBy, source,
      devPlaceholder
     FROM dpaVersion WHERE status = 'published' AND kind = 'standard' AND number != NONE
     ORDER BY number DESC;
   LET $c = fn::legal::dpa_in_force();
   RETURN IF $c = NONE { NONE } ELSE { (SELECT number, text FROM ONLY $c) };`,
  terms: `SELECT number, publishedAt, publishedBy, source, devPlaceholder
     FROM termsVersion ORDER BY number DESC;
   LET $c = fn::legal::terms_in_force();
   RETURN IF $c = NONE { NONE } ELSE { (SELECT number, text FROM ONLY $c) };`,
};

/**
 * api-admin.yaml, tag LegalDocuments (D121, D125; Joel, 2026-10-30): the privacy policy and the
 * terms of use, each with its own numbered versions, for Admin and above (D1). A version is the
 * Markdown the site renders: an admin edits the version in force at /admin/legal and publishes
 * the result as the next version, live at once. The first version may be published here too.
 * Nothing here edits or deletes a version: the database refuses that anyway.
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
  @NoConsentRequired(
    'listing a legal document’s versions reads reference data, nothing about the admin',
  )
  async listVersions(
    @Param('document') document: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    if (!isDocument(document)) throw notFound();
    const results = (await runQuery(this.db, VERSIONS[document])) as unknown[];
    const rows = results[0] as Record<string, unknown>[];
    const current = results[results.length - 1] as {
      number: number;
      text: string | null;
    } | null;
    const body = {
      document,
      current:
        current && typeof current.text === 'string'
          ? { number: current.number, text: current.text }
          : null,
      data: rows.map((r) => ({
        number: r['number'],
        publishedAt: new Date(String(r['publishedAt'])).toISOString(),
        // Their user record's id (Clerk holds names, D16).
        publishedBy: r['publishedBy'] ? key(String(r['publishedBy'])) : null,
        source: r['source'] === 'admin' ? 'admin' : 'repo',
        devPlaceholder: r['devPlaceholder'] === true,
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
   * PublishLegalDocument: the new version's Markdown and `basedOn`, the number of the version
   * in force the admin edited (null for the first version; 409 `document_changed` if another is
   * in force now). One transaction writes the version and its audit row; the database numbers
   * it. It is in force the moment it commits.
   */
  @Post(':document/versions')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'publishing a legal document is staff work on reference data, not the admin’s own data',
  )
  async publish(
    @Param('document') document: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    if (!isDocument(document)) throw notFound();
    const input = parsePublish(body);
    const { role } = await this.people.authenticate(req);
    // Who publishes: the admin's own user record, from their own database session (D27).
    const user = await this.people.run(req, async ({ user }) => user);
    let results: unknown[];
    try {
      results = (await runQuery(
        this.db,
        `BEGIN TRANSACTION;
         LET $c = ${IN_FORCE[document]};
         LET $n = IF $c = NONE { NONE } ELSE { (SELECT VALUE number FROM ONLY $c) };
         IF $n != $based {
           THROW 'document_changed: another version of this document is in force now';
         };
         LET $row = (CREATE ONLY type::table($table) CONTENT ${NEW_ROW[document]}
           RETURN id, number, ${document === 'privacy' ? 'createdAt' : 'publishedAt'} AS publishedAt);
         IF $row = NONE { THROW 'the document version was not written' };
         LET $audit = (CREATE ONLY auditLog CONTENT {
             service: 'api-admin', action: $action, actor: $user, actorRole: $role,
             entity: $row.id,
             dpaVersion: IF record::tb($row.id) = 'dpaVersion' { $row.id } ELSE { NONE }
           } RETURN id);
         IF $audit = NONE { THROW 'the audit row was not written' };
         $row;
         COMMIT TRANSACTION;`,
        {
          table: DOCUMENTS[document],
          based: input.basedOn ?? undefined,
          user,
          role,
          action:
            document === 'privacy' ? 'PublishPrivacyPolicy' : 'PublishTerms',
          text: input.text,
        },
      )) as unknown[];
    } catch (err) {
      throw publishRefusal(err) ?? err;
    }
    const row = requireWritten<{
      id: string;
      number: number;
      publishedAt: string;
    }>(results[results.length - 2], 'document version');
    this.logger.log(`Published ${document} version ${row.number}`);
    res.status(HttpStatus.CREATED);
    res.setHeader('Location', `/v1/admin/legal-documents/${document}/versions`);
    return {
      number: row.number,
      publishedAt: new Date(String(row.publishedAt)).toISOString(),
    };
  }
}

@Module({ controllers: [LegalDocumentsController] })
export class LegalDocumentsModule {}

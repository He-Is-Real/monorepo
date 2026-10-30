import { createHash } from 'node:crypto';
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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import {
  type DocumentStore,
  documentStoreFromEnv,
  ORIGINALS_STORE,
  RECORDS_STORE,
} from './document-store';
import { cleanPdf, MAX_PDF_BYTES, PdfRefused } from './pdf';

/** D121: the two legal documents and the table each one's versions live in. */
const DOCUMENTS = {
  privacy: 'dpaVersion',
  terms: 'termsVersion',
} as const;
type DocumentName = keyof typeof DOCUMENTS;
const isDocument = (d: string): d is DocumentName =>
  Object.hasOwn(DOCUMENTS, d);

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^v([0-9]{1,6})$/;
/** The web text's limit, as the schema's (characters). */
const MAX_TEXT = 200_000;
const MAX_NOTE = 500;

/** `table:id` → `id`. */
const key = (id: string) => {
  const k = id.slice(id.indexOf(':') + 1);
  return k.startsWith('⟨') && k.endsWith('⟩') ? k.slice(1, -1) : k;
};
const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');

/** What multer gives for the uploaded `pdf` part (memory storage). */
interface UploadedPdf {
  buffer: Buffer;
  size: number;
}

/** A field error, as RFC 9457 `errors[]` (D30). */
const invalid = (pointer: string, code: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, code, message }],
  );

const conflict = (code: string, detail: string) =>
  new ProblemException(HttpStatus.CONFLICT, code, 'Conflict', detail);

const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    'There’s no such legal document.',
  );

/**
 * What a refused publish answers (409), or null for any other error (a 5XX). The transaction's
 * own refusals name their code; a transaction conflict means another admin published this
 * document at the same moment (both wrote the legal fence), which is the same as
 * `document_changed`: reload and preview again.
 */
export function publishRefusal(err: unknown): ProblemException | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('already_published')) {
    return conflict(
      'already_published',
      'This PDF is already a version of this document.',
    );
  }
  if (message.includes('document_changed') || isTransactionConflict(err)) {
    return conflict(
      'document_changed',
      'Another version of this document was published meanwhile: reload and preview again.',
    );
  }
  return null;
}

/** The PDF part, checked and cleaned (D123), or the refusal as a field error. */
async function cleaned(pdf: UploadedPdf | undefined) {
  if (!pdf) throw invalid('/pdf', 'required', 'Attach the PDF.');
  try {
    return await cleanPdf(pdf.buffer);
  } catch (err) {
    if (err instanceof PdfRefused) throw invalid('/pdf', err.code, err.message);
    throw err;
  }
}

/** The fields `PublishLegalDocument` takes beside the PDF (multipart/form-data). */
export interface PublishInput {
  text: string;
  textSha256: string;
  pdfSha256: string;
  changeNote: string;
  requiresReacceptance: boolean;
  /** The version in force the preview was made against; null for the first version. */
  basedOn: string | null;
}

function parsePublish(body: unknown): PublishInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const allowed = [
    'text',
    'textSha256',
    'pdfSha256',
    'changeNote',
    'requiresReacceptance',
    'basedOn',
  ];
  const unknown = Object.keys(b).find((k) => !allowed.includes(k));
  if (unknown) {
    throw invalid(
      `/${unknown}`,
      'unknown_field',
      'Not a field of this command.',
    );
  }
  const str = (name: string) => {
    const v = b[name];
    if (typeof v !== 'string') {
      throw invalid(`/${name}`, 'required', 'Required, once.');
    }
    return v;
  };
  // Browsers send multipart text with CRLF line ends: the words are hashed with LF.
  const text = str('text').replace(/\r\n?/g, '\n');
  if (text.trim() === '' || text.length > MAX_TEXT) {
    throw invalid(
      '/text',
      'invalid_text',
      `The web text is required, at most ${MAX_TEXT} characters.`,
    );
  }
  const changeNote = str('changeNote').trim();
  if (changeNote === '' || changeNote.length > MAX_NOTE) {
    throw invalid(
      '/changeNote',
      'invalid_change_note',
      `Say what changed, in at most ${MAX_NOTE} characters.`,
    );
  }
  const textSha256 = str('textSha256');
  const pdfSha256 = str('pdfSha256');
  for (const [name, value] of [
    ['textSha256', textSha256],
    ['pdfSha256', pdfSha256],
  ]) {
    if (!SHA256.test(value)) {
      throw invalid(`/${name}`, 'invalid_hash', 'A lowercase hex sha256.');
    }
  }
  const flag = b['requiresReacceptance'] ?? 'false';
  if (flag !== 'true' && flag !== 'false') {
    throw invalid(
      '/requiresReacceptance',
      'invalid_flag',
      '`true` or `false`.',
    );
  }
  const based = str('basedOn');
  if (based !== '' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(based)) {
    throw invalid('/basedOn', 'invalid_version', 'A version id, or empty.');
  }
  return {
    text,
    textSha256,
    pdfSha256,
    changeNote,
    requiresReacceptance: flag === 'true',
    basedOn: based === '' ? null : based,
  };
}

/** The next version id of a document: `v<n+1>` for the highest `v<n>` there is. */
function nextVersion(ids: string[]): string {
  const n = ids
    .map((id) => VERSION.exec(id)?.[1])
    .filter((m): m is string => m !== undefined)
    .map(Number);
  return `v${Math.max(0, ...n) + 1}`;
}

/** The version in force, by document (SurrealQL). */
const IN_FORCE: Record<DocumentName, string> = {
  privacy: 'fn::legal::dpa_in_force()',
  terms: 'fn::legal::terms_in_force()',
};

/** The new version's row, by document (SurrealQL object; $-variables from publish). */
const NEW_ROW: Record<DocumentName, string> = {
  // D121: a privacy policy version is a standard, published dpaVersion; D122: `material` when it
  // requires re-acceptance (D93's rules, fn::legal::requires_reacceptance).
  privacy: `{ kind: 'standard', status: 'published',
    materiality: IF $requires { 'material' } ELSE { 'minor' },
    documentPath: $path, contentHash: crypto::sha256($text), text: $text,
    changeSummary: $note, effectiveFrom: time::now(),
    pdfSha256: $sha, pdfSize: $size, pdfPath: $path,
    originalSha256: $osha, originalSize: $osize, originalPath: $opath,
    source: 'admin', publishedBy: $user }`,
  terms: `{ text: $text, textHash: crypto::sha256($text), changeNote: $note,
    requiresReacceptance: $requires,
    pdfSha256: $sha, pdfSize: $size, pdfPath: $path,
    originalSha256: $osha, originalSize: $osize, originalPath: $opath,
    source: 'admin', publishedBy: $user }`,
};

const UPLOAD = FileInterceptor('pdf', {
  limits: {
    fileSize: MAX_PDF_BYTES,
    files: 1,
    fields: 6,
    fieldSize: MAX_TEXT * 4,
    parts: 7,
  },
});

/**
 * api-admin.yaml, tag LegalDocuments (D121, D123; Joel, 2026-10-30): the privacy policy and the
 * terms of use, each with its own versions, for Admin and above (D1). A new version has two
 * parts, published together: its PDF of record (the copy this service cleaned, stored once in
 * the records bucket at legal/<document>/<id>/<sha256>.pdf, kept for ever; the upload as received
 * kept privately in the originals bucket) and the web text the site renders. The first version
 * may be published here too. Nothing here edits or deletes a version: the database refuses that
 * anyway.
 */
@Controller('v1/admin/legal-documents')
export class LegalDocumentsController {
  private readonly logger = new Logger(LegalDocumentsController.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    private readonly people: PersonSessions,
    @Inject(RECORDS_STORE) private readonly records: DocumentStore | null,
    @Inject(ORIGINALS_STORE) private readonly originals: DocumentStore | null,
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
    const results = (await runQuery(
      this.db,
      document === 'privacy'
        ? `SELECT id, effectiveFrom ?? createdAt AS publishedAt, createdAt, publishedBy, source,
              changeSummary AS changeNote, materiality = 'material' AS requiresReacceptance,
              contentHash AS textHash, pdfSha256, pdfSize, originalSha256, originalSize
             FROM dpaVersion WHERE status = 'published' AND kind = 'standard'
             ORDER BY publishedAt DESC, createdAt DESC, id DESC;
           LET $c = fn::legal::dpa_in_force();
           RETURN IF $c = NONE { NONE } ELSE { (SELECT id, text FROM ONLY $c) };`
        : `SELECT id, publishedAt, publishedBy, source, changeNote, requiresReacceptance,
              textHash, pdfSha256, pdfSize, originalSha256, originalSize
             FROM termsVersion ORDER BY publishedAt DESC, id DESC;
           LET $c = fn::legal::terms_in_force();
           RETURN IF $c = NONE { NONE } ELSE { (SELECT id, text FROM ONLY $c) };`,
    )) as unknown[];
    const rows = results[0] as Record<string, unknown>[];
    const current = results[results.length - 1] as {
      id: string;
      text: string;
    } | null;
    const body = {
      document,
      current: current
        ? { id: key(String(current.id)), text: current.text ?? '' }
        : null,
      data: rows.map((r) => ({
        id: key(String(r['id'])),
        publishedAt: new Date(String(r['publishedAt'])).toISOString(),
        // Their user record's id (Clerk holds names, D16).
        publishedBy: r['publishedBy'] ? key(String(r['publishedBy'])) : null,
        source: r['source'] === 'admin' ? 'admin' : 'repo',
        changeNote: r['changeNote'] ?? null,
        requiresReacceptance: r['requiresReacceptance'] === true,
        textHash: r['textHash'],
        pdf:
          typeof r['pdfSha256'] === 'string'
            ? { sha256: r['pdfSha256'], size: r['pdfSize'] }
            : null,
        original:
          typeof r['originalSha256'] === 'string'
            ? { sha256: r['originalSha256'], size: r['originalSize'] }
            : null,
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
   * The cleaned copy of an upload (D123), for the admin's preview: what would be published, its
   * sha256 (which the publish must name), and what cleaning removed. Nothing is stored.
   */
  @Post(':document/previews')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'previewing a legal document is staff work on reference data, not the admin’s own data',
  )
  @UseInterceptors(UPLOAD)
  async preview(
    @Param('document') document: string,
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() pdf: UploadedPdf | undefined,
  ) {
    if (!isDocument(document)) throw notFound();
    const result = await cleaned(pdf);
    res.status(HttpStatus.OK);
    res.setHeader('Cache-Control', 'private, no-store');
    return {
      document,
      pdfSha256: sha256(result.cleaned),
      pdfSize: result.cleaned.length,
      originalSha256: sha256((pdf as UploadedPdf).buffer),
      originalSize: (pdf as UploadedPdf).size,
      removed: result.removed,
      pages: result.pages,
      pdfBase64: result.cleaned.toString('base64'),
    };
  }

  /**
   * PublishLegalDocument: the original PDF (multipart part `pdf`, cleaned again here: the same
   * upload gives the same cleaned copy) and the web text, with the hashes the preview showed (a
   * mismatch is refused: what's published is what was previewed), a change note, "requires
   * re-acceptance" (D93's rules, D122), and `basedOn`, the version in force the preview was made
   * against (empty for the first version; 409 `document_changed` if another is in force now). A
   * PDF already published as this document is 409 `already_published`, checked before the
   * upload and again in the transaction. Both PDFs are stored before the version is written, so
   * a version never names a missing PDF; a publish that then fails leaves only unused objects.
   */
  @Post(':document/versions')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'publishing a legal document is staff work on reference data, not the admin’s own data',
  )
  @UseInterceptors(UPLOAD)
  async publish(
    @Param('document') document: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() pdf: UploadedPdf | undefined,
    @Body() body: unknown,
  ) {
    if (!isDocument(document)) throw notFound();
    const input = parsePublish(body);
    const result = await cleaned(pdf);
    const original = (pdf as UploadedPdf).buffer;
    const pdfSha256 = sha256(result.cleaned);
    if (pdfSha256 !== input.pdfSha256) {
      throw invalid(
        '/pdfSha256',
        'preview_mismatch',
        'The PDF isn’t the one previewed.',
      );
    }
    if (sha256(input.text) !== input.textSha256) {
      throw invalid(
        '/textSha256',
        'preview_mismatch',
        'The web text isn’t the one previewed.',
      );
    }
    if (!this.records || !this.originals) {
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'storage_unavailable',
        'Service Unavailable',
      );
    }
    const { role } = await this.people.authenticate(req);
    // Who publishes: the admin's own user record, from their own database session (D27).
    const user = await this.people.run(req, async ({ user }) => user);
    const table = DOCUMENTS[document];
    const [ids, same] = (await runQuery(
      this.db,
      `SELECT VALUE <string> record::id(id) FROM ${table};
       SELECT VALUE <string> record::id(id) FROM ${table} WHERE pdfSha256 = $sha;`,
      { sha: pdfSha256 },
    )) as [string[], string[]];
    if (same.length > 0) {
      throw conflict(
        'already_published',
        `This PDF is already ${document} version ${same[0]}.`,
      );
    }
    const version = nextVersion(ids);
    const originalSha256 = sha256(original);
    const pdfPath = `legal/${document}/${version}/${pdfSha256}.pdf`;
    const originalPath = `originals/${document}/${version}/${originalSha256}.pdf`;
    await this.originals.create(originalPath, original);
    await this.records.create(pdfPath, result.cleaned);
    let results: unknown[];
    try {
      results = (await runQuery(
        this.db,
        `BEGIN TRANSACTION;
         LET $c = ${IN_FORCE[document]};
         IF ($c = NONE AND $based) OR ($c != NONE AND (!$based OR <string> record::id($c) != $based)) {
           THROW 'document_changed: another version of this document is in force now';
         };
         IF record::exists(type::record($table, $version)) {
           THROW 'document_changed: that version id was taken meanwhile';
         };
         IF array::len((SELECT VALUE id FROM type::table($table) WHERE pdfSha256 = $sha)) > 0 {
           THROW 'already_published: this PDF is already a version of this document';
         };
         LET $row = (CREATE ONLY type::record($table, $version) CONTENT ${NEW_ROW[document]}
           RETURN id, version);
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
          table,
          version,
          based: input.basedOn,
          user,
          role,
          action:
            document === 'privacy' ? 'PublishPrivacyPolicy' : 'PublishTerms',
          note: input.changeNote,
          text: input.text,
          requires: input.requiresReacceptance,
          sha: pdfSha256,
          size: result.cleaned.length,
          path: pdfPath,
          osha: originalSha256,
          osize: original.length,
          opath: originalPath,
        },
      )) as unknown[];
    } catch (err) {
      throw publishRefusal(err) ?? err;
    }
    const row = requireWritten<{ id: string; version: number }>(
      results[results.length - 2],
      'document version',
    );
    this.logger.log(`Published ${document} ${version} (${pdfSha256})`);
    res.status(HttpStatus.CREATED);
    res.setHeader('Location', `/v1/admin/legal-documents/${document}/versions`);
    return { id: key(String(row.id)), version: row.version };
  }
}

@Module({
  controllers: [LegalDocumentsController],
  providers: [
    {
      provide: RECORDS_STORE,
      useFactory: () => documentStoreFromEnv('LEGAL_DOCUMENTS_BUCKET'),
    },
    {
      provide: ORIGINALS_STORE,
      useFactory: () => documentStoreFromEnv('LEGAL_ORIGINALS_BUCKET'),
    },
  ],
})
export class LegalDocumentsModule {}

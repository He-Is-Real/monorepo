import { Storage } from '@google-cloud/storage';

/**
 * Where the legal documents' PDFs are kept (D121, D123). Two buckets (OpenTofu's gcp root), both
 * write-once with a retention policy: the records (LEGAL_DOCUMENTS_BUCKET: the cleaned copies,
 * which api-public-read serves) and the originals (LEGAL_ORIGINALS_BUCKET: the uploads as
 * received, kept for reference and never served). api-admin may only create objects in either
 * (`roles/storage.objectCreator`: no read, overwrite or delete).
 */
export interface DocumentStore {
  /**
   * Stores `bytes` at `path` once. The path names the bytes' sha256, so an object already there
   * is the same PDF (a retry after a failed publish): that counts as stored.
   */
  create(path: string, bytes: Buffer): Promise<void>;
}

export const RECORDS_STORE = Symbol('RECORDS_STORE');
export const ORIGINALS_STORE = Symbol('ORIGINALS_STORE');

/** Google Cloud Storage, signed in with api-admin's own identity (ADC). */
export class GcsDocumentStore implements DocumentStore {
  private readonly storage = new Storage();

  constructor(private readonly bucket: string) {}

  async create(path: string, bytes: Buffer): Promise<void> {
    try {
      await this.storage
        .bucket(this.bucket)
        .file(path)
        .save(bytes, {
          contentType: 'application/pdf',
          resumable: false,
          // Write-once: refused if anything is already at this path.
          preconditionOpts: { ifGenerationMatch: 0 },
        });
    } catch (err) {
      if ((err as { code?: number }).code === 412) return;
      throw err;
    }
  }
}

/** A bucket from `name`, or `null` where none is configured (local runs): publishing is refused. */
export function documentStoreFromEnv(
  name: 'LEGAL_DOCUMENTS_BUCKET' | 'LEGAL_ORIGINALS_BUCKET',
  env: Record<string, string | undefined> = process.env,
): DocumentStore | null {
  const bucket = env[name]?.trim();
  return bucket ? new GcsDocumentStore(bucket) : null;
}

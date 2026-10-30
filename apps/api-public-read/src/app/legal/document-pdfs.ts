import { Storage } from '@google-cloud/storage';

/**
 * The legal documents' PDFs of record (D121: the privacy policy and the terms of use), in the legal documents bucket
 * (LEGAL_DOCUMENTS_BUCKET, OpenTofu's gcp root): api-public-read may only read them
 * (`roles/storage.objectViewer`); api-admin writes them, once each.
 */
export interface DocumentPdfs {
  /** The object's bytes; `null` when there is no such object. */
  read(path: string): Promise<Buffer | null>;
}

export const DOCUMENT_PDFS = Symbol('DOCUMENT_PDFS');

/** Google Cloud Storage, signed in with the service's own identity (ADC). */
export class GcsDocumentPdfs implements DocumentPdfs {
  private readonly storage = new Storage();

  constructor(private readonly bucket: string) {}

  async read(path: string): Promise<Buffer | null> {
    try {
      const [bytes] = await this.storage
        .bucket(this.bucket)
        .file(path)
        .download();
      return bytes;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }
}

/** The bucket, or `null` where none is configured (local runs): the PDFs are then unavailable. */
export function documentPdfsFromEnv(
  env: Record<string, string | undefined> = process.env,
): DocumentPdfs | null {
  const bucket = env['LEGAL_DOCUMENTS_BUCKET']?.trim();
  return bucket ? new GcsDocumentPdfs(bucket) : null;
}

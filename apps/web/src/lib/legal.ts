import { apiPublicReadUrl } from './config';
import type { LegalDocumentName } from './legal-text';

// Plan 4e: the four legal texts are public, so web's server reads them from api-public-read like a
// story, with nothing from the visitor's request (D32). The browser then agrees to exactly the
// version it was shown, through api-user (agreement-step.tsx).

/** `LegalDocumentVersion`: one version, without its words. */
export interface LegalVersion {
  /** 0, 1, 2…, in saving order. */
  version: number;
  /** When it was saved, by the database's clock; in force from then. */
  releaseDate: string;
}

/** `LegalDocumentVersionContent`: one version with its Markdown. */
export interface LegalVersionContent extends LegalVersion {
  content: string;
}

/** `LegalDocument`: the latest version with its words, and every version, newest first. */
export interface LegalDocument {
  document: LegalDocumentName;
  latest: LegalVersionContent;
  versions: LegalVersion[];
}

/** `LegalDocumentVersionText`: one version with its words, and whether it's the latest. */
export interface LegalDocumentVersionText extends LegalVersionContent {
  document: LegalDocumentName;
  latest: boolean;
}

const TIMEOUT_MS = 10_000;

async function read(path: string): Promise<unknown> {
  const res = await fetch(`${apiPublicReadUrl()}${path}`, {
    headers: { accept: 'application/json' },
    // Read fresh each time: a new version is in force the moment it's saved.
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

const isVersion = (v: unknown): v is LegalVersion => {
  const r = v as Partial<LegalVersion> | null;
  return (
    !!r &&
    Number.isInteger(r.version) &&
    (r.version as number) >= 0 &&
    typeof r.releaseDate === 'string'
  );
};

const isContent = (v: unknown): v is LegalVersionContent =>
  isVersion(v) && typeof (v as LegalVersionContent).content === 'string';

const isDocument = (
  v: unknown,
  document: LegalDocumentName,
): v is LegalDocument => {
  const d = v as Partial<LegalDocument> | null;
  return (
    !!d &&
    d.document === document &&
    isContent(d.latest) &&
    Array.isArray(d.versions) &&
    d.versions.every(isVersion)
  );
};

/**
 * A legal text (`GET /v1/legal/documents/{document}`): its latest version with its words, and every
 * version. `null` when it can't be read (version 0 of each is always there, so anything else is a
 * fault).
 */
export async function getLegalDocument(
  document: LegalDocumentName,
): Promise<LegalDocument | null> {
  try {
    const d = await read(`/v1/legal/documents/${document}`);
    if (isDocument(d, document)) return d;
    throw new Error(d === null ? 'not found' : 'unexpected answer');
  } catch (err) {
    console.error(
      `api-public-read: ${document} unavailable: ${err instanceof Error ? err.message : 'error'}`,
    );
    return null;
  }
}

/**
 * One version of a legal text (`GET /v1/legal/documents/{document}/versions/{version}`). `null`
 * when there's no such version; throws when it can't be read.
 */
export async function getLegalDocumentVersion(
  document: LegalDocumentName,
  version: number,
): Promise<LegalDocumentVersionText | null> {
  const v = (await read(
    `/v1/legal/documents/${document}/versions/${version}`,
  )) as Partial<LegalDocumentVersionText> | null;
  if (v === null) return null;
  if (
    !isContent({ ...v }) ||
    v.document !== document ||
    v.version !== version ||
    typeof v.latest !== 'boolean'
  ) {
    throw new Error('unexpected answer');
  }
  return v as LegalDocumentVersionText;
}

export * from './legal-text';

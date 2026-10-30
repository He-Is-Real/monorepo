import { apiPublicReadUrl } from './config';
import type { LegalDocumentName } from './legal-text';

// D32: the consent forms and the legal documents (D121: privacy policy, terms of use) are public, so web's server reads them from
// api-public-read like a story, with nothing from the visitor's request. The browser then
// grants consent on exactly that version through api-user (consent-form.tsx).

/** `ConsentForm` in libs/contracts/openapi/components.yaml. */
export type ConsentFormName = 'signup' | 'testimony' | 'social';

/** `ConsentType`: a consent type, which is also a statement (a box) on a form (D84). */
export type ConsentStatement =
  | 'special_category_religious'
  | 'publish'
  | 'share_socials'
  | 'age_18plus'
  | 'account_data'
  /** D122: "I agree to the terms of use", on the sign-up form from v2. */
  | 'terms_of_use';

/** `ConsentBox` (D114): one box, the exact words shown beside it, and where it sits. */
export interface ConsentBox {
  statement: ConsentStatement;
  label: string;
  /** The testimony form's `start` or `submit`; null where the version doesn't say. */
  step?: 'start' | 'submit' | null;
}

/**
 * `ConsentFormVersion`: the version in force, with its short introduction (Markdown, D122) and
 * its boxes as structured data (D114): the boxes never come from the words.
 */
export interface ConsentFormVersion {
  form: ConsentFormName;
  id: string;
  dpaVersion: string;
  text: string;
  statements: ConsentStatement[];
  boxes: ConsentBox[];
}

/** `LegalDocumentVersion`: one version of a legal document, without its words (D125). */
export interface LegalDocumentVersion {
  /** The record id a grant names. */
  id: string;
  /** 1, 2, 3..., in publishing order. */
  number: number;
  publishedAt: string;
  contentHash: string;
}

/** `LegalDocument`: the version in force with its words, and every version, newest first. */
export interface LegalDocument {
  document: LegalDocumentName;
  current: (LegalDocumentVersion & { text: string }) | null;
  versions: LegalDocumentVersion[];
}

/** `LegalDocumentVersionText`: one version with its words, and whether it's in force. */
export type LegalDocumentVersionText = LegalDocumentVersion & {
  document: LegalDocumentName;
  text: string;
  current: boolean;
};

/** What a consent page shows: the form version in force and the documents in force (D122). */
export type LegalResult =
  | {
      kind: 'ok';
      form: ConsentFormVersion;
      /** The privacy policy in force, which every grant binds. */
      privacy: LegalDocument & {
        current: NonNullable<LegalDocument['current']>;
      };
      /** The terms of use in force, on a sign-up version that asks for them. */
      terms:
        | (LegalDocument & { current: NonNullable<LegalDocument['current']> })
        | null;
    }
  /** No version of the form is published (404), or a document it binds isn't. */
  | { kind: 'not_published' }
  /** api-public-read couldn't be reached or answered unexpectedly. */
  | { kind: 'unavailable' };

const TIMEOUT_MS = 10_000;

async function read(path: string): Promise<unknown> {
  const res = await fetch(`${apiPublicReadUrl()}${path}`, {
    headers: { accept: 'application/json' },
    // Read fresh each time: a new version is in force the moment it's published.
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

const isForm = (v: unknown, form: ConsentFormName): v is ConsentFormVersion => {
  const f = v as Partial<ConsentFormVersion> | null;
  return (
    !!f &&
    f.form === form &&
    typeof f.id === 'string' &&
    typeof f.dpaVersion === 'string' &&
    typeof f.text === 'string' &&
    Array.isArray(f.statements) &&
    Array.isArray(f.boxes) &&
    f.boxes.every(
      (b) =>
        typeof b?.statement === 'string' &&
        typeof b.label === 'string' &&
        b.label.trim() !== '',
    )
  );
};

const isVersion = (v: unknown): v is LegalDocumentVersion => {
  const r = v as Partial<LegalDocumentVersion> | null;
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.number === 'number' &&
    typeof r.publishedAt === 'string' &&
    typeof r.contentHash === 'string'
  );
};

const isDocument = (
  v: unknown,
  document: LegalDocumentName,
): v is LegalDocument => {
  const d = v as Partial<LegalDocument> | null;
  return (
    !!d &&
    d.document === document &&
    Array.isArray(d.versions) &&
    d.versions.every(isVersion) &&
    (d.current === null ||
      (isVersion(d.current) && typeof d.current?.text === 'string'))
  );
};

/**
 * A legal document (`GET /v1/legal/documents/{document}`, D121): the version in force with its
 * words, and every version. `null` when it can't be read.
 */
export async function getLegalDocument(
  document: LegalDocumentName,
): Promise<LegalDocument | null> {
  try {
    const d = await read(`/v1/legal/documents/${document}`);
    return isDocument(d, document) ? d : null;
  } catch (err) {
    console.error(
      `api-public-read: ${document} unavailable: ${err instanceof Error ? err.message : 'error'}`,
    );
    return null;
  }
}

/**
 * One version of a legal document by its number (`GET /v1/legal/documents/{document}/versions/
 * {number}`, D125). `null` when there's no such version; throws when it can't be read.
 */
export async function getLegalDocumentVersion(
  document: LegalDocumentName,
  number: number,
): Promise<LegalDocumentVersionText | null> {
  const v = (await read(
    `/v1/legal/documents/${document}/versions/${number}`,
  )) as Partial<LegalDocumentVersionText> | null;
  if (v === null) return null;
  if (
    !isVersion({ ...v }) ||
    v.document !== document ||
    typeof v.text !== 'string' ||
    typeof v.current !== 'boolean'
  ) {
    throw new Error('unexpected answer');
  }
  return v as LegalDocumentVersionText;
}

/**
 * The form `form` in force (`GET /v1/legal/forms/{form}`) and the documents a grant on it binds
 * (D122): the privacy policy in force and, when the version has the terms box, the terms of use
 * in force. Per request.
 */
export async function getConsentForm(
  form: ConsentFormName,
): Promise<LegalResult> {
  try {
    const version = await read(`/v1/legal/forms/${form}`);
    if (version === null) return { kind: 'not_published' };
    if (!isForm(version, form)) return { kind: 'unavailable' };
    const wantsTerms = version.boxes.some(
      (b) => b.statement === 'terms_of_use',
    );
    const [privacy, terms] = await Promise.all([
      read('/v1/legal/documents/privacy'),
      wantsTerms ? read('/v1/legal/documents/terms') : Promise.resolve(null),
    ]);
    if (privacy === null || (wantsTerms && terms === null)) {
      return { kind: 'not_published' };
    }
    if (
      !isDocument(privacy, 'privacy') ||
      (wantsTerms && !isDocument(terms, 'terms'))
    ) {
      return { kind: 'unavailable' };
    }
    const p = privacy as LegalDocument;
    const t = wantsTerms ? (terms as LegalDocument) : null;
    if (!p.current || (t && !t.current)) return { kind: 'not_published' };
    return {
      kind: 'ok',
      form: version,
      privacy: p as LegalDocument & {
        current: NonNullable<LegalDocument['current']>;
      },
      terms: t as
        | (LegalDocument & { current: NonNullable<LegalDocument['current']> })
        | null,
    };
  } catch (err) {
    console.error(
      `api-public-read: consent form ${form} unavailable: ${err instanceof Error ? err.message : 'error'}`,
    );
    return { kind: 'unavailable' };
  }
}

export * from './legal-text';

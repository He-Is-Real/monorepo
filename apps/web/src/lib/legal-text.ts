// Browser-safe parts of the legal texts (plan 4e). lib/legal.ts (server reads from
// api-public-read) re-exports them; their Markdown renders through lib/markdown.ts.

/**
 * Plan 4e's four legal texts (`LegalDocumentName`), each a series of versions numbered from 0, the
 * latest in force: the terms of use and the testimony consent (people agree to them on their
 * account), the social media sharing consent (the optional box at the end of an upload, per
 * story) and the privacy notice (shown, never agreed to).
 */
export type LegalDocumentName =
  | 'terms-of-use'
  | 'testimony-consent'
  | 'social-media-sharing-consent'
  | 'privacy-notice';

export const LEGAL_DOCUMENTS: LegalDocumentName[] = [
  'terms-of-use',
  'testimony-consent',
  'social-media-sharing-consent',
  'privacy-notice',
];

/** What a person agrees to on their account (`AgreementName`). */
export type AgreementName = 'terms-of-use' | 'testimony-consent';

/** The texts with their own public pages: /terms and /privacy. */
export type PublicDocument = 'terms-of-use' | 'privacy-notice';

const PATHS: Record<PublicDocument, string> = {
  'terms-of-use': '/terms',
  'privacy-notice': '/privacy',
};

export const isPublicDocument = (d: LegalDocumentName): d is PublicDocument =>
  d in PATHS;

/** Where web shows a public text's latest version: `/terms`, `/privacy`. */
export const documentHref = (document: PublicDocument): string =>
  PATHS[document];

/** Where web shows one version of a public text, by its number (from 0). */
export const documentVersionHref = (
  document: PublicDocument,
  version: number,
): string => `${PATHS[document]}/versions/${version}`;

/** Each text's name as a title. */
export const DOCUMENT_TITLES: Record<LegalDocumentName, string> = {
  'terms-of-use': 'Terms of use',
  'testimony-consent': 'Testimony consent',
  'social-media-sharing-consent': 'Social media sharing',
  'privacy-notice': 'Privacy notice',
};

/** Each text's name in a sentence ("version 4 of the testimony consent"). */
export const DOCUMENT_NAMES: Record<LegalDocumentName, string> = {
  'terms-of-use': 'terms of use',
  'testimony-consent': 'testimony consent',
  'social-media-sharing-consent': 'social media sharing consent',
  'privacy-notice': 'privacy notice',
};

/** "3 Oct 2026", the same on the server and in the browser (UK time). */
export const shortDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(new Date(iso));

/** "29 October 2026", the same on the server and in the browser (UK time). */
export const longDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(new Date(iso));

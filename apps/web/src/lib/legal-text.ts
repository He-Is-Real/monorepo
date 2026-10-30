// Browser-safe parts of the legal documents. lib/legal.ts (server reads from api-public-read)
// re-exports them; their Markdown renders through lib/markdown.ts (D125).

/** D121: the two legal documents (`LegalDocumentName`). */
export type LegalDocumentName = 'privacy' | 'terms';

/** Where web shows a legal document: `/privacy`, `/terms`. */
export const documentHref = (document: LegalDocumentName): string =>
  `/${document}`;

/** Where web shows one version of a legal document, by its number (D125). */
export const documentVersionHref = (
  document: LegalDocumentName,
  number: number,
): string => `/${document}/versions/${number}`;

/** The document's name in a sentence: "privacy policy", "terms of use". */
export const DOCUMENT_TITLES: Record<LegalDocumentName, string> = {
  privacy: 'Privacy policy',
  terms: 'Terms of use',
};

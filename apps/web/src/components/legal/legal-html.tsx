/** The class of the element a rendered legal text goes in. */
export const LEGAL_PROSE_CLASS =
  'space-y-4 leading-relaxed text-secondary-text [&_p]:text-pretty';

/**
 * A legal text rendered by lib/markdown.ts (D125): the same element and styles everywhere. The
 * consent pages and the share flow get HTML their server rendered, so the renderer stays off
 * their browsers. The HTML is safe to set: renderLegalMarkdown escapes any HTML in the text and
 * keeps only https:, mailto: and this site's links.
 */
export function LegalHtml({
  html,
  className = '',
}: {
  html: string;
  className?: string;
}) {
  return (
    <div
      className={`${LEGAL_PROSE_CLASS} ${className}`.trim()}
      data-legal-text=""
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

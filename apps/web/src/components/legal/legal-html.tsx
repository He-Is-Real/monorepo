import { cn, textVariants } from '@heisreal/web-ui';

/** The class of the element a rendered legal text goes in: quiet text (TX-1 A), spaced paragraphs. */
export const LEGAL_PROSE_CLASS = cn(
  'space-y-4 [&_p]:text-pretty',
  textVariants({ tone: 'quiet' }),
);

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

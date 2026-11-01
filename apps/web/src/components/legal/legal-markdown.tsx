import { LegalHtml } from '@/components/legal/legal-html';
import { renderLegalMarkdown } from '@/lib/markdown';

/**
 * A legal text, rendered (D125): the privacy notice, the terms of use, or the admin's live
 * preview. Always the same renderer (lib/markdown.ts) and styles (LegalHtml). A document to
 * read, nothing more (D114: the consent boxes are the page's own).
 */
export function LegalMarkdown({
  text,
  topLevel = 2,
  className = '',
}: {
  text: string;
  /** The level the text's top headings take: 2 under a page's h1, 3 under a section's h2. */
  topLevel?: number;
  className?: string;
}) {
  return (
    <LegalHtml
      html={renderLegalMarkdown(text, { topLevel })}
      className={className}
    />
  );
}

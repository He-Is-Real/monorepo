/**
 * The looks of text written in Markdown (apps/web's one renderer, D125: the legal texts, the
 * consents and the admin's live preview), one class string per element. A library piece (round 3,
 * TX-7 A) so the renderer, in page code, holds no text looks. Headings follow `Heading`'s
 * section and sub looks; links are in-sentence links (TX-6 A).
 */
export const proseClasses = {
  h2: 'mt-10 mb-4 text-2xl font-normal text-balance text-foreground first:mt-0 sm:text-[1.75rem]',
  h3: 'mt-6 text-lg font-semibold text-balance text-foreground first:mt-0',
  h4: 'mt-4 text-lg font-semibold text-balance text-foreground first:mt-0',
  strong: 'font-semibold text-foreground',
  ul: 'ml-6 list-disc space-y-2',
  ol: 'ml-6 list-decimal space-y-2',
  li: 'pl-1',
  blockquote:
    'space-y-2 rounded-lg border-l-4 border-primary bg-muted/50 px-4 py-3 text-base',
  // Links in a sentence are underlined (TX-6 A) and keep a 44 px touch target.
  a: 'inline-flex min-h-11 items-center underline decoration-1 underline-offset-4',
  // Inline code: a real <code>, monospace on a subtle background in both themes, wrapping
  // anywhere so a long name never pushes a phone's page sideways.
  code: 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground [overflow-wrap:anywhere] [box-decoration-break:clone]',
  // A code block wraps too: no sideways scroll on phones.
  pre: 'rounded-lg bg-muted px-4 py-3 font-mono text-sm leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]',
  // Tables, sized by the box they're in (a container query on the wrapper), not the screen:
  // the same policy sits in a page's column, a card in the share flow, and the admin's preview.
  // In a box narrower than 38rem each row stacks as a block with its column names (data-label);
  // explicit roles keep it a table for screen readers despite the CSS. In rem, so the switch
  // moves with a reader's text size. Anything still too wide for its box (a long word at 200%
  // text) scrolls inside the wrapper, never the page; a page with room either side may widen
  // the wrapper (legal-document-page.tsx).
  tableWrap: '@container overflow-x-auto rounded-xl border border-border',
  // As a table, break-word, not the site's `anywhere`: a table sizes its columns from their
  // narrowest content, which `anywhere` would shrink to single letters. Inline code too, so the
  // first column is as wide as its longest name and `__client_uat` stays on one line.
  table:
    'w-full text-left text-sm @min-[38rem]:[overflow-wrap:break-word] @min-[38rem]:[&_code]:[overflow-wrap:break-word]',
  thead: 'bg-raised text-foreground',
  // On each cell, not the thead: `overflow` doesn't apply to table rows and row groups, so a
  // hidden thead's cells would still widen the box.
  th: 'px-4 py-3 font-semibold @max-[38rem]:sr-only',
  tbody: 'text-secondary-text',
  tr: 'align-top @max-[38rem]:block @max-[38rem]:px-4 @max-[38rem]:py-4',
  trBorder: 'border-t border-border',
  trFirst: '@min-[38rem]:border-t @min-[38rem]:border-border',
  rowheader:
    'font-mono text-xs font-normal text-foreground @max-[38rem]:block @max-[38rem]:pb-2 @min-[38rem]:px-4 @min-[38rem]:py-3',
  // Stacked, each cell shows its column name above it. As a table, the other columns' words
  // may break anywhere (a long host name), so the first column keeps its names whole and the
  // rest share what's left by how much they say; at least 7rem each, never single letters.
  cell: '@min-[38rem]:min-w-28 @min-[38rem]:[overflow-wrap:anywhere] @max-[38rem]:block @max-[38rem]:py-1 @max-[38rem]:before:block @max-[38rem]:before:text-xs @max-[38rem]:before:font-semibold @max-[38rem]:before:text-foreground @max-[38rem]:before:content-[attr(data-label)] @min-[38rem]:px-4 @min-[38rem]:py-3',
} as const;

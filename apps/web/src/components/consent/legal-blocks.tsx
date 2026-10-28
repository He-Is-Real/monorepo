import type { Inline, LegalBlock } from '@/lib/legal';

/** A run of a legal text: plain, bold, or a `code` name (shown as plain text). */
export function InlineText({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((run, i) =>
        run.kind === 'bold' ? (
          <strong key={i} className="font-semibold text-foreground">
            {run.text}
          </strong>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

const HEADING = [
  '',
  '',
  'text-xl font-semibold text-foreground',
  'text-lg font-semibold text-foreground',
  'text-base font-semibold text-foreground',
  'text-base font-semibold text-foreground',
  'text-base font-semibold text-foreground',
];

/**
 * A consent form's or the privacy document's words, as published (lib/legal.ts): a document to
 * read, nothing more (D114: the boxes are the page's own). The text's headings sit one level
 * below the page's own h1.
 */
export function LegalBlocks({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <div className="space-y-4 text-[1.0625rem] leading-relaxed text-secondary-text [overflow-wrap:anywhere]">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          const level = Math.min(block.level + 1, 6);
          const Tag = `h${level}` as 'h2';
          return (
            <Tag key={i} className={`pt-2 text-balance ${HEADING[level]}`}>
              <InlineText content={block.content} />
            </Tag>
          );
        }
        if (block.kind === 'paragraph') {
          return (
            <p key={i}>
              <InlineText content={block.content} />
            </p>
          );
        }
        if (block.kind === 'note') {
          return (
            <div
              key={i}
              className="space-y-2 rounded-lg border-l-4 border-primary bg-muted/50 px-4 py-3 text-base"
            >
              {block.paragraphs.map((p, j) => (
                <p key={j}>
                  <InlineText content={p} />
                </p>
              ))}
            </div>
          );
        }
        return (
          <ul key={i} className="space-y-3">
            {block.items.map((item, j) => (
              <li key={j} className="ml-6 list-disc pl-1">
                <InlineText content={item.content} />
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}

import { Fragment } from 'react';
import { foldLabel, type RedlineItem, type Segment } from '@/lib/redline';

/**
 * What changed between two versions of a legal text (plan 4e), the one redline people see before
 * re-agreeing and admins see before saving: one column at every size, in the site's reading
 * style. Added words are underlined in green, removed ones struck through in red, and neither
 * relies on colour: they are `<ins>` and `<del>`, each named for screen readers ("added",
 * "removed"). Unchanged sections and paragraphs fold into a line saying how many.
 */
export function Redline({
  items,
  label = 'What changed',
  className = '',
}: {
  items: RedlineItem[];
  /** The region's name for screen readers. */
  label?: string;
  className?: string;
}) {
  return (
    <section
      aria-label={label}
      data-redline=""
      className={`space-y-3 rounded-xl border border-border bg-card px-4 py-4 leading-relaxed text-secondary-text [overflow-wrap:anywhere] sm:px-5 ${className}`.trim()}
    >
      {items.length === 0 ? (
        <p data-redline-empty="">No words have changed.</p>
      ) : (
        items.map((item, i) =>
          item.type === 'fold' ? (
            <p
              key={i}
              data-redline-fold=""
              className="text-center text-sm text-muted-foreground"
            >
              {foldLabel(item)}
            </p>
          ) : (
            <p
              key={i}
              className={
                item.heading ? 'font-semibold text-foreground' : undefined
              }
            >
              <Segments segments={item.segments} />
            </p>
          ),
        )
      )}
    </section>
  );
}

function Segments({ segments }: { segments: Segment[] }) {
  return segments.map((s, i) => {
    // Removed words straight before added ones: a space between the two marks.
    const gap =
      s.kind === 'removed' && segments[i + 1]?.kind === 'added' ? ' ' : '';
    if (s.kind === 'same') return <Fragment key={i}>{s.text}</Fragment>;
    return (
      <Fragment key={i}>
        {s.kind === 'added' ? (
          <ins className="rounded-sm bg-success/10 text-foreground underline decoration-success decoration-2 underline-offset-[3px]">
            <span className="sr-only">[added: </span>
            {s.text}
            <span className="sr-only">]</span>
          </ins>
        ) : (
          <del className="rounded-sm bg-destructive/10 line-through decoration-destructive decoration-2">
            <span className="sr-only">[removed: </span>
            {s.text}
            <span className="sr-only">]</span>
          </del>
        )}
        {gap}
      </Fragment>
    );
  });
}

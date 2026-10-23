import Link from 'next/link';
import type { StoryTag } from '@/lib/browse';
import { type BrowseFilters, browseHref, toggleTag } from '@/lib/browse-query';

// The tags from GET /v1/tags: only tags some published story uses (D63).
// Each is a link that adds or removes it (a story must have all selected tags); "All" clears
// them. Theme tags come first; the faith-journey and feelings tags sit behind "More tags".

const chip =
  'inline-flex min-h-11 items-center rounded-full border px-4 text-sm transition-colors';
export const TAG_CHIP = `${chip} border-border bg-surface text-secondary-text hover:border-teal hover:text-foreground`;
const selected = `${chip} border-teal bg-accent font-medium text-foreground hover:text-foreground`;

function TagLink({ tag, filters }: { tag: StoryTag; filters: BrowseFilters }) {
  const on = filters.tags.includes(tag.slug);
  return (
    <li>
      <Link
        href={browseHref(toggleTag(filters, tag.slug))}
        className={on ? selected : TAG_CHIP}
        scroll={false}
      >
        {on && (
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="mr-1.5 size-4 fill-none stroke-teal"
            strokeWidth="2.5"
          >
            <path d="M5 12l5 5L19 7" />
          </svg>
        )}
        {tag.name}
        {on && <span className="sr-only"> (selected)</span>}
      </Link>
    </li>
  );
}

export function TagFilter({
  tags,
  filters,
}: {
  tags: StoryTag[];
  filters: BrowseFilters;
}) {
  if (tags.length === 0) return null;
  const themes = tags.filter((t) => t.category === 'theme');
  const others = [
    {
      label: 'Faith journey',
      tags: tags.filter((t) => t.category === 'journey'),
    },
    { label: 'Feelings', tags: tags.filter((t) => t.category === 'emotion') },
  ].filter((g) => g.tags.length > 0);
  const otherSelected = others.some((g) =>
    g.tags.some((t) => filters.tags.includes(t.slug)),
  );
  return (
    <div className="mt-5">
      <ul className="flex flex-wrap gap-2" aria-label="Themes">
        <li>
          <Link
            href={browseHref({ ...filters, tags: [] })}
            className={filters.tags.length === 0 ? selected : TAG_CHIP}
            scroll={false}
          >
            All
          </Link>
        </li>
        {themes.map((t) => (
          <TagLink key={t.slug} tag={t} filters={filters} />
        ))}
      </ul>
      {others.length > 0 && (
        <details open={otherSelected} className="group mt-2">
          <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md text-sm font-medium text-link hover:text-link-hover">
            More tags
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 fill-none stroke-current transition-transform group-open:rotate-180 motion-reduce:transition-none"
              strokeWidth="2"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </summary>
          {others.map((g) => (
            <div key={g.label} className="mt-2">
              <h2 className="mb-2 text-sm text-muted-foreground">{g.label}</h2>
              <ul className="flex flex-wrap gap-2">
                {g.tags.map((t) => (
                  <TagLink key={t.slug} tag={t} filters={filters} />
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

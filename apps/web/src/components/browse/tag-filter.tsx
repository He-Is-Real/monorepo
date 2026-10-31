'use client';

import Link from 'next/link';
import { MoreThemes } from '@/components/themes/more-themes';
import type { StoryTag } from '@/lib/browse';
import { type BrowseFilters, browseHref, toggleTag } from '@/lib/browse-query';
import { splitThemes } from '@/lib/main-themes';

// The tags from GET /v1/tags: only tags some published story uses (D63).
// Each is a link that adds or removes it (a story must have all selected tags); "All" clears
// them. The main themes an admin picked come first, in their order (O5); every other theme sits
// behind "More themes", with a search. A chosen one of those also shows in the first row, so the
// filters in force stay visible while "More themes" is closed.

const chip =
  'inline-flex min-h-11 items-center rounded-full border px-4 text-sm transition-colors';
export const TAG_CHIP = `${chip} border-border bg-surface text-secondary-text hover:border-teal hover:text-foreground`;
const selected = `${chip} border-teal bg-accent font-medium text-foreground hover:text-foreground`;

function TagLink({ tag, filters }: { tag: StoryTag; filters: BrowseFilters }) {
  const on = filters.tags.includes(tag.id);
  return (
    <li>
      <Link
        href={browseHref(toggleTag(filters, tag.id))}
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
  main,
  filters,
}: {
  tags: StoryTag[];
  main: string[];
  filters: BrowseFilters;
}) {
  if (tags.length === 0) return null;
  const { main: first, more } = splitThemes(tags, main);
  const chosen = more.filter((t) => filters.tags.includes(t.id));
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
        {[...first, ...chosen].map((t) => (
          <TagLink key={t.id} tag={t} filters={filters} />
        ))}
      </ul>
      <MoreThemes
        themes={more}
        renderTheme={(t) => <TagLink tag={t} filters={filters} />}
      />
    </div>
  );
}

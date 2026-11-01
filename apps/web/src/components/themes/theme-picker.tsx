'use client';

import { type ReactNode, useId, useState } from 'react';
import type { Theme, ThemeCategory } from '@/lib/browse';

/**
 * The one theme picker, for sharing a story and for browsing (themes plan v3, mockups 2 and 3).
 * Each category's highlighted themes show first, under the category's name, with any chosen
 * theme that isn't highlighted. "More themes" opens every other theme, grouped by category, with
 * a search (plain "contains", ignoring capitals; A12) in a box that scrolls inside about 40% of
 * the screen. A category with nothing to show first only appears there.
 *
 * What a theme looks like (a checkbox when sharing, a link when browsing) is the caller's: the
 * picker only decides where each one goes. A theme chosen inside "More themes" stays where it
 * is until the box closes, so it doesn't jump away from the pointer or the keyboard focus.
 */
export function ThemePicker({
  categories,
  chosen,
  renderTheme,
}: {
  categories: ThemeCategory[];
  chosen: readonly string[];
  renderTheme: (theme: Theme) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // The chosen themes shown first: fixed while the box is open.
  const [pinned, setPinned] = useState<readonly string[]>(chosen);
  const first = (t: Theme) => t.highlighted || pinned.includes(t.id);
  const needle = search.trim().toLowerCase();

  const top = categories
    .map((c) => ({ ...c, themes: c.themes.filter(first) }))
    .filter((c) => c.themes.length > 0);
  const rest = categories
    .map((c) => ({
      ...c,
      themes: c.themes.filter(
        (t) => !first(t) && t.name.toLowerCase().includes(needle),
      ),
    }))
    .filter((c) => c.themes.length > 0);
  const hasRest = categories.some((c) => c.themes.some((t) => !first(t)));

  const toggle = () => {
    if (open) {
      setPinned(chosen);
      setSearch('');
    }
    setOpen(!open);
  };

  return (
    <div>
      {top.map((c) => (
        <Group key={c.id} category={c} renderTheme={renderTheme} />
      ))}
      {hasRest && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-more`}
          onClick={toggle}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-link hover:text-link-hover"
        >
          {open ? 'Fewer themes' : 'More themes'}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`size-4 fill-none stroke-current transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}
      {open && (
        <div id={`${id}-more`} className="mt-2">
          <label htmlFor={`${id}-search`} className="sr-only">
            Search themes
          </label>
          <input
            id={`${id}-search`}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search themes"
            autoComplete="off"
            className="h-11 w-full rounded-lg border border-input bg-input-background px-4 text-sm text-foreground outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:max-w-sm"
          />
          <div
            className="mt-3 max-h-[40vh] overflow-y-auto overscroll-contain rounded-lg border border-border p-3"
            tabIndex={-1}
          >
            {rest.length === 0 ? (
              <p role="status" className="text-sm text-muted-foreground">
                No themes match “{search.trim()}”.
              </p>
            ) : (
              rest.map((c) => (
                <Group key={c.id} category={c} renderTheme={renderTheme} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  category,
  renderTheme,
}: {
  category: ThemeCategory;
  renderTheme: (theme: Theme) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="mb-3">
      <h3 id={id} className="mb-2 text-sm text-muted-foreground">
        {category.name}
      </h3>
      <ul aria-labelledby={id} className="flex flex-wrap gap-2">
        {category.themes.map((t) => (
          <li key={t.id}>{renderTheme(t)}</li>
        ))}
      </ul>
    </div>
  );
}

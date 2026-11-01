'use client';

import { type ReactNode, useId, useState } from 'react';
import type { Theme, ThemeCategory } from '@/lib/browse';

/**
 * The one theme picker, for sharing a story and for browsing (themes plan v3, mockups 2 and 3).
 * Each category's name shows once, over one row of its themes. Folded, a row holds only the
 * category's highlighted themes and any chosen one; a category with neither isn't shown.
 * "More themes" unfolds every row in place (and shows the hidden categories in their usual
 * order), with a search beside it (plain "contains", ignoring capitals; A12) that narrows the
 * same rows. Chosen themes always stay in view, whatever the search says.
 *
 * What a theme looks like (a checkbox when sharing, a link when browsing) is the caller's: the
 * picker only decides which ones show. A theme un-chosen while unfolded or searching stays put
 * until the picker folds or unfolds again, so it doesn't vanish from under the pointer or the
 * keyboard focus.
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
  // The chosen themes as the picker last folded or unfolded: kept in view until it does again.
  const [pinned, setPinned] = useState<readonly string[]>(chosen);
  const kept = (t: Theme) => pinned.includes(t.id) || chosen.includes(t.id);
  const needle = open ? search.trim().toLowerCase() : '';
  const shown = (t: Theme) =>
    kept(t) || (open ? t.name.toLowerCase().includes(needle) : t.highlighted);

  const rows = categories
    .map((c) => ({ ...c, themes: c.themes.filter(shown) }))
    .filter((c) => c.themes.length > 0);
  const hasMore = categories.some((c) =>
    c.themes.some((t) => !t.highlighted && !kept(t)),
  );

  const toggle = () => {
    setPinned(chosen);
    setSearch('');
    setOpen(!open);
  };

  return (
    <div>
      <div id={`${id}-themes`}>
        {rows.map((c) => (
          <Group key={c.id} category={c} renderTheme={renderTheme} />
        ))}
        {open &&
          needle &&
          !rows.some((c) => c.themes.some((t) => !kept(t))) && (
            <p role="status" className="mb-3 text-sm text-muted-foreground">
              No themes match “{search.trim()}”.
            </p>
          )}
      </div>
      {(hasMore || open) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-themes`}
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
          {open && (
            <>
              <label htmlFor={`${id}-search`} className="sr-only">
                Search themes
              </label>
              <input
                id={`${id}-search`}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-controls={`${id}-themes`}
                placeholder="Search themes"
                autoComplete="off"
                className="h-11 w-full min-w-0 rounded-lg border border-input bg-input-background px-4 text-sm text-foreground outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:max-w-sm sm:flex-1"
              />
            </>
          )}
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

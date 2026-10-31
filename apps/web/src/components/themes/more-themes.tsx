'use client';

import { Fragment, type ReactNode, useId, useState } from 'react';
import { searchThemes } from '@/lib/main-themes';

/**
 * "More themes" (O5, Joel 2026-10-31): the themes that aren't main ones, behind a toggle that is
 * closed until the person opens it. Open, it's compact on a phone: a search box at its top, then
 * the themes in a list of limited height that scrolls on its own, so the toggle (now "Fewer
 * themes") stays just above it and the rest of the page stays close. Chosen themes are shown
 * outside it by the caller, so they stay visible while it's closed.
 *
 * A native <details>, so it opens from the keyboard and without JavaScript too (the search then
 * does nothing, and every theme is listed). Each theme is drawn by `renderTheme`, as an <li>.
 */
export function MoreThemes<T extends { id: string; name: string }>({
  themes,
  renderTheme,
  onToggle,
}: {
  themes: T[];
  renderTheme: (theme: T) => ReactNode;
  /** Told when it opens or closes. */
  onToggle?: (open: boolean) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  if (themes.length === 0) return null;
  const shown = searchThemes(themes, search);
  return (
    <details
      className="group mt-2"
      data-more-themes=""
      onToggle={(e) => onToggle?.(e.currentTarget.open)}
    >
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-link hover:text-link-hover [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">More themes</span>
        <span className="hidden group-open:inline">Fewer themes</span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4 fill-none stroke-current transition-transform group-open:rotate-180 motion-reduce:transition-none"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div className="mt-1 rounded-xl border border-border bg-card p-3">
        <label
          htmlFor={`${id}-search`}
          className="mb-1 block text-sm font-medium text-foreground"
        >
          Search themes
        </label>
        <input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-controls={`${id}-list`}
          className="h-11 w-full rounded-lg border border-input bg-input-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
        />
        <p className="sr-only" aria-live="polite">
          {search.trim()
            ? `${shown.length} ${shown.length === 1 ? 'theme' : 'themes'}`
            : ''}
        </p>
        <div
          className="mt-3 max-h-[min(40dvh,18rem)] overflow-y-auto overscroll-contain"
          data-more-themes-list=""
        >
          {shown.length > 0 ? (
            <ul id={`${id}-list`} className="flex flex-wrap gap-2 p-1">
              {shown.map((t) => (
                <Fragment key={t.id}>{renderTheme(t)}</Fragment>
              ))}
            </ul>
          ) : (
            <p id={`${id}-list`} className="p-1 text-sm text-secondary-text">
              No themes match “{search.trim()}”.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

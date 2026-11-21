'use client';

import Link from 'next/link';
import { type MouseEvent, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ThemePicker } from '@/components/themes/theme-picker';
import { THEMES_MAX } from '@heisreal/story-filters';
import { Chip, ChipTick } from '@heisreal/web-ui';
import type { ThemeCategory } from '@/lib/browse';
import {
  type BrowseFilters,
  browseHref,
  favouritesOn,
  toggleTheme,
} from '@/lib/browse-query';

/**
 * Browse by theme (themes plan v3, mockup 3; BS-6 B, Joel 2026-11-21): the shared picker, each
 * theme a link that turns it on or off (`?theme=` once per chosen theme); only stories with every
 * chosen theme show. With "Favourites only" on, it filters the favourites.
 */
export function ThemeFilter({
  categories,
  filters,
  className,
}: {
  categories: ThemeCategory[];
  filters: BrowseFilters;
  className?: string;
}) {
  // "Favourites only" stays on: its list is filtered by theme too.
  const favourites = favouritesOn(useSearchParams());
  return (
    <ThemeLinks
      categories={categories}
      chosen={filters.themes}
      hrefOf={(id) => browseHref(toggleTheme(filters, id), { favourites })}
      clearHref={browseHref({ ...filters, themes: [] }, { favourites })}
      className={className}
    />
  );
}

/** The note shown when an 11th theme is tried (Joel 2026-11-21). */
export const THEME_LIMIT_NOTE = `You can choose up to ${THEMES_MAX} themes.`;

/**
 * Themes to filter a list by, as links in the shared picker: browse's, and the moderators'
 * list's, which filters exactly as browse does (revised OQ-2, Joel 2026-11-19; BS-7, Joel
 * 2026-11-21). Each theme turns on and off on its own and shows ✓ when chosen; a "Clear themes"
 * link appears once any is chosen. `hrefOf` gives each theme's link (a chosen one's takes it
 * off), `clearHref` the list without themes. `onChoose` and `onClear`, if given, take a plain
 * click instead of the link (the moderators' list keeps choices made before the page catches
 * up); a click with a modifier key still opens the link.
 *
 * At most THEMES_MAX themes (Joel 2026-11-21: "yes display a theme limit note"): with that many
 * chosen, another stays unchosen and a short note says so, read out politely by screen readers;
 * it goes once a theme is taken off.
 */
export function ThemeLinks({
  categories,
  chosen,
  hrefOf,
  clearHref,
  onChoose,
  onClear,
  className = 'mt-5',
}: {
  categories: ThemeCategory[];
  chosen: readonly string[];
  hrefOf: (themeId: string) => string;
  clearHref: string;
  onChoose?: (themeId: string) => void;
  onClear?: () => void;
  /** Layout classes for the list (its margin). */
  className?: string;
}) {
  const full = chosen.length >= THEMES_MAX;
  const [triedMore, setTriedMore] = useState(false);
  // Below the limit again (a theme taken off, Clear themes, Back): the note goes.
  if (triedMore && !full) setTriedMore(false);
  if (categories.length === 0) return null;
  /** A plain click, handled here instead of following the link. */
  const plain = (handle: (() => void) | undefined) =>
    handle &&
    ((e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      e.preventDefault();
      handle();
    });
  return (
    <nav aria-label="Themes" className={className}>
      <ThemePicker
        categories={categories}
        chosen={chosen}
        renderTheme={(t) => {
          const on = chosen.includes(t.id);
          return (
            <Chip asChild chosen={on}>
              <Link
                href={hrefOf(t.id)}
                aria-current={on ? 'true' : undefined}
                scroll={false}
                onClick={plain(
                  !on && full
                    ? () => setTriedMore(true)
                    : onChoose && (() => onChoose(t.id)),
                )}
              >
                {on && <ChipTick />}
                {t.name}
              </Link>
            </Chip>
          );
        }}
      />
      {/* Always in the page, so screen readers announce the note when it appears. */}
      <p
        role="status"
        className="mt-2 text-sm text-secondary-text empty:hidden"
        data-theme-limit=""
      >
        {triedMore && full ? THEME_LIMIT_NOTE : ''}
      </p>
      {chosen.length > 0 && (
        <Link
          href={clearHref}
          scroll={false}
          onClick={plain(onClear)}
          className="mt-2 inline-flex min-h-11 items-center text-sm font-medium"
          data-clear-themes=""
        >
          Clear themes
        </Link>
      )}
    </nav>
  );
}

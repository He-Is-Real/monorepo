'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ThemePicker } from '@/components/themes/theme-picker';
import { THEME_CHIP, THEME_CHIP_ON } from '@/components/themes/theme-chip';
import type { ThemeCategory } from '@/lib/browse';
import {
  type BrowseFilters,
  browseHref,
  favouritesOn,
  toggleTheme,
} from '@/lib/browse-query';

/**
 * Browse by theme (themes plan v3, mockup 3): the shared picker, each theme a link that shows
 * only stories with it (`?theme=`); the chosen one, pressed again, shows every story. With
 * "Favourites only" on, it filters the favourites.
 */
export function ThemeFilter({
  categories,
  filters,
}: {
  categories: ThemeCategory[];
  filters: BrowseFilters;
}) {
  // "Favourites only" stays on: its list is filtered by theme too.
  const favourites = favouritesOn(useSearchParams());
  return (
    <ThemeLinks
      categories={categories}
      chosen={filters.theme}
      hrefOf={(id) => browseHref(toggleTheme(filters, id), { favourites })}
    />
  );
}

/**
 * One theme to filter a list by, as links in the shared picker: browse's, and the moderators'
 * list's, which filters exactly as browse does (revised OQ-2, Joel 2026-11-19). `hrefOf` gives
 * each theme's link (the chosen one's clears it). `onChoose`, if given, takes a plain click
 * instead of the link (the moderators' list keeps choices made before the page catches up); a
 * click with a modifier key still opens the link.
 */
export function ThemeLinks({
  categories,
  chosen,
  hrefOf,
  onChoose,
}: {
  categories: ThemeCategory[];
  chosen: string | null | undefined;
  hrefOf: (themeId: string) => string;
  onChoose?: (themeId: string) => void;
}) {
  if (categories.length === 0) return null;
  return (
    <nav aria-label="Themes" className="mt-5">
      <ThemePicker
        // A new chosen theme (a link, Back) starts the picker again.
        key={chosen ?? ''}
        categories={categories}
        chosen={chosen ? [chosen] : []}
        renderTheme={(t) => {
          const on = chosen === t.id;
          return (
            <Link
              href={hrefOf(t.id)}
              className={on ? THEME_CHIP_ON : THEME_CHIP}
              aria-current={on ? 'true' : undefined}
              scroll={false}
              onClick={
                onChoose &&
                ((e) => {
                  if (
                    e.button !== 0 ||
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey
                  )
                    return;
                  e.preventDefault();
                  onChoose(t.id);
                })
              }
            >
              {on && (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="mr-1.5 size-4 fill-none stroke-brand"
                  strokeWidth="2.5"
                >
                  <path d="M5 12l5 5L19 7" />
                </svg>
              )}
              {t.name}
            </Link>
          );
        }}
      />
    </nav>
  );
}

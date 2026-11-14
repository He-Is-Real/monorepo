'use client';

import Link from 'next/link';
import { ThemePicker } from '@/components/themes/theme-picker';
import { THEME_CHIP, THEME_CHIP_ON } from '@/components/themes/theme-chip';
import type { ThemeCategory } from '@/lib/browse';
import {
  type BrowseFilters,
  browseHref,
  toggleTheme,
} from '@/lib/browse-query';

/**
 * Browse by theme (themes plan v3, mockup 3): the shared picker, each theme a link that shows
 * only stories with it (`?theme=`); the chosen one, pressed again, shows every story.
 */
export function ThemeFilter({
  categories,
  filters,
}: {
  categories: ThemeCategory[];
  filters: BrowseFilters;
}) {
  return (
    <ThemeLinks
      categories={categories}
      chosen={filters.theme}
      hrefOf={(id) => browseHref(toggleTheme(filters, id))}
    />
  );
}

/**
 * One theme to filter a list by, as links in the shared picker: browse's, and the moderators'
 * list's (MD-4: "allow filtering by tags"). `hrefOf` gives each theme's link (the chosen one's
 * clears it).
 */
export function ThemeLinks({
  categories,
  chosen,
  hrefOf,
}: {
  categories: ThemeCategory[];
  chosen: string | null | undefined;
  hrefOf: (themeId: string) => string;
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
              {t.name}
            </Link>
          );
        }}
      />
    </nav>
  );
}

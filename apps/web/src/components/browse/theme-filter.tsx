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
  if (categories.length === 0) return null;
  return (
    <nav aria-label="Themes" className="mt-5">
      <ThemePicker
        // A new chosen theme (a link, Back) starts the picker again.
        key={filters.theme ?? ''}
        categories={categories}
        chosen={filters.theme ? [filters.theme] : []}
        renderTheme={(t) => {
          const on = filters.theme === t.id;
          return (
            <Link
              href={browseHref(toggleTheme(filters, t.id))}
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

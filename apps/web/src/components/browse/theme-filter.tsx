'use client';

import Link from 'next/link';
import { type MouseEvent, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePendingThemes } from '@/components/browse/browse-filters';
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
 *
 * Choices made but not yet in the address count, as on the moderators' list (Codex, #259): two
 * themes pressed quickly both stay on, each navigation building on the one before rather than on
 * the address it hasn't reached yet (BrowseChoices keeps them, and lets the address win again
 * once it catches up, or on Back and Forward). A click with a modifier key still just opens the link.
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
  const router = useRouter();
  // Kept by BrowseChoices, so they survive the panel closing and opening (which remounts this).
  const [pending, setPending] = usePendingThemes();
  const here = browseHref(filters, { favourites });
  const view = { ...filters, themes: pending?.themes ?? filters.themes };
  const go = (themes: string[]) => {
    const href = browseHref({ ...filters, themes }, { favourites });
    setPending({ themes, path: [...(pending?.path ?? [here]), href] });
    router.push(href, { scroll: false });
  };
  return (
    <ThemeLinks
      categories={categories}
      chosen={view.themes}
      hrefOf={(id) => browseHref(toggleTheme(view, id), { favourites })}
      onChoose={(id) => go(toggleTheme(view, id).themes)}
      clearHref={browseHref({ ...filters, themes: [] }, { favourites })}
      onClear={() => go([])}
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
      {/* Always in the page and the accessibility tree (never display: none), so screen readers
          announce the note when its words appear; the spacing only comes with them. */}
      <p
        role="status"
        className="text-sm text-secondary-text"
        data-theme-limit=""
      >
        {triedMore && full && (
          <span className="mt-2 block">{THEME_LIMIT_NOTE}</span>
        )}
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

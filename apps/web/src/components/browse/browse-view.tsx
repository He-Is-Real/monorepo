'use client';

import { useSearchParams } from 'next/navigation';
import { FavouritesList } from '@/components/favourites/favourites-list';
import { FAVOURITES_PARAM } from '@/lib/browse-query';
import { usePersonalSession } from '@/lib/personal-session';

/**
 * Browse with "Favourites only" (Joel, 2026-11-14; it replaces the My favourites page). Signed
 * in, a switch above the filters shows the person's hearted stories in place of browse's list,
 * newest heart first, in the same masonry. Signed out (or until the browser knows, or without
 * JavaScript) there is no switch and browse is as it always was.
 *
 * The switch is kept in the URL (`?favourites=1`), so Back from a story and reloads keep it.
 * web's server renders the same page whatever it says (D32: nothing personal on the server); the
 * browser alone reads it. Favourites can't be searched or filtered (the favourites API has no
 * filters), so while the switch is on the search, sort, format and theme filters are hidden;
 * turning it off brings back browse with the URL's filters.
 */
export function BrowseView({
  filters,
  summary,
  results,
}: {
  /** The search, sort, format and theme filters. */
  filters: React.ReactNode;
  /** What the list shows, in words, when filtered. */
  summary: React.ReactNode;
  /**
   * Browse's list. Gone while favourites show; back, it reloads the pages the URL says were
   * loaded (`?pages=`, as after Back).
   */
  results: React.ReactNode;
}) {
  const session = usePersonalSession();
  const params = useSearchParams();
  const signedIn = session.status === 'signed-in';
  const on = signedIn && params.get(FAVOURITES_PARAM) === '1';

  const set = (next: boolean) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set(FAVOURITES_PARAM, '1');
    else url.searchParams.delete(FAVOURITES_PARAM);
    // Next keeps its router (and useSearchParams) in step with the History API.
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  return (
    <>
      <div className="border-b border-border pb-6">
        {signedIn && (
          // A switch with its words: the whole row is the target (44 px high).
          <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => set(!on)}
            data-favourites-only=""
            className={`group inline-flex min-h-11 items-center gap-3 rounded-lg pr-2 font-medium text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${on ? '' : 'mb-3'}`}
          >
            <span
              aria-hidden="true"
              className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-hover bg-input-background transition-colors group-aria-checked:border-teal group-aria-checked:bg-teal motion-reduce:transition-none"
            >
              <span className="ml-0.5 size-5 rounded-full bg-secondary-text shadow transition-transform group-aria-checked:translate-x-5 group-aria-checked:bg-white motion-reduce:transition-none" />
            </span>
            Favourites only
          </button>
        )}
        {!on && filters}
      </div>

      {!on && summary}

      <div className="mt-8">
        {on && <FavouritesList onShowAll={() => set(false)} />}
        {!on && results}
      </div>
    </>
  );
}

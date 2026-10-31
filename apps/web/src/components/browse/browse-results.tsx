'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadMoreStories } from '@/app/stories/actions';
import {
  continueLayout,
  StoryMasonry,
} from '@/components/stories/story-masonry';
import { useNearEnd } from '@/components/stories/use-near-end';
import { Button } from '@/components/ui/button';
import type { StorySummary } from '@/lib/browse';
import {
  type BrowseFilters,
  browseHref,
  parseBrowseSearch,
} from '@/lib/browse-query';
import { type CardLayout, type ColumnHeights, layoutFor } from '@/lib/masonry';

interface Loaded {
  cards: StorySummary[];
  layouts: CardLayout[];
  heights: ColumnHeights;
  cursor: string | null;
  pages: number;
}

/**
 * Browse's cards in a balanced masonry, and loading more (D55). The cards the server rendered
 * come with the layout for every column count; this island then measures the real cards and
 * loads further pages through a server action (web's server calls the API, D32). The next page
 * loads on its own whenever the reader nears the end, to the end of the list (Joel, 2026-10-31:
 * no page cap; `useNearEnd`). The number of pages is kept in the URL, so Back and reloads show
 * the same list.
 *
 * Every server render is the truth (D51: stories are read fresh): `snapshot` is new each time
 * the server renders the page, and the list starts again from that render's cards, so a story
 * hidden or withdrawn since the last render never stays on screen. It then reloads up to the
 * URL's page count, from the API.
 */
export function BrowseResults(props: ListProps & { snapshot: string }) {
  const { snapshot, ...list } = props;
  return <BrowseList key={snapshot} {...list} />;
}

interface ListProps {
  filters: BrowseFilters;
  cards: StorySummary[];
  nextCursor: string | null;
  pagesLoaded: number;
}

function BrowseList({ filters, cards, nextCursor, pagesLoaded }: ListProps) {
  const [loaded, setLoaded] = useState<Loaded>(() => {
    const layout = layoutFor(cards);
    return {
      cards,
      layouts: layout.cards,
      heights: layout.heights,
      cursor: nextCursor,
      pages: pagesLoaded,
    };
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [announcement, setAnnouncement] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const busy = useRef(false);
  const current = useRef(loaded);
  current.current = loaded;
  const focusFrom = useRef<number | null>(null);
  // False once this list is gone (a new render, other filters): a load still in flight then
  // changes nothing, not even the URL.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (byButton: boolean) => {
      const { cursor } = current.current;
      if (busy.current || !cursor) return false;
      busy.current = true;
      setStatus('loading');
      let result: Awaited<ReturnType<typeof loadMoreStories>>;
      try {
        result = await loadMoreStories(filters, cursor);
      } catch {
        result = { ok: false }; // the request itself failed (offline, server unreachable)
      } finally {
        busy.current = false;
      }
      if (!alive.current) return false;
      if (!result.ok) {
        setStatus('error');
        return false;
      }
      const prev = current.current;
      const next = continueLayout(
        list.current,
        prev.layouts,
        prev.heights,
        result.page.data,
      );
      const pages = prev.pages + 1;
      focusFrom.current = byButton ? prev.cards.length : null;
      // The ref first, so a load straight after this one continues from here.
      current.current = {
        cards: [...prev.cards, ...result.page.data],
        layouts: [...prev.layouts, ...next.cards],
        heights: next.heights,
        cursor: result.page.nextCursor,
        pages,
      };
      setLoaded(current.current);
      setStatus('idle');
      // That more loaded, never how many (D62: no story counts anywhere).
      setAnnouncement('More stories loaded.');
      window.history.replaceState(null, '', browseHref(filters, { pages }));
      return true;
    },
    [filters],
  );

  // Back can restore an older render of this page from Next's router cache (the first page
  // only) under a URL that says more pages were loaded: load the missing ones.
  useEffect(() => {
    const wanted = parseBrowseSearch({
      pages:
        new URLSearchParams(window.location.search).get('pages') ?? undefined,
    }).pages;
    let cancelled = false;
    void (async () => {
      while (
        !cancelled &&
        current.current.pages < wanted &&
        current.current.cursor &&
        (await load(false))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Near the end: load the next page. An observer only acts for the list it was made for: once
  // a load has moved on (the ref), its sightings are of the shorter list still on screen, e.g.
  // Back's scroll restoring to the end of the first page while that page's second one is
  // arriving (#119).
  const pages = loaded.pages;
  const { sentinel, auto } = useNearEnd({
    active: !!loaded.cursor && status === 'idle',
    round: pages,
    onNear: () => {
      if (current.current.pages === pages) void load(false);
    },
  });

  // After Try again or "Show more stories", keyboard users carry on from the first new card.
  // Loads on their own never move focus.
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null) return;
    focusFrom.current = null;
    list.current?.children[from]?.querySelector('a')?.focus();
  }, [loaded.cards]);

  return (
    <>
      <StoryMasonry
        cards={loaded.cards}
        layouts={loaded.layouts}
        listRef={list}
      />
      <div ref={sentinel} aria-hidden="true" />
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="mt-12 flex flex-col items-center gap-3 text-center">
        {status === 'loading' && (
          <p className="text-sm text-muted-foreground">Loading more stories…</p>
        )}
        {status === 'error' && (
          <>
            <p role="alert" className="text-secondary-text">
              More stories couldn’t load.
            </p>
            <Button
              variant="outline"
              className="min-h-11 px-6"
              onClick={() => void load(true)}
            >
              Try again
            </Button>
          </>
        )}
        {status === 'idle' && loaded.cursor && !auto && (
          // Only where the browser can't tell when the end is near (no IntersectionObserver).
          <Button
            variant="outline"
            className="min-h-11 px-6"
            onClick={() => void load(true)}
          >
            Show more stories
          </Button>
        )}
        {loaded.cursor && (
          // Without JavaScript nothing loads on its own and the button can't work: a link makes
          // the server render one page more, however many pages are on screen.
          <noscript>
            <a
              href={browseHref(filters, { pages: loaded.pages + 1 })}
              className="inline-flex min-h-11 items-center rounded-md border px-6 text-sm font-medium"
            >
              Show more stories
            </a>
          </noscript>
        )}
        {!loaded.cursor && (
          <p className="text-secondary-text">You’ve seen every story here.</p>
        )}
      </div>
    </>
  );
}

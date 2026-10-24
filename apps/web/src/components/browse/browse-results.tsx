'use client';

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { loadMoreStories } from '@/app/stories/actions';
import { StoryCard } from '@/components/stories/story-card';
import { Button } from '@/components/ui/button';
import type { StorySummary } from '@/lib/browse';
import {
  autoLoadsLeft,
  type BrowseFilters,
  browseHref,
  parseBrowseSearch,
} from '@/lib/browse-query';
import {
  type CardLayout,
  type ColumnHeights,
  GAP,
  layoutFor,
  spanFor,
} from '@/lib/masonry';

/** How far before the end of the list the next page starts loading (D55: "near the end"). */
const NEAR_END = '0px 0px 800px 0px';

interface Loaded {
  cards: StorySummary[];
  layouts: CardLayout[];
  heights: ColumnHeights;
  cursor: string | null;
  pages: number;
}

/** The column count the stylesheet is using now (`.masonry` in global.css). */
function currentColumns(): 1 | 2 | 3 {
  if (window.matchMedia('(min-width: 1024px)').matches) return 3;
  if (window.matchMedia('(min-width: 640px)').matches) return 2;
  return 1;
}

/**
 * Browse's cards in a balanced masonry, and loading more (D55). The cards the server rendered
 * come with the layout for every column count; this island then measures the real cards and
 * loads further pages through a server action (web's server calls the API, D32). At most 2
 * pages load on their own as the reader nears the end; then "Show more stories". The number of
 * pages is kept in the URL, so Back and reloads show the same list.
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
  const sentinel = useRef<HTMLDivElement>(null);
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

  /** Column heights to continue from: measured for the columns on screen, predicted otherwise. */
  const startHeights = useCallback((predicted: ColumnHeights) => {
    const n = currentColumns();
    const ul = list.current;
    if (n === 1 || !ul) return predicted;
    const top = ul.getBoundingClientRect().top;
    const measured = Array(n).fill(0);
    current.current.layouts.forEach((layout, i) => {
      const li = ul.children[i] as HTMLElement | undefined;
      if (!li) return;
      const bottom = li.getBoundingClientRect().bottom - top + GAP;
      const col = layout.col[n];
      measured[col] = Math.max(measured[col], bottom);
    });
    return { ...predicted, [n]: measured };
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
      const next = layoutFor(result.page.data, startHeights(prev.heights));
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
    [filters, startHeights],
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

  const autoLeft = autoLoadsLeft(loaded.pages);

  // Near the end: load the next page, while automatic loads are left.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !loaded.cursor || autoLeft === 0 || status !== 'idle') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((e) => e.isIntersecting) &&
          autoLoadsLeft(current.current.pages) > 0
        )
          void load(false);
      },
      { rootMargin: NEAR_END },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded.cursor, autoLeft, status, load]);

  // Measured heights replace the predicted spans (multi-column layouts only use them).
  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const li = (entry.target as HTMLElement).parentElement;
        li?.style.setProperty(
          '--m',
          String(spanFor(entry.target.getBoundingClientRect().height)),
        );
      }
    });
    for (const li of Array.from(ul.children))
      if (li.firstElementChild) observer.observe(li.firstElementChild);
    return () => observer.disconnect();
  }, [loaded.cards]);

  // After "Show more stories", keyboard users carry on from the first new card.
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null) return;
    focusFrom.current = null;
    list.current?.children[from]?.querySelector('a')?.focus();
  }, [loaded.cards]);

  return (
    <>
      <ul ref={list} className="masonry">
        {loaded.cards.map((story, i) => {
          const { col, span } = loaded.layouts[i];
          const style = {
            '--c2': col[2] + 1,
            '--s2': span[2],
            '--c3': col[3] + 1,
            '--s3': span[3],
          } as CSSProperties;
          return (
            <li key={story.id} style={style}>
              <StoryCard story={story} eager={i < 3} />
            </li>
          );
        })}
      </ul>
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
        {status === 'idle' && loaded.cursor && autoLeft === 0 && (
          <>
            {/* D62: no story counts anywhere, not even of what has loaded. */}
            <p className="text-secondary-text">There are more stories.</p>
            <Button
              variant="outline"
              className="min-h-11 px-6"
              onClick={() => void load(true)}
            >
              Show more stories
            </Button>
          </>
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

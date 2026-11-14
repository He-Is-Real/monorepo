'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { StoryMasonry } from '@/components/stories/story-masonry';
import { useNearEnd } from '@/components/stories/use-near-end';
import { Button } from '@/components/ui/button';
import type { ApiSummary, StorySummary } from '@/lib/browse';
import { markHearted } from '@/lib/favourites';
import { personalApiUser, usePersonalSession } from '@/lib/personal-session';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';

/** Cards per page. */
const PAGE_SIZE = 24;

type List =
  | { status: 'loading' }
  | { status: 'failed'; owner: string }
  | {
      status: 'ready';
      /** Whose list this is (Clerk's user id): shown only to them. */
      owner: string;
      cards: StorySummary[];
      cursor: string | null;
      more: 'idle' | 'loading' | 'failed';
    };

type Page = { data: StorySummary[]; nextCursor: string | null };

/**
 * Browse's "Favourites only" (Joel, 2026-11-14): the signed-in person's hearted stories, from
 * api-user in the browser (D83), in place of browse's list. Shown as browse shows stories
 * (Joel, 2026-10-31): its masonry, each card at its media's own shape, written stories without a
 * picture as text only. Newest heart first; the next page loads on its own as the reader nears
 * the end, as browse's does (Joel, 2026-10-31). A heart taken off here stays on screen, empty,
 * until the next visit, so a slip can be undone. Space is kept while it loads, so the footer doesn't jump.
 *
 * Only ever the signed-in person's own list (Codex, #117): every answer is tied to the person
 * it was asked for, and one that arrives after someone else signed in (or out) is dropped
 * before it reaches the screen or the hearts.
 */
export function FavouritesList({
  onShowAll,
}: {
  /** Back to every story (the empty list's button). */
  onShowAll: () => void;
}) {
  const session = usePersonalSession();
  const [list, setList] = useState<List>({ status: 'loading' });
  const load = useRef(0); // the current load; answers to older ones are dropped
  // The load whose next page is on its way (one at a time), or null. Tied to its load, so a
  // request for someone signed in before neither holds up nor frees the new person's list.
  const busy = useRef<number | null>(null);

  // The latest session (Clerk renews getToken); a new person, not a new getToken, means a new list.
  const current = useRef(session);
  current.current = session;
  const userId = session.status === 'signed-in' ? session.userId : null;

  /** Still the person `owner` and still load `mine`: the answer may be used. */
  const stillFor = (owner: string, mine: number) => {
    const now = current.current;
    return (
      load.current === mine &&
      now.status === 'signed-in' &&
      now.userId === owner
    );
  };

  const fetchPage = useCallback(
    async (owner: string, cursor: string | null): Promise<Page> => {
      const now = current.current;
      if (now.status !== 'signed-in' || now.userId !== owner)
        throw new Error('Not signed in as this person');
      const query = cursor
        ? `?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
        : `?limit=${PAGE_SIZE}`;
      // That person's token only (personalApiUser).
      const { data } = await personalApiUser(now).get<{
        data: ApiSummary[];
        nextCursor: string | null;
      }>(`/v1/account/favourites${query}`);
      if (!data) throw new Error('No answer');
      // No NEW badge on favourites: only web's server decides it, for finding stories (D72).
      return {
        data: data.data.map((c) => ({ ...c, isNew: false })),
        nextCursor: data.nextCursor,
      };
    },
    [],
  );

  const start = useCallback(
    (owner: string) => {
      const mine = ++load.current;
      busy.current = null;
      setList({ status: 'loading' });
      fetchPage(owner, null).then(
        (page) => {
          if (!stillFor(owner, mine)) return;
          markHearted(
            owner,
            page.data.map((s) => s.id),
          );
          setList({
            status: 'ready',
            owner,
            cards: page.data,
            cursor: page.nextCursor,
            more: 'idle',
          });
        },
        () => {
          if (stillFor(owner, mine)) setList({ status: 'failed', owner });
        },
      );
    },
    // stillFor reads refs only.
    [fetchPage],
  );

  useEffect(() => {
    if (userId) start(userId);
    else {
      load.current += 1; // signed out: drop anything still on its way
      busy.current = null;
    }
  }, [userId, start]);

  const showMore = () => {
    if (busy.current !== null || list.status !== 'ready' || !list.cursor)
      return;
    const { owner } = list;
    const mine = load.current;
    busy.current = mine;
    setList({ ...list, more: 'loading' });
    fetchPage(owner, list.cursor).then(
      (page) => {
        if (busy.current === mine) busy.current = null;
        if (!stillFor(owner, mine)) return;
        markHearted(
          owner,
          page.data.map((s) => s.id),
        );
        setList((now) =>
          now.status === 'ready' && now.owner === owner
            ? {
                ...now,
                // A heart added elsewhere meanwhile can repeat a card: show it once.
                cards: [
                  ...now.cards,
                  ...page.data.filter(
                    (s) => !now.cards.some((c) => c.id === s.id),
                  ),
                ],
                cursor: page.nextCursor,
                more: 'idle',
              }
            : now,
        );
      },
      () => {
        if (busy.current === mine) busy.current = null;
        if (stillFor(owner, mine))
          setList((now) =>
            now.status === 'ready' && now.owner === owner
              ? { ...now, more: 'failed' }
              : now,
          );
      },
    );
  };

  // Only for someone signed in (browse shows the toggle to them alone).
  if (session.status === 'signed-out') return null;

  // Someone else's list (the person changed a moment ago) is never shown: loading instead.
  if (
    session.status === 'unknown' ||
    list.status === 'loading' ||
    list.owner !== userId
  )
    return (
      <div
        data-favourites-loading=""
        aria-busy="true"
        className="min-h-[24rem]"
      >
        <p className="sr-only" role="status">
          Loading your favourites…
        </p>
      </div>
    );

  if (list.status === 'failed')
    return (
      <Notice>
        <p className="mb-5" role="alert">
          {TRY_AGAIN_LATER}
        </p>
        <Button
          variant="outline"
          className="h-11 px-5"
          onClick={() => start(list.owner)}
        >
          Try again
        </Button>
      </Notice>
    );

  if (list.cards.length === 0)
    return (
      <Notice>
        <p className="mb-5">
          You haven’t hearted any stories yet. Press the heart on a story you
          want to find again, and it will be here.
        </p>
        <Button className="h-11 px-5" onClick={onShowAll}>
          Show all stories
        </Button>
      </Notice>
    );

  return (
    <Cards
      cards={list.cards}
      hasMore={!!list.cursor}
      more={list.more}
      onMore={showMore}
    />
  );
}

/**
 * The cards, in browse's masonry, loading the next page on their own near the end as browse's
 * do (`useNearEnd`): a loading line, Try again when a page fails (nothing retries on its own),
 * an end message, and "Show more favourites" only where the browser can't tell when the end is
 * near. Screen readers hear that more loaded; focus moves only after the reader pressed a button.
 */
function Cards({
  cards,
  hasMore,
  more,
  onMore,
}: {
  cards: StorySummary[];
  hasMore: boolean;
  more: 'idle' | 'loading' | 'failed';
  onMore: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const shown = useRef(cards.length);
  const focusFrom = useRef<number | null>(null);
  const { sentinel, auto } = useNearEnd({
    active: hasMore && more === 'idle',
    round: cards.length,
    onNear: onMore,
  });

  // Emptied while a page loads, so each page's "loaded" is a change screen readers announce.
  useEffect(() => {
    if (more === 'loading') setAnnouncement('');
  }, [more]);

  useEffect(() => {
    if (cards.length <= shown.current) return;
    const from = focusFrom.current;
    shown.current = cards.length;
    focusFrom.current = null;
    setAnnouncement('More favourites loaded.');
    if (from === null) return;
    // After Try again or "Show more favourites", keyboard users carry on from the first new card.
    // The masonry lays the new cards out in its own render first: focus on the next frame.
    const frame = requestAnimationFrame(() =>
      list.current?.children[from]?.querySelector('a')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [cards]);

  const byButton = () => {
    focusFrom.current = cards.length;
    onMore();
  };

  return (
    <>
      <div data-favourites="">
        <StoryMasonry cards={cards} headingLevel={2} listRef={list} />
      </div>
      <div ref={sentinel} data-near-end="" aria-hidden="true" />
      <p role="status" data-more-loaded="" className="sr-only">
        {announcement}
      </p>
      <div className="mt-10 flex flex-col items-center gap-3 text-center">
        {more === 'loading' && (
          <p className="text-sm text-muted-foreground">
            Loading more favourites…
          </p>
        )}
        {more === 'failed' && (
          <>
            <p role="alert" className="text-secondary-text">
              {TRY_AGAIN_LATER}
            </p>
            <Button variant="outline" className="h-11 px-5" onClick={byButton}>
              Try again
            </Button>
          </>
        )}
        {more === 'idle' && hasMore && !auto && (
          // Only where the browser can't tell when the end is near (no IntersectionObserver).
          <Button variant="outline" className="h-11 px-5" onClick={byButton}>
            Show more favourites
          </Button>
        )}
        {!hasMore && (
          <p className="text-secondary-text">
            You’ve seen all your favourites.
          </p>
        )}
      </div>
    </>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[24rem] max-w-measure flex-col items-center justify-center text-center text-secondary-text">
      {children}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StoryMasonry } from '@/components/stories/story-masonry';
import { Button } from '@/components/ui/button';
import { deviceHeartCards } from '@/app/stories/actions';
import type { ApiSummary, StorySummary } from '@/lib/browse';
import { deviceHeartIds } from '@/lib/device-hearts';
import { markHearted } from '@/lib/favourites';
import { personalApiUser, usePersonalSession } from '@/lib/personal-session';
import { signInHref } from '@/lib/return-path';

/** Cards per page. */
const PAGE_SIZE = 24;
const PATH = '/account/favourites';

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
 * The person's hearted stories, from api-user in the browser (D83), shown as browse shows stories
 * (Joel, 2026-10-31): its masonry, each card at its media's own shape, written stories without a
 * picture as text only. Newest heart first; "Show more" loads the next page (no infinite scroll,
 * unlike browse's D55). A heart taken off here stays on screen, empty, until the next visit, so a
 * slip can be undone. Space is kept while it loads, so the footer doesn't jump.
 *
 * Only ever the signed-in person's own list (Codex, #117): every answer is tied to the person
 * it was asked for, and one that arrives after someone else signed in (or out) is dropped
 * before it reaches the screen or the hearts.
 */
export function FavouritesList() {
  const session = usePersonalSession();
  const [list, setList] = useState<List>({ status: 'loading' });
  const load = useRef(0); // the current load; answers to older ones are dropped

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
    else load.current += 1; // signed out: drop anything still on its way
  }, [userId, start]);

  const showMore = () => {
    if (list.status !== 'ready' || !list.cursor) return;
    const { owner } = list;
    const mine = load.current;
    setList({ ...list, more: 'loading' });
    fetchPage(owner, list.cursor).then(
      (page) => {
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
        if (stillFor(owner, mine))
          setList((now) =>
            now.status === 'ready' && now.owner === owner
              ? { ...now, more: 'failed' }
              : now,
          );
      },
    );
  };

  // Signed out: this device's hearts (Joel, 2026-10-28).
  if (session.status === 'signed-out') return <DeviceFavourites />;

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
          Your favourites couldn’t load. Try again in a moment.
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
        <Button asChild className="h-11 px-5">
          <Link href="/stories">Browse stories</Link>
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

/** The cards, in browse's masonry, and "Show more favourites" while there are more. */
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
  return (
    <>
      <div data-favourites="">
        <StoryMasonry cards={cards} headingLevel={2} />
      </div>
      {hasMore && (
        <div className="mt-10 flex flex-col items-center gap-3">
          {more === 'failed' && (
            <p role="alert" className="text-secondary-text">
              More favourites couldn’t load. Try again in a moment.
            </p>
          )}
          <Button
            variant="outline"
            className="h-11 px-5"
            onClick={onMore}
            disabled={more === 'loading'}
          >
            {more === 'loading' ? 'Loading…' : 'Show more favourites'}
          </Button>
        </div>
      )}
    </>
  );
}

type DeviceList =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready';
      cards: StorySummary[];
      /** The device's ids still to show, newest heart first. */
      rest: string[];
      more: 'idle' | 'loading' | 'failed';
    };

/**
 * Signed out: the hearts kept on this device (device-hearts.ts), newest first, as cards that
 * web's server reads from api-public-read by id (`deviceHeartCards`): anonymous, no login (D83).
 * A story no longer public is left out. Taken off here, a heart stays on screen until the next
 * visit, as when signed in.
 */
function DeviceFavourites() {
  const [list, setList] = useState<DeviceList>({ status: 'loading' });
  const load = useRef(0);

  /** The cards for the next page of ids, in the device's order. */
  const fetchCards = async (ids: string[]) => {
    const answer = await deviceHeartCards(ids);
    if (!answer.ok) throw new Error('Stories unavailable');
    const byId = new Map(answer.cards.map((c) => [c.id, c]));
    return ids.flatMap((id) => {
      const card = byId.get(id);
      return card ? [card] : [];
    });
  };

  const start = useCallback(() => {
    const mine = ++load.current;
    const ids = deviceHeartIds();
    setList({ status: 'loading' });
    fetchCards(ids.slice(0, PAGE_SIZE)).then(
      (cards) => {
        if (load.current === mine)
          setList({
            status: 'ready',
            cards,
            rest: ids.slice(PAGE_SIZE),
            more: 'idle',
          });
      },
      () => {
        if (load.current === mine) setList({ status: 'failed' });
      },
    );
  }, []);

  useEffect(() => {
    start();
    return () => {
      load.current += 1;
    };
  }, [start]);

  const showMore = () => {
    if (list.status !== 'ready' || list.rest.length === 0) return;
    const mine = load.current;
    const next = list.rest.slice(0, PAGE_SIZE);
    setList({ ...list, more: 'loading' });
    fetchCards(next).then(
      (cards) => {
        if (load.current !== mine) return;
        setList((now) =>
          now.status === 'ready'
            ? {
                ...now,
                cards: [
                  ...now.cards,
                  ...cards.filter((c) => !now.cards.some((n) => n.id === c.id)),
                ],
                rest: now.rest.slice(next.length),
                more: 'idle',
              }
            : now,
        );
      },
      () => {
        if (load.current === mine)
          setList((now) =>
            now.status === 'ready' ? { ...now, more: 'failed' } : now,
          );
      },
    );
  };

  const signIn = (
    <a
      href={signInHref(PATH)}
      className="inline-flex min-h-11 items-center px-1 font-semibold"
    >
      Sign in
    </a>
  );

  if (list.status === 'loading')
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
          Your favourites couldn’t load. Try again in a moment.
        </p>
        <Button variant="outline" className="h-11 px-5" onClick={start}>
          Try again
        </Button>
      </Notice>
    );

  if (list.cards.length === 0 && list.rest.length === 0)
    return (
      <Notice>
        <p className="mb-5">
          You haven’t hearted any stories on this device yet. Press the heart on
          a story you want to find again, and it will be here. No account
          needed.
        </p>
        <Button asChild className="h-11 px-5">
          <Link href="/stories">Browse stories</Link>
        </Button>
      </Notice>
    );

  return (
    <>
      <p
        data-device-favourites=""
        className="mx-auto mb-8 max-w-measure text-center text-secondary-text"
      >
        Saved on this device only. {signIn} to keep them in your account too.
      </p>
      <Cards
        cards={list.cards}
        hasMore={list.rest.length > 0}
        more={list.more}
        onMore={showMore}
      />
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

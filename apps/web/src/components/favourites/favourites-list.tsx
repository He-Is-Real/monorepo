'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deviceHeartCards } from '@/app/stories/actions';
import { StoryMasonry } from '@/components/stories/story-masonry';
import { Button } from '@/components/ui/button';
import { type ApiSummary, MAX_IDS, type StorySummary } from '@/lib/browse';
import { type BrowseFilters, browseHref } from '@/lib/browse-query';
import { deviceHeartIds } from '@/lib/device-hearts';
import { markHearted } from '@/lib/favourites';
import { filterFavourites } from '@/lib/favourites-filter';
import {
  type PersonalSession,
  personalApiUser,
  usePersonalSession,
} from '@/lib/personal-session';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';

/** The account's favourites per request (the API's most). */
const PAGE_SIZE = 50;
/** Whose list a signed-out list is: this browser's hearts (device-hearts.ts). */
const DEVICE = 'device';

type List =
  | { status: 'loading' }
  | { status: 'failed'; owner: string }
  | {
      status: 'ready';
      /** Whose list this is: Clerk's user id, or {@link DEVICE}. Shown only to them. */
      owner: string;
      /** Every favourite, newest heart first. */
      cards: StorySummary[];
    };

/** Whose favourites the page shows now, or null while the browser doesn't know yet. */
const ownerOf = (s: PersonalSession) =>
  s.status === 'signed-in'
    ? s.userId
    : s.status === 'signed-out'
      ? DEVICE
      : null;

/**
 * Browse's "Favourites only" (Joel, 2026-11-14), in place of browse's list, laid out as browse
 * lays out stories (its masonry, each card at its media's own shape).
 *
 * - **Signed in:** the person's hearted stories, from api-user in the browser (D83).
 * - **Signed out** (FV-1; Joel, 2026-11-14: "show the favourites when signed out, stored in the
 *   browser"): the hearts kept in this browser (device-hearts.ts), as cards web's server reads
 *   from api-public-read by id (`deviceHeartCards`): anonymous, no login. A story no longer
 *   public is left out.
 *
 * The whole list is loaded, then filtered and sorted in the browser with browse's filters (FV-2 B;
 * Joel: "I dont expect people to have more than 100… we will do optimization later";
 * lib/favourites-filter.ts). A heart taken off here stays on screen, empty, until the next visit,
 * so a slip can be undone. Space is kept while it loads, so the footer doesn't jump.
 *
 * Only ever the person's own list (Codex, #117): every answer is tied to whose list it was asked
 * for, and one that arrives after someone else signed in (or out) is dropped before it reaches
 * the screen or the hearts.
 */
export function FavouritesList({
  filters,
  onShowAll,
}: {
  /** Browse's filters, from the address. */
  filters: BrowseFilters;
  /** Back to every story (the empty list's button). */
  onShowAll: () => void;
}) {
  const session = usePersonalSession();
  const [list, setList] = useState<List>({ status: 'loading' });
  const load = useRef(0); // the current load; answers to older ones are dropped

  // The latest session (Clerk renews getToken); a new person, not a new getToken, means a new list.
  const current = useRef(session);
  current.current = session;
  const owner = ownerOf(session);

  /** Still whose list `who` is, and still load `mine`: the answer may be used. */
  const stillFor = (who: string, mine: number) =>
    load.current === mine && ownerOf(current.current) === who;

  /** The account's favourites, every page, newest heart first. */
  const accountCards = useCallback(async (who: string) => {
    const cards: StorySummary[] = [];
    let cursor: string | null = null;
    do {
      const now = current.current;
      if (now.status !== 'signed-in' || now.userId !== who)
        throw new Error('Not signed in as this person');
      const query: string = cursor
        ? `?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
        : `?limit=${PAGE_SIZE}`;
      // That person's token only (personalApiUser).
      const { data } = await personalApiUser(now).get<{
        data: ApiSummary[];
        nextCursor: string | null;
      }>(`/v1/account/favourites${query}`);
      if (!data) throw new Error('No answer');
      // A heart added meanwhile can repeat a card: show it once. No NEW badge on favourites:
      // only web's server decides it, for finding stories (D72).
      for (const c of data.data)
        if (!cards.some((s) => s.id === c.id))
          cards.push({ ...c, isNew: false });
      cursor = data.nextCursor;
    } while (cursor);
    return cards;
  }, []);

  /** This browser's hearts, newest first, as the cards of those still public. */
  const deviceCards = useCallback(async () => {
    const ids = deviceHeartIds();
    const byId = new Map<string, StorySummary>();
    for (let i = 0; i < ids.length; i += MAX_IDS) {
      const answer = await deviceHeartCards(ids.slice(i, i + MAX_IDS));
      if (!answer.ok) throw new Error('Stories unavailable');
      for (const c of answer.cards) byId.set(c.id, c);
    }
    return ids.flatMap((id) => {
      const card = byId.get(id);
      return card ? [card] : [];
    });
  }, []);

  const start = useCallback(
    (who: string) => {
      const mine = ++load.current;
      setList({ status: 'loading' });
      (who === DEVICE ? deviceCards() : accountCards(who)).then(
        (cards) => {
          if (!stillFor(who, mine)) return;
          if (who !== DEVICE)
            markHearted(
              who,
              cards.map((s) => s.id),
            );
          setList({ status: 'ready', owner: who, cards });
        },
        () => {
          if (stillFor(who, mine)) setList({ status: 'failed', owner: who });
        },
      );
    },
    // stillFor reads refs only.
    [accountCards, deviceCards],
  );

  useEffect(() => {
    if (owner) start(owner);
    else load.current += 1; // not known: drop anything still on its way
  }, [owner, start]);

  // Laid out again only when the list or the filters change (StoryMasonry lays out new cards).
  const filterKey = JSON.stringify(filters);
  const cards = list.status === 'ready' ? list.cards : null;
  const shown = useMemo(
    () =>
      cards
        ? filterFavourites(cards, JSON.parse(filterKey) as BrowseFilters)
        : [],
    [cards, filterKey],
  );

  // Someone else's list (the person changed a moment ago) is never shown: loading instead.
  if (!owner || list.status === 'loading' || list.owner !== owner)
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

  if (shown.length === 0)
    return (
      <Notice>
        <p className="mb-3 text-lg text-foreground">
          None of your favourites match these filters.
        </p>
        <Link
          href={browseHref(
            { q: '', theme: null, format: null, sort: 'latest' },
            { favourites: true },
          )}
          className="inline-flex min-h-11 items-center font-medium"
        >
          Clear filters
        </Link>
      </Notice>
    );

  return (
    <div data-favourites="">
      <StoryMasonry cards={shown} headingLevel={2} />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[24rem] max-w-measure flex-col items-center justify-center text-center text-secondary-text">
      {children}
    </div>
  );
}

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { StorySummary } from '@/lib/browse';
import { useHeart } from '@/lib/favourites';
import { usePublishPersonalSession } from '@/lib/personal-session';
import { FavouritesList } from './favourites-list';

// Codex, #117 round 1: a list (or heart lookup) asked for one person, answered after someone
// else signed in in the same tab, must never show or colour anything for the new person. This
// can't be staged in the e2e suite (its fixture person is fixed), so it runs here against the
// real list and hearts store, with api-user's answers held back and released in a chosen order.

interface Call {
  token: string | null;
  path: string;
  answer: (data: unknown) => void;
}
const mockCalls: Call[] = [];

/** A session token shaped like Clerk's: only its payload's `sub` is read in the browser. */
const jwt = (sub: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
/** The person a token is for, as the calls record it. */
const tokenFor = (who: string) => jwt(who);

jest.mock('@/lib/api-user', () => {
  const actual = jest.requireActual('@/lib/api-user');
  return {
    ...actual,
    apiUser: (_url: string, getToken: () => Promise<string | null>) => ({
      get: async (path: string) => {
        const token = await getToken();
        return new Promise((resolve) =>
          mockCalls.push({
            token,
            path,
            answer: (data) =>
              resolve({ status: 200, data, etag: null, location: null }),
          }),
        );
      },
      command: async () => ({
        status: 204,
        data: undefined,
        etag: null,
        location: null,
      }),
    }),
  };
});

const card = (id: string, title: string): StorySummary => ({
  id,
  slug: id,
  title,
  excerpt: 'A dummy story.',
  bylineName: null,
  primaryFormat: 'written',
  durationSeconds: null,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 100,
  themes: [],
  publishedAt: '2026-10-20T12:00:00Z',
});

/** The header's part: says who is signed in. */
function SignedIn({ userId }: { userId: string }) {
  usePublishPersonalSession(userId, 'https://api-user.test', async () =>
    jwt(userId),
  );
  return null;
}

/** The header's part when nobody is signed in. */
function SignedOut() {
  usePublishPersonalSession(null, undefined, async () => null);
  return null;
}

/** A heart elsewhere on the page, for a story only A hearted. */
function HeartOf({ storyId }: { storyId: string }) {
  const { state } = useHeart(storyId);
  return <p data-testid="heart">{state}</p>;
}

function Page({ userId }: { userId: string }) {
  return (
    <>
      <SignedIn userId={userId} />
      <FavouritesList />
      <HeartOf storyId="a_story" />
    </>
  );
}

/** The call for `who` whose path starts with `start`, once it has been made. */
async function callFor(who: string, start: string): Promise<Call> {
  let found: Call | undefined;
  await waitFor(() => {
    found = mockCalls.find(
      (c) => c.token === tokenFor(who) && c.path.startsWith(start),
    );
    expect(found).toBeDefined();
  });
  return found as Call;
}

const LIST = '/v1/account/favourites?limit=';
const LOOKUP = '/v1/account/favourites?storyId=';

it('an answer for the person signed in before never reaches the person signed in now', async () => {
  const { rerender } = render(<Page userId="user_a" />);
  const aList = await callFor('user_a', LIST);
  const aLookup = await callFor('user_a', LOOKUP);

  // B signs in in the same tab while A's answers are still on their way.
  rerender(<Page userId="user_b" />);
  const bList = await callFor('user_b', LIST);
  const bLookup = await callFor('user_b', LOOKUP);
  await act(async () => bLookup.answer({ data: [], nextCursor: null }));
  await waitFor(() =>
    expect(screen.getByTestId('heart').textContent).toBe('off'),
  );

  // A's answers arrive late: A hearted a_story.
  await act(async () => {
    aLookup.answer({
      data: [card('a_story', 'A’s story')],
      nextCursor: null,
    });
    aList.answer({ data: [card('a_story', 'A’s story')], nextCursor: null });
  });
  await act(async () => bList.answer({ data: [], nextCursor: null }));

  await screen.findByText(/You haven’t hearted any stories yet/);
  expect(screen.queryByText('A’s story')).toBeNull();
  expect(screen.getByTestId('heart').textContent).toBe('off');
});

// Codex, #157 round 1: A's next page still on its way when B signs in must not hold up B's
// list. The browser's observer reports once when the end comes near and stays quiet while it
// stays near, so a sighting dropped then would stall B's list for good.
it('a next page asked for the person signed in before never holds up the person signed in now', async () => {
  const observers = window as unknown as { IntersectionObserver: unknown };
  const before = observers.IntersectionObserver;
  const media = window.matchMedia;
  // jsdom has no media queries: a 1-column screen.
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  // A tall screen: every new observer finds the end in view at once, as a browser's does.
  observers.IntersectionObserver = class {
    constructor(
      private readonly report: (e: { isIntersecting: boolean }[]) => void,
    ) {}
    observe() {
      queueMicrotask(() => this.report([{ isIntersecting: true }]));
    }
    disconnect() {
      // nothing to release
    }
  };
  try {
    const page = (who: string, next: string | null) => ({
      data: [card(`${who}_1`, `${who}’s story`)],
      nextCursor: next,
    });
    // Start from nobody signed in, with none of the test before's calls.
    render(<SignedOut />).unmount();
    mockCalls.length = 0;
    const { rerender } = render(
      <>
        <SignedIn userId="user_a" />
        <FavouritesList />
      </>,
    );
    const aFirst = await callFor('user_a', LIST);
    await act(async () => aFirst.answer(page('a', 'a-next')));
    // A's next page is asked for, and held.
    const aNext = await callFor('user_a', `${LIST}24&cursor=a-next`);

    rerender(
      <>
        <SignedIn userId="user_b" />
        <FavouritesList />
      </>,
    );
    const bFirst = await callFor('user_b', LIST);
    await act(async () => bFirst.answer(page('b', 'b-next')));
    // B's end is in view: B's next page is asked for although A's is still on its way.
    const bNext = await callFor('user_b', `${LIST}24&cursor=b-next`);

    // A's arrives late and changes nothing; B's then lands.
    await act(async () => aNext.answer(page('a2', null)));
    await act(async () => bNext.answer(page('b2', null)));
    await screen.findByText('b2’s story');
    expect(screen.queryByText('a2’s story')).toBeNull();
    expect(screen.getByText('You’ve seen all your favourites.')).toBeTruthy();
  } finally {
    observers.IntersectionObserver = before;
    window.matchMedia = media;
  }
});

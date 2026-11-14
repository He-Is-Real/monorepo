import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { StorySummary } from '@/lib/browse';
import type { BrowseFilters } from '@/lib/browse-query';
import { loadMoreStories } from '@/app/stories/actions';
import { usePublishPersonalSession } from '@/lib/personal-session';
import { BrowseResults } from './browse-results';
import { BrowseView } from './browse-view';

// Codex, #223 round 1: `/stories?favourites=1` opened while Clerk is still loading shows browse
// (the switch waits for the browser to know who is signed in). If browse's next page lands first
// and rewrites the address, "Favourites only" must survive it, so the favourites show once
// sign-in resolves. Clerk's timing can't be held in the e2e suite (its fixture person is
// published at once), so it is staged here with the real view, list and session store.

jest.mock('@/app/stories/actions', () => ({
  loadMoreStories: jest.fn(),
  deviceHeartCards: jest.fn(),
}));
const loadMore = loadMoreStories as jest.Mock;

// The address as the browser has it (Next's hook follows the History API).
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const card = (id: string, title: string): StorySummary => ({
  id,
  slug: id,
  title,
  excerpt: 'Dummy text.',
  bylineName: null,
  primaryFormat: 'written',
  durationSeconds: null,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 300,
  themes: [],
  publishedAt: '2026-10-21T20:00:00Z',
  isNew: false,
});

jest.mock('@/lib/api-user', () => {
  const actual = jest.requireActual('@/lib/api-user');
  return {
    ...actual,
    apiUser: () => ({
      get: async (path: string) => ({
        status: 200,
        data: path.includes('storyId=')
          ? { data: [] }
          : { data: [card('fav_1', 'My hearted story')], nextCursor: null },
        etag: null,
        location: null,
      }),
    }),
  };
});

const filters: BrowseFilters = {
  q: '',
  theme: null,
  format: null,
  sort: 'latest',
};

function SignedIn() {
  usePublishPersonalSession(
    'user_a',
    'https://api-user.test',
    async () =>
      `e30.${Buffer.from(JSON.stringify({ sub: 'user_a' })).toString('base64url')}.sig`,
  );
  return null;
}

function Page({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      {signedIn && <SignedIn />}
      <BrowseView
        query={filters}
        filters={null}
        summary={null}
        results={
          <BrowseResults
            snapshot="s1"
            filters={filters}
            cards={[card('b0', 'Browse story 0')]}
            nextCursor="c1"
            pagesLoaded={1}
          />
        }
      />
    </>
  );
}

beforeEach(() => {
  (
    window as unknown as { IntersectionObserver: unknown }
  ).IntersectionObserver = class {
    observe() {
      // never near the end on its own
    }
    disconnect() {
      // nothing to release
    }
  };
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

it('“Favourites only” in the address survives browse loading a page before sign-in resolves', async () => {
  // Back to a list two pages long: browse reloads its second page and rewrites the address.
  window.history.replaceState(null, '', '/stories?favourites=1&pages=2');
  let release: () => void = () => undefined;
  loadMore.mockImplementation(
    () =>
      new Promise((done) => {
        release = () =>
          done({
            ok: true,
            page: { data: [card('b1', 'Browse story 1')], nextCursor: null },
          });
      }),
  );
  const { rerender } = render(<Page signedIn={false} />);
  // Clerk is still loading: browse shows, without the switch.
  expect(screen.getByText('Browse story 0')).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  await waitFor(() => expect(loadMore).toHaveBeenCalled());

  await act(async () => release());
  await screen.findByText('Browse story 1');
  expect(window.location.search).toBe('?pages=2&favourites=1');

  // Sign-in resolves: the favourites show.
  rerender(<Page signedIn />);
  await waitFor(() =>
    expect(
      screen.getByRole('switch', { name: 'Favourites only' }).ariaChecked,
    ).toBe('true'),
  );
  await screen.findByText('My hearted story');
  expect(screen.queryByText('Browse story 1')).toBeNull();
});

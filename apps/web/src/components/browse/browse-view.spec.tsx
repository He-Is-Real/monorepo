import React from 'react';
import { render, screen } from '@testing-library/react';
import type { StorySummary } from '@/lib/browse';
import type { BrowseFilters } from '@/lib/browse-query';
import { loadMoreStories } from '@/app/stories/actions';
import { usePublishPersonalSession } from '@/lib/personal-session';
import { BrowseResults } from './browse-results';
import { BrowseView } from './browse-view';

// BS-9 (Joel, 2026-11-21): `/stories?favourites=1` opened while Clerk is still loading shows the
// switch on at once and the favourites' loading space (never browse's list, which could load a
// page and rewrite the address meanwhile: Codex, #223 round 1); once sign-in resolves, the
// account's favourites show. Clerk's timing can't be held in the e2e suite (its fixture person is
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
  themes: [],
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
        heading={null}
        query={filters}
        themeIds={[]}
        chosenThemes={[]}
        search={null}
        panel={null}
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

it('“Favourites only” turned on before sign-in resolves waits for it, then shows the account’s favourites', async () => {
  window.history.replaceState(null, '', '/stories?favourites=1&pages=2');
  const { rerender, container } = render(<Page signedIn={false} />);
  // Clerk is still loading: the switch is on, the favourites wait, browse isn't shown.
  expect(
    screen.getByRole('switch', { name: 'Favourites only' }).ariaChecked,
  ).toBe('true');
  expect(container.querySelector('[data-favourites-loading]')).not.toBeNull();
  expect(screen.queryByText('Browse story 0')).toBeNull();
  expect(loadMore).not.toHaveBeenCalled();

  // Sign-in resolves: the favourites show, and the address keeps the switch.
  rerender(<Page signedIn />);
  await screen.findByText('My hearted story');
  expect(window.location.search).toBe('?favourites=1&pages=2');
});

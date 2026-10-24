import React from 'react';
import { act, render, screen } from '@testing-library/react';
import type { StorySummary } from '@/lib/browse';
import type { BrowseFilters } from '@/lib/browse-query';
import { loadMoreStories } from '@/app/stories/actions';
import { BrowseResults } from './browse-results';

jest.mock('@/app/stories/actions', () => ({ loadMoreStories: jest.fn() }));
const loadMore = loadMoreStories as jest.Mock;

const filters: BrowseFilters = {
  q: '',
  tags: ['hope'],
  format: null,
  sort: 'latest',
};
const card = (n: number): StorySummary => ({
  id: `s${n}`,
  slug: `story-${n}`,
  title: `Story ${n}`,
  excerpt: 'Dummy text.',
  bylineName: null,
  primaryFormat: 'written',
  durationSeconds: null,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 300,
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
});
const page = (from: number, next: string | null) => ({
  ok: true,
  page: {
    data: Array.from({ length: 15 }, (_, i) => card(from + i)),
    nextCursor: next,
  },
});

let intersect: () => void;
beforeEach(() => {
  loadMore.mockReset();
  window.history.replaceState(null, '', '/stories?tag=hope');
  // jsdom has neither: a sentinel we can trigger by hand, and a 1-column screen.
  (
    window as unknown as { IntersectionObserver: unknown }
  ).IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      intersect = () => cb([{ isIntersecting: true }]);
    }
    observe() {
      // the test triggers it by hand
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

const first = Array.from({ length: 15 }, (_, i) => card(i));
const renderResults = (pages = 1, nextCursor: string | null = 'c1') =>
  render(
    <BrowseResults
      filters={filters}
      cards={first}
      nextCursor={nextCursor}
      pagesLoaded={pages}
      snapshot="s1"
    />,
  );

async function scrollToEnd() {
  await act(async () => intersect());
}

describe('BrowseResults (D55): races e2e can’t provoke', () => {
  it('rebuilds the pages the URL asks for when Back restores an older render', async () => {
    // Next's router cache can restore the first render (1 page) under a URL with pages=3.
    window.history.replaceState(null, '', '/stories?tag=hope&pages=3');
    loadMore
      .mockResolvedValueOnce(page(15, 'c2'))
      .mockResolvedValueOnce(page(30, 'c3'));
    await act(async () => {
      renderResults();
    });
    expect(loadMore).toHaveBeenNthCalledWith(1, filters, 'c1');
    expect(loadMore).toHaveBeenNthCalledWith(2, filters, 'c2');
    expect(screen.getAllByRole('article')).toHaveLength(45);
    expect(
      screen.getByRole('button', { name: 'Show more stories' }),
    ).toBeTruthy();
  });

  // Finding 2: a load that finishes after the list is gone changes nothing.
  it('ignores a load that finishes after the list was replaced', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    loadMore.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { unmount } = renderResults();
    await scrollToEnd();
    unmount();
    window.history.replaceState(null, '', '/stories?tag=loss');
    const replace = jest.spyOn(window.history, 'replaceState');
    await act(async () => resolve(page(15, 'c2')));
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?tag=loss');
    replace.mockRestore();
  });
});

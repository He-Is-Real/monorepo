import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
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

describe('BrowseResults (D55: 2 automatic pages, then a button)', () => {
  it('lists the cards in date order', () => {
    renderResults();
    const links = screen.getAllByRole('link').map((a) => a.textContent);
    expect(links.slice(0, 3)).toEqual(['Story 0', 'Story 1', 'Story 2']);
  });

  it('loads two pages on its own, then waits for the button', async () => {
    loadMore
      .mockResolvedValueOnce(page(15, 'c2'))
      .mockResolvedValueOnce(page(30, 'c3'))
      .mockResolvedValueOnce(page(45, null));
    renderResults();
    await scrollToEnd();
    expect(loadMore).toHaveBeenLastCalledWith(filters, 'c1');
    await scrollToEnd();
    expect(loadMore).toHaveBeenLastCalledWith(filters, 'c2');
    await scrollToEnd(); // a third time: nothing
    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('article')).toHaveLength(45);
    // D62: no story counts anywhere, not even of the stories loaded.
    expect(screen.getByText('There are more stories.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+ stories/);
    expect(window.location.search).toBe('?tag=hope&pages=3');

    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Show more stories' }),
      ),
    );
    expect(loadMore).toHaveBeenLastCalledWith(filters, 'c3');
    expect(screen.getAllByRole('article')).toHaveLength(60);
    expect(
      screen.queryByRole('button', { name: 'Show more stories' }),
    ).toBeNull();
    expect(screen.getByText('You’ve seen every story here.')).toBeTruthy();
    // The first new card takes focus, so keyboard users carry on from there.
    expect(document.activeElement?.textContent).toBe('Story 45');
  });

  it('announces new stories to screen readers', async () => {
    loadMore.mockResolvedValueOnce(page(15, 'c2'));
    renderResults();
    await scrollToEnd();
    expect(screen.getByRole('status').textContent).toBe(
      '15 more stories loaded.',
    );
  });

  it('shows the button straight away when the URL already had 3 pages', () => {
    renderResults(3, 'c3');
    expect(
      screen.getByRole('button', { name: 'Show more stories' }),
    ).toBeTruthy();
  });

  it('offers to try again when a page doesn’t load', async () => {
    loadMore
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(page(15, null));
    renderResults();
    await scrollToEnd();
    expect(screen.getByText('More stories couldn’t load.')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
    );
    expect(screen.getAllByRole('article')).toHaveLength(30);
  });

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

  it('says it’s the end when there is nothing more', () => {
    renderResults(1, null);
    expect(screen.getByText('You’ve seen every story here.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Codex review of #66, finding 1: a new server render is the truth.
  it('replaces its cards when a fresh server render arrives, dropping removed stories', async () => {
    loadMore.mockResolvedValueOnce(page(15, 'c2'));
    const { rerender } = renderResults();
    await scrollToEnd(); // 30 cards on screen
    expect(screen.getAllByRole('article')).toHaveLength(30);
    // The same filters, rendered again by the server: story 3 was hidden meanwhile.
    window.history.replaceState(null, '', '/stories?tag=hope');
    const fresh = first.filter((c) => c.id !== 's3');
    await act(async () => {
      rerender(
        <BrowseResults
          filters={{ ...filters }}
          cards={fresh}
          nextCursor="c1b"
          pagesLoaded={1}
          snapshot="s2"
        />,
      );
    });
    expect(screen.queryByText('Story 3')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(14);
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

  // Finding 4: a failed server action (network) shows the error, and Try again works.
  it('recovers from a server action that rejects', async () => {
    loadMore
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(page(15, null));
    renderResults();
    await scrollToEnd();
    expect(screen.getByText('More stories couldn’t load.')).toBeTruthy();
    expect(screen.queryByText('Loading more stories…')).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
    );
    expect(screen.getAllByRole('article')).toHaveLength(30);
  });

  // Finding 7: without JavaScript, a link to the next page whenever there is one.
  it.each([1, 3, 5])(
    'offers the no-JavaScript link after %p server pages',
    (pages) => {
      const html = renderToStaticMarkup(
        <BrowseResults
          filters={filters}
          cards={first}
          nextCursor="c"
          pagesLoaded={pages}
          snapshot="s1"
        />,
      );
      expect(html).toMatch(
        new RegExp(
          `<noscript><a href="/stories\\?tag=hope&amp;pages=${pages + 1}"`,
        ),
      );
    },
  );
});

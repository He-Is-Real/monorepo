import {
  browseHref,
  type BrowseFilters,
  parseBrowseSearch,
} from './browse-query';

const none: BrowseFilters = {
  q: '',
  theme: null,
  format: null,
  sort: 'latest',
};

describe('parseBrowseSearch (the browse page’s URL)', () => {
  it('defaults to the newest stories, one page', () => {
    expect(parseBrowseSearch({})).toEqual({ filters: none, pages: 1 });
  });

  it('reads a search, format and sort', () => {
    expect(
      parseBrowseSearch({
        q: '  healing  ',
        format: 'video',
        sort: 'oldest',
      }),
    ).toEqual({
      filters: {
        q: 'healing',
        theme: null,
        format: 'video',
        sort: 'oldest',
      },
      pages: 1,
    });
  });

  it('sorts by best match with a search, unless asked otherwise', () => {
    expect(parseBrowseSearch({ q: 'x' }).filters.sort).toBe('relevance');
    expect(parseBrowseSearch({ q: 'x', sort: 'latest' }).filters.sort).toBe(
      'latest',
    );
  });

  it('never sorts by relevance without a search (the API refuses it)', () => {
    expect(parseBrowseSearch({ sort: 'relevance' }).filters.sort).toBe(
      'latest',
    );
  });

  it('drops what the API would refuse: a bad format or sort', () => {
    const { filters } = parseBrowseSearch({
      format: 'podcast',
      sort: ['latest', 'oldest'],
    });
    expect(filters.format).toBeNull();
    expect(filters.sort).toBe('latest');
  });

  it('cuts a search to 200 characters', () => {
    expect([
      ...parseBrowseSearch({ q: 'é'.repeat(250) }).filters.q,
    ]).toHaveLength(200);
  });

  it.each([
    ['0', 1],
    ['3', 3],
    ['99', 10],
    ['x', 1],
    ['2.5', 1],
    [['2', '3'], 1],
  ])('clamps pages=%p to %p', (pages, expected) => {
    expect(parseBrowseSearch({ pages }).pages).toBe(expected);
  });
});

describe('browseHref', () => {
  it('leaves defaults out of the URL', () => {
    expect(browseHref(none)).toBe('/stories');
    expect(browseHref({ ...none, q: 'x', sort: 'relevance' })).toBe(
      '/stories?q=x',
    );
  });

  it('round-trips through parseBrowseSearch', () => {
    const f: BrowseFilters = {
      q: 'a b',
      theme: 'TOPIC_1',
      format: 'audio',
      sort: 'oldest',
    };
    const url = new URL(browseHref(f), 'http://x');
    const sp: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      sp[key] = all.length > 1 ? all : all[0];
    }
    expect(parseBrowseSearch(sp).filters).toEqual(f);
  });

  it('adds the page count when asked', () => {
    expect(browseHref(none, { pages: 3 })).toBe('/stories?pages=3');
  });
});

import {
  autoLoadsLeft,
  browseHref,
  type BrowseFilters,
  parseBrowseSearch,
  toggleTag,
} from './browse-query';

const none: BrowseFilters = { q: '', tags: [], format: null, sort: 'latest' };

describe('parseBrowseSearch (the browse page’s URL)', () => {
  it('defaults to the newest stories, one page', () => {
    expect(parseBrowseSearch({})).toEqual({ filters: none, pages: 1 });
  });

  it('reads a search, tags, format and sort', () => {
    expect(
      parseBrowseSearch({
        q: '  healing  ',
        tag: ['hope', 'faith'],
        format: 'video',
        sort: 'oldest',
      }),
    ).toEqual({
      filters: {
        q: 'healing',
        tags: ['hope', 'faith'],
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

  it('drops what the API would refuse: bad tag ids, repeats, more than 5 tags, bad format', () => {
    const { filters } = parseBrowseSearch({
      tag: ['ok', 'Not An Id', 'not-an-id', 'ok', 'b', 'c', 'd', 'e', 'f'],
      format: 'podcast',
      sort: ['latest', 'oldest'],
    });
    expect(filters.tags).toEqual(['ok', 'b', 'c', 'd', 'e']);
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

describe('browseHref and toggleTag', () => {
  it('leaves defaults out of the URL', () => {
    expect(browseHref(none)).toBe('/stories');
    expect(browseHref({ ...none, q: 'x', sort: 'relevance' })).toBe(
      '/stories?q=x',
    );
  });

  it('round-trips through parseBrowseSearch', () => {
    const f: BrowseFilters = {
      q: 'a b',
      tags: ['hope', 'joy'],
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

  it('toggles a tag on and off', () => {
    expect(toggleTag(none, 'hope').tags).toEqual(['hope']);
    expect(toggleTag({ ...none, tags: ['hope', 'joy'] }, 'hope').tags).toEqual([
      'joy',
    ]);
  });
});

describe('autoLoadsLeft (D55: at most 2 automatic extra pages)', () => {
  it.each([
    [1, 2],
    [2, 1],
    [3, 0],
    [5, 0],
  ])('after %p pages: %p', (pages, left) => {
    expect(autoLoadsLeft(pages)).toBe(left);
  });
});

/**
 * @jest-environment node
 */
import { browseStories } from '@/lib/browse';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { loadMoreStories } from './actions';

jest.mock('@/lib/browse', () => ({
  ...jest.requireActual('@/lib/browse'),
  browseStories: jest.fn(),
}));
const browse = browseStories as jest.Mock;

describe('loadMoreStories (the browse page’s next page, server-side, D32)', () => {
  beforeEach(() => browse.mockReset());

  it('asks api-public-read for the page after the cursor, with the same filters', async () => {
    browse.mockResolvedValue({ data: [], nextCursor: null });
    const result = await loadMoreStories(
      { q: ' hope ', tags: ['joy'], format: 'audio', sort: 'oldest' },
      'abc',
    );
    expect(result).toEqual({ ok: true, page: { data: [], nextCursor: null } });
    expect(browse).toHaveBeenCalledWith({
      q: 'hope',
      tags: ['joy'],
      format: 'audio',
      sort: 'oldest',
      limit: 15,
      cursor: 'abc',
    });
  });

  it('re-validates what the browser sent', async () => {
    browse.mockResolvedValue({ data: [], nextCursor: null });
    await loadMoreStories(
      { tags: ['Bad Slug', 7], format: 'x', sort: 'relevance' },
      'c',
    );
    expect(browse).toHaveBeenCalledWith(
      expect.objectContaining({ tags: [], format: undefined, sort: 'latest' }),
    );
  });

  it.each([undefined, 7, '', 'x'.repeat(301)])(
    'refuses cursor %p',
    async (cursor) => {
      expect(await loadMoreStories({}, cursor)).toEqual({ ok: false });
      expect(browse).not.toHaveBeenCalled();
    },
  );

  it('answers ok: false when the API is down or refuses the cursor', async () => {
    browse.mockRejectedValue(new StoriesUnavailableError('status 400'));
    expect(await loadMoreStories({}, 'c')).toEqual({ ok: false });
  });
});

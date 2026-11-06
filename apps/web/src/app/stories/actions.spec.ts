/**
 * @jest-environment node
 */
import { browseStories } from '@/lib/browse';
import { loadMoreStories } from './actions';

jest.mock('@/lib/browse', () => ({
  ...jest.requireActual('@/lib/browse'),
  browseStories: jest.fn(),
}));
const browse = browseStories as jest.Mock;

describe('loadMoreStories (the browse page’s next page, server-side, D32)', () => {
  beforeEach(() => browse.mockReset());

  it.each([undefined, 7, '', 'x'.repeat(301)])(
    'refuses cursor %p',
    async (cursor) => {
      expect(await loadMoreStories({}, cursor)).toEqual({ ok: false });
      expect(browse).not.toHaveBeenCalled();
    },
  );
});

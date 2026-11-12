import type { ApiUser } from '@/lib/api-user';
import { type MyStory, shareApi } from './share-api';

const story = (id: string, submittedAt: string | null): MyStory => ({
  id,
  version: 1,
  status: 'editing',
  title: id,
  description: '',
  body: null,
  bylineName: null,
  primaryFormat: 'written',
  media: [],
  image: null,
  themes: [],
  submittedAt,
  updatedAt: '2026-11-12T00:00:00Z',
});

/** api-user's GET /v1/account/stories?status=editing, one fixed page per cursor. */
function pagedApi(
  pages: Record<string, { data: MyStory[]; next: string | null }>,
) {
  const paths: string[] = [];
  const api: ApiUser = {
    get: async <T>(path: string) => {
      paths.push(path);
      const cursor = new URL(path, 'http://x').searchParams.get('cursor') ?? '';
      const page = pages[cursor];
      return {
        status: 200,
        data: { data: page.data, nextCursor: page.next } as T,
        etag: null,
        location: null,
      };
    },
    command: () => Promise.reject(new Error('not used')),
  };
  return { api, paths };
}

describe('Share’s draft list', () => {
  it('finds drafts past the first page of stories being edited', async () => {
    const sentBack = Array.from({ length: 50 }, (_, i) =>
      story(`sent_${i}`, '2026-11-01T00:00:00Z'),
    );
    const { api, paths } = pagedApi({
      '': {
        data: [story('draft_a', null), ...sentBack.slice(0, 49)],
        next: 'c1',
      },
      c1: { data: [sentBack[49], story('draft_b', null)], next: 'c 2' },
      'c 2': { data: [story('draft_c', null)], next: null },
    });
    const drafts = await shareApi(api).openDrafts();
    expect(drafts.map((s) => s.id)).toEqual(['draft_a', 'draft_b', 'draft_c']);
    expect(paths).toEqual([
      '/v1/account/stories?status=editing&limit=50',
      '/v1/account/stories?status=editing&limit=50&cursor=c1',
      '/v1/account/stories?status=editing&limit=50&cursor=c%202',
    ]);
  });
});

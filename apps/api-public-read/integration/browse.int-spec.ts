import type { INestApplication } from '@nestjs/common';
import {
  rows,
  run,
  type TestDatabase,
} from '@heisreal/database/integration-testing';
// The dev dataset and its loader, reused (test-only; never in the image: a devDependency).
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  DATASET,
  devDatabaseWithDataset,
  type StoryFixture,
} from '@heisreal/dev-seed/testing';
import { startPublicRead } from './app';

/**
 * M1 step 6a: browse, search, related and tags over the whole D47 dummy dataset, loaded by the
 * real dev-seed reset into SurrealDB 3.2.4, read by api-public-read's controllers on its own
 * read-only login (D13).
 */
interface Card {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  bylineName: string | null;
  primaryFormat: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  image: {
    url: null;
    width: number;
    height: number;
    alt: string | null;
  } | null;
  textLength: number;
  tags: { slug: string; name: string; category: string }[];
  publishedAt: string;
}
interface Page {
  data: Card[];
  nextCursor: string | null;
}

const approved = DATASET.stories.filter((s) => s.status === 'approved');
const unpublished = DATASET.stories.filter((s) => s.status !== 'approved');
// The test makes seed_v02 share seed_v01's publishedAt: ties are broken by id, newest id first.
const TIED = { with: 'seed_v01', moved: 'seed_v02' };
const daysAgo = (s: StoryFixture) =>
  s.id === TIED.moved
    ? (approved.find((a) => a.id === TIED.with)?.publishedDaysAgo ?? 0)
    : (s.publishedDaysAgo ?? 0);
const latestFirst = [...approved]
  .sort((a, b) => daysAgo(a) - daysAgo(b) || (a.id < b.id ? 1 : -1))
  .map((s) => s.id);

describe('browse API over the dev dataset', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { headers, redirect: 'manual' });
  const page = async (path: string): Promise<Page> => {
    const res = await get(path);
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  };
  /** Follows nextCursor to the end; returns the ids in order and the number of pages. */
  const walk = async (query: string) => {
    const ids: string[] = [];
    let pages = 0;
    let cursor: string | null = null;
    do {
      const sep = query ? '&' : '';
      const p = await page(
        `/v1/stories?${query}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      ids.push(...p.data.map((c) => c.id));
      cursor = p.nextCursor;
      pages++;
      expect(pages).toBeLessThan(100);
    } while (cursor);
    return { ids, pages };
  };

  beforeAll(async () => {
    t = await devDatabaseWithDataset();
    await run(
      await t.migrator(),
      `UPDATE type::record('publicStory', $moved)
         SET publishedAt = (SELECT VALUE publishedAt FROM ONLY type::record('publicStory', $with))`,
      { moved: TIED.moved, with: TIED.with },
    );
    ({ app, url } = await startPublicRead(t));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  describe('GET /v1/stories', () => {
    it('lists every published story once, newest first, with ties broken by id', async () => {
      const first = await page('/v1/stories');
      expect(first.data).toHaveLength(Math.min(20, approved.length));
      const { ids } = await walk('');
      expect(ids).toEqual(latestFirst);
    });

    it.each([1, 2, 5, 15, 16, 50])(
      'pages of %i give the same order, nothing lost or repeated',
      async (limit) => {
        const { ids, pages } = await walk(`limit=${limit}`);
        expect(ids).toEqual(latestFirst);
        // The last page is the one that isn't full; an exact multiple ends with the full page.
        expect(pages).toBe(Math.max(1, Math.ceil(approved.length / limit)));
      },
    );

    it('sorts oldest first', async () => {
      const { ids } = await walk('sort=oldest&limit=4');
      expect(ids).toEqual([...latestFirst].reverse());
    });

    it('never lists unpublished stories', async () => {
      const { ids } = await walk('limit=50');
      for (const s of unpublished) expect(ids).not.toContain(s.id);
      const all = JSON.stringify((await page('/v1/stories?limit=50')).data);
      for (const s of unpublished) expect(all).not.toContain(s.slug);
    });

    it('filters by a tag', async () => {
      const { ids } = await walk('tag=healing&limit=2');
      expect(ids).toEqual(
        latestFirst.filter((id) =>
          approved.find((s) => s.id === id)?.tags.includes('healing'),
        ),
      );
      expect(ids.length).toBeGreaterThan(1);
    });

    it('filters by several tags: stories with all of them', async () => {
      const { ids } = await walk('tag=healing&tag=faith');
      const expected = latestFirst.filter((id) => {
        const tags = approved.find((s) => s.id === id)?.tags ?? [];
        return tags.includes('healing') && tags.includes('faith');
      });
      expect(ids).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    });

    it('answers an unknown tag with no stories', async () => {
      expect(await page('/v1/stories?tag=no-such-tag')).toEqual({
        data: [],
        nextCursor: null,
      });
    });

    it.each(['video', 'audio', 'written'])(
      'filters by format: %s',
      async (format) => {
        const { ids } = await walk(`format=${format}&limit=3`);
        expect(ids).toEqual(
          latestFirst.filter(
            (id) => approved.find((s) => s.id === id)?.format === format,
          ),
        );
      },
    );

    it('gives a video card its size, duration and tags, and no playback or storage data', async () => {
      const { data } = await page('/v1/stories?format=video&limit=50');
      const v01 = data.find((c) => c.id === 'seed_v01') as Card;
      expect(v01).toEqual({
        id: 'seed_v01',
        slug: 'test-video-vertical-phone',
        title: 'Test video: a vertical phone clip',
        excerpt:
          'Dummy video story (9:16) with text, for the development site.',
        bylineName: 'Ruth (test)',
        primaryFormat: 'video',
        durationSeconds: 12,
        thumbnailUrl: null,
        thumbnailWidth: 360,
        thumbnailHeight: 640,
        image: null,
        textLength: 640,
        tags: [
          { slug: 'faith', name: 'Faith', category: 'journey', version: 1 },
          { slug: 'healing', name: 'Healing', category: 'theme', version: 1 },
          { slug: 'hope', name: 'Hope', category: 'emotion', version: 1 },
        ],
        publishedAt: expect.any(String),
      });
      expect(Date.parse(v01.publishedAt)).not.toBeNaN();
      const all = JSON.stringify(data);
      for (const leak of [
        'bunnyVideoId',
        'thumbnailPath',
        'playbackUrl',
        'searchText',
        'body',
        'submitter',
        'version":7',
      ])
        expect(all).not.toContain(leak);
    });

    it('gives a written card its image shape (never its path) and a bounded excerpt', async () => {
      const { data } = await page('/v1/stories?format=written&limit=50');
      const w01 = data.find((c) => c.id === 'seed_w01') as Card;
      expect(w01.image).toEqual({
        url: null,
        width: 1200,
        height: 1600,
        alt: 'A test pattern with a label (dummy image)',
      });
      expect(w01.thumbnailWidth).toBeNull();
      expect(w01.durationSeconds).toBeNull();
      expect(JSON.stringify(w01)).not.toContain('image-01.webp');
      for (const card of data)
        expect(card.textLength).toBeGreaterThanOrEqual(200);
    });

    it('bounds every excerpt; the 4,800-character description is cut at a word', async () => {
      const { data } = await page('/v1/stories?limit=50');
      for (const card of data)
        expect([...card.excerpt].length).toBeLessThanOrEqual(241);
      const a03 = data.find((c) => c.id === 'seed_a03') as Card;
      expect(a03.excerpt).toMatch(/[a-z]…$/);
      expect(a03.excerpt.length).toBeGreaterThan(200);
    });

    it('sends no-store (D51) and a weak ETag; If-None-Match answers 304', async () => {
      const res = await get('/v1/stories?limit=3');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const etag = res.headers.get('etag') as string;
      expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
      const again = await get('/v1/stories?limit=3', {
        'if-none-match': etag,
      });
      expect(again.status).toBe(304);
      expect(again.headers.get('etag')).toBe(etag);
      expect(again.headers.get('cache-control')).toBe('no-store');
      expect(
        (await get('/v1/stories?limit=4', { 'if-none-match': etag })).status,
      ).toBe(200);
    });

    it.each([
      ['limit=0', '/limit'],
      ['limit=51', '/limit'],
      ['limit=abc', '/limit'],
      ['limit=1.5', '/limit'],
      ['sort=popular', '/sort'],
      ['sort=relevance', '/sort'],
      ['format=photo', '/format'],
      ['tag=Not%20A%20Slug', '/tag'],
      ['tag=a&tag=b&tag=c&tag=d&tag=e&tag=f', '/tag'],
      [`q=${'a'.repeat(201)}`, '/q'],
      ['q=a&q=b', '/q'],
      ['limit=1&limit=2', '/limit'],
      ['views=desc', '/views'],
      ['cursor=not-a-cursor', '/cursor'],
      [`cursor=${'A'.repeat(301)}`, '/cursor'],
    ])('refuses %s with a 400 problem', async (query, pointer) => {
      const res = await get(`/v1/stories?${query}`);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain(
        'application/problem+json',
      );
      const problem = (await res.json()) as {
        code: string;
        errors: { pointer: string }[];
      };
      expect(problem.errors.map((e) => e.pointer)).toContain(pointer);
      // Never echoes what was sent.
      expect(JSON.stringify(problem)).not.toContain('Not A Slug');
      expect(JSON.stringify(problem)).not.toContain('aaaaaaaaaa');
    });

    it.each([
      ['an impossible date', 'latest', '2026-99-99T99:99:99Z'],
      ['31 February', 'oldest', '2026-02-31T00:00:00Z'],
    ])(
      'refuses a forged cursor with %s as a 400, never a 500',
      async (_, sort, date) => {
        const { nextCursor } = await page(`/v1/stories?limit=2&sort=${sort}`);
        const decoded = JSON.parse(
          Buffer.from(nextCursor as string, 'base64url').toString(),
        ) as { k: unknown[] };
        const forged = Buffer.from(
          JSON.stringify({ ...decoded, k: [date, decoded.k[1]] }),
        ).toString('base64url');
        const res = await get(
          `/v1/stories?limit=2&sort=${sort}&cursor=${forged}`,
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'invalid_cursor' });
      },
    );

    it('takes a forged but valid position as a place in the same public list', async () => {
      const { nextCursor } = await page('/v1/stories?limit=2');
      const decoded = JSON.parse(
        Buffer.from(nextCursor as string, 'base64url').toString(),
      ) as { k: unknown[] };
      const forged = Buffer.from(
        JSON.stringify({ ...decoded, k: ['2000-01-01T00:00:00Z', 'zzz'] }),
      ).toString('base64url');
      // Nothing was published before 2000, so the page is empty. A forged position only moves
      // within the same public list: the filters come from the query string, not the cursor.
      expect(await page(`/v1/stories?limit=2&cursor=${forged}`)).toEqual({
        data: [],
        nextCursor: null,
      });
    });

    it('refuses a cursor from other filters', async () => {
      const { nextCursor } = await page('/v1/stories?limit=2');
      const res = await get(
        `/v1/stories?limit=2&format=video&cursor=${encodeURIComponent(nextCursor as string)}`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_cursor' });
    });
  });

  describe('search (q)', () => {
    const search = async (q: string, extra = '') =>
      (await walk(`q=${encodeURIComponent(q)}${extra}`)).ids;

    it('finds words in the title, description and text, by stem', async () => {
      expect(await search('skeleton')).toContain('seed_w06');
      // "panoramas" stems to "panorama" (snowball, English).
      expect(await search('panoramas')).toContain('seed_w04');
    });

    it.each([
      ['Greek', 'Δοκιμαστική'],
      ['Korean', '이야기'],
      ['Arabic', 'تجريبية'],
    ])('finds the non-Latin story by a %s word', async (_, word) => {
      expect(await search(word)).toEqual(['seed_v06']);
    });

    it('finds non-Latin words in the text too', async () => {
      expect(await search('텍스트입니다')).toEqual(['seed_w04']);
    });

    it('finds only published stories', async () => {
      const ids = await search('test', '&limit=50');
      expect(ids.length).toBeGreaterThan(0);
      for (const s of unpublished) expect(ids).not.toContain(s.id);
    });

    it('pages search results by relevance without losing or repeating any', async () => {
      const all = await search('test', '&limit=50');
      expect(await search('test', '&limit=3')).toEqual(all);
      expect(new Set(all).size).toBe(all.length);
    });

    it('sorts search results by date when asked', async () => {
      const ids = await search('test', '&sort=latest&limit=4');
      expect(ids).toEqual(latestFirst.filter((id) => ids.includes(id)));
      const oldest = await search('test', '&sort=oldest&limit=4');
      expect(oldest).toEqual([...ids].reverse());
    });

    it('answers a query with no words in it with no stories', async () => {
      expect(await page('/v1/stories?q=%21%21%21')).toEqual({
        data: [],
        nextCursor: null,
      });
    });

    it('treats a blank query as no query', async () => {
      expect((await walk('q=%20%20')).ids).toEqual(latestFirst);
    });

    it('takes SurrealQL in q as plain text', async () => {
      expect(
        (
          await get(
            `/v1/stories?q=${encodeURIComponent("'; DELETE publicStory; --")}`,
          )
        ).status,
      ).toBe(200);
      expect(
        await rows(
          await t.migrator(),
          'SELECT count() AS n FROM publicStory GROUP ALL',
        ),
      ).toEqual([{ n: approved.length }]);
    });
  });

  describe('GET /v1/stories/{slug}/related', () => {
    const related = async (slug: string) =>
      (await page(`/v1/stories/${slug}/related`)).data.map((c) => c.id);

    it('gives three stories, most shared tags first, then newest, never itself', async () => {
      // seed_v03: healing, loss, faith, forgiveness, peace.
      const ids = await related('test-video-landscape-five-tags');
      expect(ids).toHaveLength(3);
      expect(ids).not.toContain('seed_v03');
      const v03 = approved.find((s) => s.id === 'seed_v03') as StoryFixture;
      const shared = (id: string) =>
        (approved.find((s) => s.id === id)?.tags ?? []).filter((x) =>
          v03.tags.includes(x),
        ).length;
      const expected = latestFirst
        .filter((id) => id !== 'seed_v03')
        .sort((a, b) => shared(b) - shared(a))
        .slice(0, 3);
      expect(ids).toEqual(expected);
      for (const s of unpublished) expect(ids).not.toContain(s.id);
    });

    it('fills with the newest stories when none share a tag', async () => {
      expect(await related('test-video-no-tags')).toEqual(
        latestFirst.filter((id) => id !== 'seed_v07').slice(0, 3),
      );
    });

    it('answers 404 for an unknown or unpublished story', async () => {
      for (const slug of ['no-such-story', 'test-video-pending']) {
        const res = await get(`/v1/stories/${slug}/related`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'story_not_found' });
      }
    });

    it('answers 301 for a previous slug', async () => {
      await run(
        await t.migrator(),
        `UPDATE publicStory:seed_v05 SET slugHistory = ['old-anonymous-slug']`,
      );
      const res = await get('/v1/stories/old-anonymous-slug/related');
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(
        '/v1/stories/test-video-square-anonymous/related',
      );
    });

    it('caches like every public query', async () => {
      const res = await get('/v1/stories/test-video-vertical-phone/related');
      const etag = res.headers.get('etag') as string;
      expect(etag).toMatch(/^W\//);
      expect(
        (
          await get('/v1/stories/test-video-vertical-phone/related', {
            'if-none-match': etag,
          })
        ).status,
      ).toBe(304);
    });
  });

  describe('GET /v1/tags', () => {
    it('lists every tag by category (theme, journey, emotion) then name, without counts', async () => {
      const res = await get('/v1/tags');
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as {
        data: { slug: string; name: string; category: string }[];
      };
      const order = ['theme', 'journey', 'emotion'];
      const expected = [...DATASET.tags]
        .sort(
          (a, b) =>
            order.indexOf(a.category) - order.indexOf(b.category) ||
            a.name.localeCompare(b.name),
        )
        .map((x) => ({
          slug: x.id,
          name: x.name,
          category: x.category,
          version: 1,
        }));
      expect(data).toEqual(expected);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const etag = res.headers.get('etag') as string;
      expect((await get('/v1/tags', { 'if-none-match': etag })).status).toBe(
        304,
      );
    });

    it('refuses query parameters', async () => {
      expect((await get('/v1/tags?category=theme')).status).toBe(400);
    });
  });

  describe('GET /v1/stories/{slug}', () => {
    it('now carries the clip’s duration', async () => {
      const story = (await page(
        '/v1/stories/test-audio-with-text',
      )) as unknown as {
        media: { durationSeconds: number | null }[];
      };
      expect(story.media[0].durationSeconds).toEqual(expect.any(Number));
    });
  });

  describe('caching (D51)', () => {
    const saved = process.env['PUBLIC_RESPONSE_CACHING'];
    afterEach(() => {
      if (saved === undefined) delete process.env['PUBLIC_RESPONSE_CACHING'];
      else process.env['PUBLIC_RESPONSE_CACHING'] = saved;
    });

    it('lets shared caches keep public reads only when turned on (Go live, D56)', async () => {
      process.env['PUBLIC_RESPONSE_CACHING'] = 'on';
      for (const path of [
        '/v1/stories?limit=2',
        '/v1/stories/test-video-vertical-phone/related',
        '/v1/stories/test-video-vertical-phone',
        '/v1/tags',
      ])
        expect((await get(path)).headers.get('cache-control')).toBe(
          'public, max-age=60, stale-while-revalidate=300',
        );
    });

    it('drops a hidden story from every read on the next request', async () => {
      // The newest story, on every first page; PR #61 hides a story by deleting its row.
      const slug = 'test-story-walking-skeleton';
      const id = 'seed_w06';
      const before = await page('/v1/stories?limit=5');
      expect(before.data.map((c) => c.id)).toContain(id);
      expect(
        (
          await page('/v1/stories/test-written-portrait-image/related')
        ).data.map((c) => c.id),
      ).toContain(id);
      await run(await t.migrator(), `DELETE type::record('publicStory', $id)`, {
        id,
      });
      const list = await get('/v1/stories?limit=5');
      expect(list.headers.get('cache-control')).toBe('no-store');
      expect(((await list.json()) as Page).data.map((c) => c.id)).not.toContain(
        id,
      );
      expect(
        (await page('/v1/stories?q=skeleton')).data.map((c) => c.id),
      ).not.toContain(id);
      expect(
        (
          await page('/v1/stories/test-written-portrait-image/related')
        ).data.map((c) => c.id),
      ).not.toContain(id);
      for (const path of [
        `/v1/stories/${slug}`,
        `/v1/stories/${slug}/related`,
      ]) {
        const res = await get(path);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    });
  });
});

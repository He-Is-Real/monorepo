import type { INestApplication } from '@nestjs/common';
import { run, TestDatabase } from '@heisreal/database/integration-testing';
import { startPublicRead } from './app';

/**
 * R13 (Joel, 2026-11-05): each running api-public-read keeps recent public answers in memory, so
 * the same request is answered without asking the database, for 60 seconds in total, end to end.
 * The clock is the test's: nothing here waits.
 */
const FIRST = 'test-cache-first';
const SECOND = 'test-cache-second';

/** One obviously fake, published story, as the migrator loads system data (stories.int-spec.ts). */
const publish = (id: string, slug: string, title: string) => `
  LET $s = (CREATE ONLY type::record('story', '${id}') CONTENT {
    submitter: user:cache_seed, slug: '${slug}', title: '${title}',
    description: 'Placeholder content for a cache test. This is not a real testimony.',
    body: 'This is test text, written to check that api-public-read answers the same public request from memory for a minute and then asks the database again. Nobody shared this story and nothing in it happened.',
    bylineName: 'Test Person', primaryFormat: 'written', themeRefs: [theme:common]
  });
  FOR $step IN [['pending', 'person'], ['in_review', 'moderator'], ['approved', 'moderator']] {
    CREATE storyStatusLog CONTENT { story: $s.id, status: $step[0], actor: $step[1],
      by: IF $step[1] = 'moderator' { user:cache_moderator } };
  };`;

describe('the public answer cache (R13)', () => {
  let t: TestDatabase;
  const apps: INestApplication[] = [];

  const start = async (cacheCapacity?: number) => {
    const started = await startPublicRead(t, undefined, undefined, {
      cacheCapacity,
    });
    apps.push(started.app);
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${started.url}${path}`, { headers, redirect: 'manual' });
    const title = async (path: string) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        title?: string;
        data?: { title: string }[];
      };
      return body.title ?? body.data?.[0]?.title;
    };
    return { ...started, get, title };
  };
  /** A new title on the published story, as an approved edit leaves it. */
  const retitle = async (slug: string, title: string) =>
    run(
      await t.migrator(),
      'UPDATE story SET title = $title WHERE slug = $slug',
      { slug, title },
    );

  const saved = process.env['PUBLIC_RESPONSE_CACHING'];
  beforeEach(async () => {
    t = await TestDatabase.create();
    await run(
      await t.migrator(),
      `CREATE user:cache_seed CONTENT {
         termsOfUse: termsOfUseAgreement:0, termsOfUseAgreedAt: time::now(),
         testimonyConsent: testimonyConsent:0, testimonyConsentAgreedAt: time::now()
       };
       ${publish('cache_first', FIRST, 'Before')}`,
    );
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['PUBLIC_RESPONSE_CACHING'];
    else process.env['PUBLIC_RESPONSE_CACHING'] = saved;
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await t?.close();
  });

  it('answers the same request from memory for 60 seconds, then asks the database again', async () => {
    const { title, passTime } = await start();
    expect(await title(`/v1/stories/${FIRST}`)).toBe('Before');
    await retitle(FIRST, 'After');
    expect(await title(`/v1/stories/${FIRST}`)).toBe('Before');
    passTime(59_999);
    expect(await title(`/v1/stories/${FIRST}`)).toBe('Before');
    passTime(1);
    expect(await title(`/v1/stories/${FIRST}`)).toBe('After');
  });

  it('treats the same query in another order as the same request, and another query as another', async () => {
    const { title } = await start();
    expect(await title('/v1/stories?limit=5&sort=latest')).toBe('Before');
    await retitle(FIRST, 'After');
    expect(await title('/v1/stories?sort=latest&limit=5')).toBe('Before');
    expect(await title('/v1/stories?limit=4&sort=latest')).toBe('After');
  });

  it('keys an answer on the query as the handler read it, so a crafted URL cannot stand in for another', async () => {
    const { title } = await start();
    // Express reads at most 1,000 query parameters; the empty ones before `format=video` use them
    // all up, so this request is answered unfiltered. It must not become `?format=video`'s answer.
    expect(await title(`/v1/stories?${'&'.repeat(1_000)}format=video`)).toBe(
      'Before',
    );
    expect(await title('/v1/stories?format=video')).toBeUndefined();
  });

  it('never keeps an error or a redirect', async () => {
    const { get, title } = await start();
    expect((await get(`/v1/stories/${SECOND}`)).status).toBe(404);
    expect((await get('/v1/stories/old-cache-slug')).status).toBe(404);
    await run(
      await t.migrator(),
      `${publish('cache_second', SECOND, 'Second')}
       UPDATE story:cache_first SET slugHistory = ['old-cache-slug'];`,
    );
    expect(await title(`/v1/stories/${SECOND}`)).toBe('Second');
    const moved = await get('/v1/stories/old-cache-slug');
    expect(moved.status).toBe(301);
    await run(
      await t.migrator(),
      `UPDATE story:cache_first SET slugHistory = []`,
    );
    expect((await get('/v1/stories/old-cache-slug')).status).toBe(404);
  });

  it('drops the answer used longest ago when full', async () => {
    const { title } = await start(2);
    const a = `/v1/stories/${FIRST}`;
    const b = '/v1/stories?limit=1';
    const c = '/v1/stories?limit=2';
    await title(a);
    await title(b);
    await title(a); // a is now the most recently used
    await title(c); // full: b goes
    await retitle(FIRST, 'After');
    expect(await title(a)).toBe('Before');
    expect(await title(c)).toBe('Before');
    expect(await title(b)).toBe('After');
  });

  it('keeps no-store for browsers and CDNs while shared caching is off (D51), from memory too', async () => {
    const { get } = await start();
    const first = await get(`/v1/stories/${FIRST}`);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const etag = String(first.headers.get('etag'));
    const again = await get(`/v1/stories/${FIRST}`);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect(again.headers.get('etag')).toBe(etag);
    const conditional = await get(`/v1/stories/${FIRST}`, {
      'if-none-match': etag,
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect(conditional.headers.get('cache-control')).toBe('no-store');
  });

  it('lets browsers and CDNs keep an answer only for the time it has left when turned on', async () => {
    process.env['PUBLIC_RESPONSE_CACHING'] = 'on';
    const { get, passTime } = await start();
    const path = '/v1/stories?limit=5';
    const first = await get(path);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = String(first.headers.get('etag'));
    passTime(25_500);
    const hit = await get(path);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=34');
    // A 304 refreshes a browser's copy: it must not stretch the 60 seconds either.
    const conditional = await get(path, { 'if-none-match': etag });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect(conditional.headers.get('cache-control')).toBe('public, max-age=34');
    passTime(34_500);
    const fresh = await get(path, { 'if-none-match': etag });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get('cache-control')).toBe('public, max-age=60');
    // Redirects aren't kept in memory, and never stale-while-revalidate (60 seconds in total).
    await run(
      await t.migrator(),
      `UPDATE story:cache_first SET slugHistory = ['old-cache-slug']`,
    );
    const moved = await get('/v1/stories/old-cache-slug');
    expect(moved.status).toBe(301);
    expect(moved.headers.get('cache-control')).toBe('public, max-age=60');
  });
});

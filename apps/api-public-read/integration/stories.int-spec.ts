import type { INestApplication } from '@nestjs/common';
import { run, TestDatabase } from '@heisreal/database/integration-testing';
import { startPublicRead } from './app';

/**
 * M0 task 0.9 end to end: one published story in SurrealDB 3.2.4, read by api-public-read's
 * real app on its own read-only login (D13), as the contract says (api-public-read.yaml,
 * getStoryBySlug), and what it answers when the database is down.
 */
const SLUG = 'test-story-walking-skeleton';

describe('GET /v1/stories/{slug} on SurrealDB', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  let passTime: (ms: number) => void;

  beforeAll(async () => {
    t = await TestDatabase.create();
    // One obviously fake, published story, loaded by the migrator as system data (as the
    // walking skeleton's old seed did): its submitter agreed to the testimony consent, which
    // publishing needs, and has no Clerk account, so nobody can sign in as them.
    await run(
      await t.migrator(),
      `CREATE user:dev_seed CONTENT {
         termsOfUse: termsOfUseAgreement:0, termsOfUseAgreedAt: time::now(),
         testimonyConsent: testimonyConsent:0, testimonyConsentAgreedAt: time::now()
       };
       LET $s = (CREATE ONLY story:dev_seed CONTENT {
         submitter: user:dev_seed, slug: '${SLUG}',
         title: 'Test story: the walking skeleton',
         description: 'Placeholder content for the development site. This is not a real testimony.',
         body: 'This is test text, written to check that a published story travels from the database through api-public-read to the page. Nobody shared this story and nothing in it happened. Real stories arrive with the first submissions.',
         bylineName: 'Test Person', primaryFormat: 'written', themeRefs: [theme:common], media: []
       });
       FOR $step IN [['pending', 'person'], ['in_review', 'moderator'], ['approved', 'moderator']] {
         CREATE storyStatusLog CONTENT { story: $s.id, status: $step[0], actor: $step[1],
           by: IF $step[1] = 'moderator' { user:dev_seed_moderator } };
       };`,
    );
    // Through startPublicRead, so every response is checked against the contract.
    ({ app, url, passTime } = await startPublicRead(t));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('serves the seeded test story', async () => {
    const res = await fetch(`${url}/v1/stories/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const story = (await res.json()) as Record<string, unknown>;
    expect(story).toMatchObject({
      id: 'dev_seed',
      slug: SLUG,
      title: 'Test story: the walking skeleton',
      bylineName: 'Test Person',
      primaryFormat: 'written',
      media: [],
      image: null,
      themes: [{ id: 'common', name: 'Common' }],
      version: 4, // created, then three status entries (submitted, picked up, approved)
    });
    expect(Date.parse(String(story['publishedAt']))).not.toBeNaN();
    // Nothing private or about moderation: no submitter, consent or status.
    expect(Object.keys(story).sort()).toEqual([
      'body',
      'bylineName',
      'description',
      'id',
      'image',
      'media',
      'primaryFormat',
      'publishedAt',
      'slug',
      'themes',
      'title',
      'updatedAt',
      'version',
    ]);
  });

  it.each(['no-such-story', 'Not_A_Slug', 'a--b', 'a'.repeat(201)])(
    'answers a 404 problem for %p',
    async (slug) => {
      const res = await fetch(`${url}/v1/stories/${slug}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(
        /^application\/problem\+json/,
      );
      expect(await res.json()).toMatchObject({
        status: 404,
        code: 'story_not_found',
      });
    },
  );

  it('answers a bare 500 problem and a failing health check when the database is down', async () => {
    const closed = await t.service('api_public_read');
    await closed.close();
    const down = await startPublicRead(t, undefined, closed);
    try {
      const res = await fetch(`${down.url}/v1/stories/${SLUG}`);
      expect(res.status).toBe(500);
      // Nothing about the failure reaches the visitor.
      expect(await res.json()).toEqual({
        type: 'about:blank',
        title: 'Internal server error',
        status: 500,
      });
      const health = await fetch(`${down.url}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({
        status: 'degraded',
        service: 'api-public-read',
        db: 'down',
      });
    } finally {
      await down.app.close();
    }
  });

  it('answers 301 for a previous slug', async () => {
    await run(
      await t.migrator(),
      `UPDATE story:dev_seed SET slugHistory = ['old-test-slug']`,
    );
    const moved = await fetch(`${url}/v1/stories/old-test-slug`, {
      redirect: 'manual',
    });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe(`/v1/stories/${SLUG}`);
  });
  it('serves a written story’s image by its shape, never its storage path (D53)', async () => {
    await run(
      await t.migrator(),
      `-- A2: only a processed image can be published (the migrator may record that itself).
       -- A new image on a public story hides it (D59) until a moderator shows it again.
       UPDATE story:dev_seed SET image = { path: 'dev-seed/dev-seed.webp', width: 1200, height: 1600,
         processing: 'ready' };
       CREATE storyStatusLog CONTENT { story: story:dev_seed, status: 'approved',
         actor: 'moderator', by: user:dev_seed_moderator };`,
    );
    passTime(60_000); // the story page read earlier is a minute old (R13)
    const story = (await (await fetch(`${url}/v1/stories/${SLUG}`)).json()) as {
      image: unknown;
    };
    expect(story.image).toEqual({
      url: null,
      width: 1200,
      height: 1600,
      alt: null,
    });
    expect(JSON.stringify(story)).not.toContain('dev-seed.webp');
    expect(JSON.stringify(story)).not.toContain('processing');
  });
});

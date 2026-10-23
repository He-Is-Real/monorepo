import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import {
  DPA_V1_SHA256,
  run,
  sha256,
  SCHEMA_DIR,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { ProblemFilter } from '@heisreal/http';
import type { Surreal } from 'surrealdb';
import { StoriesModule } from '../src/app/stories/stories.controller';

/**
 * M0 task 0.9 end to end: the dev seed (0003) migrated into SurrealDB 3.2.4, read by
 * api-public-read's real controller on its own read-only login (D13), as the contract says
 * (api-public-read.yaml, getStoryBySlug).
 */
const SLUG = 'test-story-walking-skeleton';

describe('GET /v1/stories/{slug} on SurrealDB', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
    await t.migrate(
      t.params({
        seed_dev_story: true,
        dpa_sha256: {
          v1: DPA_V1_SHA256,
          dev_seed: sha256(
            readFileSync(
              join(SCHEMA_DIR, '../../legal/dpa/dev_seed.md'),
              'utf8',
            ),
          ),
        },
      }),
    );
    await t.createServices();
    const connection: Surreal = await t.service('api_public_read');

    @Global()
    @Module({
      providers: [{ provide: SURREAL, useValue: connection }],
      exports: [SURREAL],
    })
    class ReadOnlyDatabase {}

    const moduleRef = await Test.createTestingModule({
      imports: [ReadOnlyDatabase, StoriesModule],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('serves the seeded test story from the read model', async () => {
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
      tags: [],
      version: 1,
    });
    expect(Date.parse(String(story['publishedAt']))).not.toBeNaN();
    // Nothing from the write model or the person: no submitter, consent or status.
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
      'tags',
      'title',
      'updatedAt',
      'version',
    ]);
  });

  it('answers 404 problems for unknown slugs', async () => {
    const res = await fetch(`${url}/v1/stories/no-such-story`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'story_not_found' });
  });

  it('resolves tags and answers 301 for a previous slug', async () => {
    const migrator = await t.migrator();
    await run(
      migrator,
      `BEGIN TRANSACTION;
       CREATE tag:doubt SET name = 'Doubt', category = 'journey';
       UPDATE story:dev_seed SET tagRefs = [tag:doubt];
       UPDATE publicStory:dev_seed SET tagRefs = [tag:doubt], slugHistory = ['old-test-slug'];
       COMMIT TRANSACTION;`,
    );
    const story = (await (await fetch(`${url}/v1/stories/${SLUG}`)).json()) as {
      tags: unknown;
    };
    expect(story.tags).toEqual([
      { slug: 'doubt', name: 'Doubt', category: 'journey', version: 1 },
    ]);
    // Renaming a tag changes the response without changing the story's version: the ETag
    // follows the representation, so a cached copy is revalidated (#45 review).
    const before = await fetch(`${url}/v1/stories/${SLUG}`);
    const etag = before.headers.get('etag') as string;
    expect(
      (
        await fetch(`${url}/v1/stories/${SLUG}`, {
          headers: { 'if-none-match': etag },
        })
      ).status,
    ).toBe(304);
    await run(migrator, `UPDATE tag:doubt SET name = 'Questions'`);
    const after = await fetch(`${url}/v1/stories/${SLUG}`, {
      headers: { 'if-none-match': etag },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(etag);
    expect(
      ((await after.json()) as { tags: { name: string }[] }).tags[0].name,
    ).toBe('Questions');

    const moved = await fetch(`${url}/v1/stories/old-test-slug`, {
      redirect: 'manual',
    });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe(`/v1/stories/${SLUG}`);
  });
  it('serves a written story’s image by its shape, never its storage path (D53)', async () => {
    await run(
      await t.migrator(),
      `BEGIN TRANSACTION;
       -- A2: only a processed image can be published (the migrator may record that itself).
       UPDATE story:dev_seed SET image = { path: 'images/dev-seed.webp', width: 1200, height: 1600,
         processing: 'ready' };
       UPDATE publicStory:dev_seed SET image = { path: 'images/dev-seed.webp', width: 1200, height: 1600 };
       COMMIT TRANSACTION;`,
    );
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

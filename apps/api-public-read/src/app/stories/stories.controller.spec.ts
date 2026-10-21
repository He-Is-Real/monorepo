import {
  type DynamicModule,
  Global,
  type INestApplication,
  Module,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import { ProblemFilter } from '@heisreal/http';
import { StoriesModule } from './stories.controller';

const story = {
  id: 'dev_seed',
  slug: 'test-story',
  title: 'Test story',
  description: 'Placeholder',
  body: 'Test text',
  primaryFormat: 'written',
  media: [
    { format: 'video', aspectRatio: '9:16', bunnyVideoId: 'internal-id' },
  ],
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 3,
};

/** Answers the controller's two statements: [current matches, previous-slug matches]. */
function database(current: unknown[], previous: string[] = []) {
  const vars: unknown[] = [];
  return {
    vars,
    db: {
      query: (_sql: string, v: unknown) => ({
        json: () => ({
          responses: async () => {
            vars.push(v);
            return [
              { success: true, result: current },
              { success: true, result: previous },
            ];
          },
        }),
      }),
    },
  };
}

@Global()
@Module({})
class DatabaseStub {
  static with(db: unknown): DynamicModule {
    return {
      module: DatabaseStub,
      providers: [{ provide: SURREAL, useValue: db }],
      exports: [SURREAL],
    };
  }
}

async function boot(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    imports: [StoriesModule, DatabaseStub.with(db)],
    providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

describe('GET /v1/stories/{slug}', () => {
  it('returns the public story with a strong ETag and public caching, and no internal media ids', async () => {
    const { db, vars } = database([story]);
    const { app, url } = await boot(db);
    try {
      const res = await fetch(`${url}/v1/stories/test-story`);
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBe('"3"');
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=60, stale-while-revalidate=300',
      );
      const body = await res.json();
      expect(body).toEqual({
        id: 'dev_seed',
        slug: 'test-story',
        title: 'Test story',
        description: 'Placeholder',
        body: 'Test text',
        bylineName: null,
        primaryFormat: 'written',
        media: [
          {
            format: 'video',
            playbackUrl: null,
            thumbnailUrl: null,
            aspectRatio: '9:16',
            captionsUrl: null,
            durationSeconds: null,
          },
        ],
        tags: [],
        publishedAt: '2026-10-21T20:00:00Z',
        version: 3,
      });
      expect(JSON.stringify(body)).not.toContain('internal-id');
      expect(vars).toEqual([{ slug: 'test-story' }]);
    } finally {
      await app.close();
    }
  });

  it('answers 304 when If-None-Match still matches', async () => {
    const { app, url } = await boot(database([story]).db);
    try {
      const res = await fetch(`${url}/v1/stories/test-story`, {
        headers: { 'if-none-match': 'W/"3", "1"' },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get('etag')).toBe('"3"');
    } finally {
      await app.close();
    }
  });

  it('answers 301 to the current slug for a previous one (D30)', async () => {
    const { app, url } = await boot(database([], ['new-slug']).db);
    try {
      const res = await fetch(`${url}/v1/stories/old-slug`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/v1/stories/new-slug');
    } finally {
      await app.close();
    }
  });

  it.each(['unknown-slug', 'Not_A_Slug', 'a--b', `${'a'.repeat(201)}`])(
    'answers a 404 problem for %p, without asking the database about invalid slugs',
    async (slug) => {
      const { db, vars } = database([]);
      const { app, url } = await boot(db);
      try {
        const res = await fetch(
          `${url}/v1/stories/${encodeURIComponent(slug)}`,
        );
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toMatch(
          /^application\/problem\+json/,
        );
        expect(await res.json()).toMatchObject({
          status: 404,
          code: 'story_not_found',
        });
        expect(vars.length).toBe(slug === 'unknown-slug' ? 1 : 0);
      } finally {
        await app.close();
      }
    },
  );

  it('answers a bare 500 problem when the database fails', async () => {
    const db = {
      query: () => ({
        json: () => ({
          responses: async () => {
            throw new Error('db down');
          },
        }),
      }),
    };
    const { app, url } = await boot(db);
    try {
      const res = await fetch(`${url}/v1/stories/test-story`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        type: 'about:blank',
        title: 'Internal server error',
        status: 500,
      });
    } finally {
      await app.close();
    }
  });
});

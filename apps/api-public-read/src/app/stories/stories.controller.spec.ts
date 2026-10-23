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
import { representationETag } from '../caching';
import { MediaUrls, mediaConfigFromEnv } from '../media/media-urls';
import { StoriesModule } from './stories.controller';

const story = {
  id: 'dev_seed',
  slug: 'test-story',
  title: 'Test story',
  description: 'Placeholder',
  body: 'Test text',
  primaryFormat: 'video',
  media: [
    {
      format: 'video',
      width: 1080,
      height: 1920,
      bunnyVideoId: 'internal-id',
      thumbnailPath: 'internal-thumb.jpg',
    },
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

@Global()
@Module({})
class MediaStub {
  static with(media: MediaUrls): DynamicModule {
    return {
      module: MediaStub,
      providers: [{ provide: MediaUrls, useValue: media }],
      exports: [MediaUrls],
    };
  }
}

const SIGNING_OFF = new MediaUrls(null);
/** What the signing tests read from a response. */
type Signed = {
  media: { playbackUrl: string; thumbnailUrl: string; captionsUrl: null }[];
  image: { url: string; width: number; height: number; alt: null };
};
const signedBody = async (url: string) =>
  (await (await fetch(`${url}/v1/stories/test-story`)).json()) as Signed;
/** 2026-10-23 10:15 UTC: links expire at 17:00 (6 h, rounded up to the hour). */
const NOW = Date.UTC(2026, 9, 23, 10, 15);
const signing = (now = () => NOW) =>
  new MediaUrls(
    {
      config: mediaConfigFromEnv({
        BUNNY_STREAM_LIBRARY_ID: '786537',
        BUNNY_STREAM_CDN_HOST: 'vz-test.b-cdn.net',
        BUNNY_IMAGES_CDN_HOST: 'images-test.b-cdn.net',
        BUNNY_STREAM_TOKEN_KEY_SECRET: 'bunny-stream-token-key',
        BUNNY_IMAGES_TOKEN_KEY_SECRET: 'bunny-images-token-key',
      })!,
      streamKey: 'stream-key',
      imagesKey: 'images-key',
    },
    now,
  );

async function boot(db: unknown, media: MediaUrls = SIGNING_OFF) {
  const moduleRef = await Test.createTestingModule({
    imports: [StoriesModule, DatabaseStub.with(db), MediaStub.with(media)],
    providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

describe('GET /v1/stories/{slug}', () => {
  it('returns the public story with a strong ETag, no-store (D51), and no internal media ids', async () => {
    const { db, vars } = database([story]);
    const { app, url } = await boot(db);
    try {
      const res = await fetch(`${url}/v1/stories/test-story`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      // A strong validator of the representation (a hash of the body), not the version.
      expect(res.headers.get('etag')).toBe(representationETag(body));
      expect(res.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
      expect(body).toEqual({
        id: 'dev_seed',
        slug: 'test-story',
        title: 'Test story',
        description: 'Placeholder',
        body: 'Test text',
        bylineName: null,
        primaryFormat: 'video',
        media: [
          {
            format: 'video',
            playbackUrl: null,
            thumbnailUrl: null,
            width: 1080,
            height: 1920,
            captionsUrl: null,
            durationSeconds: null,
          },
        ],
        image: null,
        tags: [],
        publishedAt: '2026-10-21T20:00:00Z',
        version: 3,
      });
      expect(JSON.stringify(body)).not.toContain('internal-');
      expect(vars).toEqual([{ slug: 'test-story' }]);
    } finally {
      await app.close();
    }
  });

  it('returns a written story’s image by its shape and alt text, never its storage path (D53)', async () => {
    const written = {
      ...story,
      primaryFormat: 'written',
      media: [],
      image: {
        path: 'internal/a.webp',
        width: 1200,
        height: 1600,
        alt: 'A sunrise',
      },
    };
    for (const [image, expected] of [
      [
        written.image,
        { url: null, width: 1200, height: 1600, alt: 'A sunrise' },
      ],
      // No alt text given: null, and clients show a neutral default.
      [
        { path: 'internal/b.webp', width: 800, height: 800 },
        { url: null, width: 800, height: 800, alt: null },
      ],
    ] as const) {
      const { app, url } = await boot(database([{ ...written, image }]).db);
      try {
        const body = await (await fetch(`${url}/v1/stories/test-story`)).json();
        expect(body).toMatchObject({
          primaryFormat: 'written',
          media: [],
          image: expected,
        });
        expect(JSON.stringify(body)).not.toContain('internal');
      } finally {
        await app.close();
      }
    }
  });

  it('signs a published video’s playback and thumbnail links when signing is on (D52)', async () => {
    const video = '2c3a0a8e-7d39-4f8e-9a51-0d6c1b4a9e11';
    const row = {
      ...story,
      media: [
        {
          format: 'video',
          width: 1080,
          height: 1920,
          bunnyVideoId: video,
          thumbnailPath: `${video}/thumbnail.jpg`,
        },
      ],
    };
    const { app, url } = await boot(database([row]).db, signing());
    try {
      const body = await signedBody(url);
      const [media] = body.media;
      const playback = new URL(media.playbackUrl);
      expect(playback.origin + playback.pathname).toBe(
        `https://player.mediadelivery.net/embed/786537/${video}`,
      );
      expect(playback.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
      expect(playback.searchParams.get('expires')).toBe(
        String(Date.UTC(2026, 9, 23, 17) / 1000),
      );
      const thumb = new URL(media.thumbnailUrl);
      expect(thumb.origin + thumb.pathname).toBe(
        `https://vz-test.b-cdn.net/${video}/thumbnail.jpg`,
      );
      expect(thumb.searchParams.get('token')).toMatch(/^HS256-/);
      expect(media.captionsUrl).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('signs a written story’s image on the images zone when signing is on (D52)', async () => {
    const row = {
      ...story,
      primaryFormat: 'written',
      media: [],
      image: { path: 'dev-seed/image-01.webp', width: 1200, height: 1600 },
    };
    const { app, url } = await boot(database([row]).db, signing());
    try {
      const body = await signedBody(url);
      const image = new URL(body.image.url);
      expect(image.origin + image.pathname).toBe(
        'https://images-test.b-cdn.net/dev-seed/image-01.webp',
      );
      expect(image.searchParams.get('token')).toMatch(/^HS256-/);
      expect(body.image).toMatchObject({
        width: 1200,
        height: 1600,
        alt: null,
      });
    } finally {
      await app.close();
    }
  });

  it('gives null links for media the read model has no ids for, or unsafe ones', async () => {
    const row = {
      ...story,
      media: [
        {
          format: 'video',
          bunnyVideoId: 'not-a-uuid',
          // Another video's thumbnail: never signed for this story.
          thumbnailPath: '229dbd44-d1a2-4044-be13-bee63c2a0cc1/thumbnail.jpg',
        },
      ],
      image: { path: '../elsewhere.webp', width: 10, height: 10 },
    };
    const { app, url } = await boot(database([row]).db, signing());
    try {
      const body = await signedBody(url);
      expect(body.media[0]).toMatchObject({
        playbackUrl: null,
        thumbnailUrl: null,
      });
      expect(body.image.url).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps the ETag within the hour and changes it when the links do', async () => {
    let now = NOW;
    const row = {
      ...story,
      image: { path: 'dev-seed/image-01.webp', width: 1200, height: 1600 },
    };
    const { app, url } = await boot(
      database([row]).db,
      signing(() => now),
    );
    try {
      const first = await fetch(`${url}/v1/stories/test-story`);
      const etag = first.headers.get('etag') as string;
      now = NOW + 30 * 60 * 1000; // 10:45, same hour
      const same = await fetch(`${url}/v1/stories/test-story`, {
        headers: { 'if-none-match': etag },
      });
      expect(same.status).toBe(304);
      now = NOW + 60 * 60 * 1000; // 11:15, new links
      const next = await fetch(`${url}/v1/stories/test-story`, {
        headers: { 'if-none-match': etag },
      });
      expect(next.status).toBe(200);
      expect(next.headers.get('etag')).not.toBe(etag);
    } finally {
      await app.close();
    }
  });

  it('answers 304 when If-None-Match still matches, and 200 when the representation changed', async () => {
    const rows = [story];
    const { app, url } = await boot(database(rows).db);
    try {
      const first = await fetch(`${url}/v1/stories/test-story`);
      const etag = first.headers.get('etag') as string;
      const again = await fetch(`${url}/v1/stories/test-story`, {
        headers: { 'if-none-match': `W/"other", ${etag}` },
      });
      expect(again.status).toBe(304);
      expect(again.headers.get('etag')).toBe(etag);
      // Same story version, but a tag was renamed: the body differs, so the ETag does.
      rows[0] = {
        ...story,
        tags: [
          { slug: 'doubt', name: 'Questions', category: 'journey', version: 2 },
        ],
      } as never;
      const renamed = await fetch(`${url}/v1/stories/test-story`, {
        headers: { 'if-none-match': etag },
      });
      expect(renamed.status).toBe(200);
      expect(renamed.headers.get('etag')).not.toBe(etag);
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

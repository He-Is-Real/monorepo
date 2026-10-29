import type { INestApplication } from '@nestjs/common';
import { TestDatabase } from '@heisreal/database/integration-testing';
import { MediaUrls, mediaConfigFromEnv } from '@heisreal/story-cards';
import { siteVideosFromEnv } from '../src/app/site-videos/site-videos.controller';
import { startPublicRead } from './app';

/**
 * The founder's videos on About and Next Steps: api-public-read signs a player link for a site video only by
 * one of its known keys, and only when that key has a video configured (SITE_VIDEO_*, from
 * OpenTofu). Anything else is a 404, so no visitor can get an arbitrary video signed.
 */
const FOUNDER = '0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f';
const NEXT_STEPS = '7c2e9a14-5b3d-4f6e-a8c1-2d3e4f5a6b7c';
const LIBRARY = '786537';
const NOW = Date.UTC(2026, 9, 29, 10, 15);

const signing = new MediaUrls(
  {
    config: mediaConfigFromEnv({
      BUNNY_STREAM_LIBRARY_ID: LIBRARY,
      BUNNY_STREAM_CDN_HOST: 'vz-test.b-cdn.net',
      BUNNY_IMAGES_CDN_HOST: 'images-test.b-cdn.net',
      BUNNY_STREAM_TOKEN_KEY_SECRET: 'bunny-stream-token-key',
      BUNNY_IMAGES_TOKEN_KEY_SECRET: 'bunny-images-token-key',
    }) as NonNullable<ReturnType<typeof mediaConfigFromEnv>>,
    streamKey: 'stream-key',
    imagesKey: 'images-key',
  },
  () => NOW,
);

describe('GET /v1/site-videos/{key}', () => {
  let t: TestDatabase;
  const apps: INestApplication[] = [];

  const start = async (
    media: MediaUrls,
    env: Record<string, string | undefined>,
  ) => {
    const { app, url } = await startPublicRead(t, media, undefined, {
      siteVideos: siteVideosFromEnv(env),
    });
    apps.push(app);
    return url;
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await t?.close();
  });

  it('signs the configured founder video, expiring, never stored by shared caches in dev', async () => {
    const url = await start(signing, { SITE_VIDEO_FOUNDER_INTRO: FOUNDER });
    const res = await fetch(`${url}/v1/site-videos/founder-intro`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    const body = (await res.json()) as {
      key: string;
      playbackUrl: string;
      expiresAt: string;
    };
    const player = new URL(body.playbackUrl);
    expect(`${player.origin}${player.pathname}`).toBe(
      `https://player.mediadelivery.net/embed/${LIBRARY}/${FOUNDER}`,
    );
    expect(player.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
    const expires = Number(player.searchParams.get('expires'));
    // 6–7 hours from now, as the stories' links (D52), and said in the body.
    expect(expires * 1000 - NOW).toBeGreaterThanOrEqual(6 * 3600_000);
    expect(expires * 1000 - NOW).toBeLessThanOrEqual(7 * 3600_000);
    expect(body).toEqual({
      key: 'founder-intro',
      playbackUrl: body.playbackUrl,
      expiresAt: new Date(expires * 1000).toISOString(),
    });

    const again = await fetch(`${url}/v1/site-videos/founder-intro`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);
  });

  it('signs each key’s own video: Next Steps beside the founder’s introduction', async () => {
    const url = await start(signing, {
      SITE_VIDEO_FOUNDER_INTRO: FOUNDER,
      SITE_VIDEO_NEXT_STEPS: NEXT_STEPS,
    });
    for (const [key, guid] of [
      ['next-steps', NEXT_STEPS],
      ['founder-intro', FOUNDER],
    ]) {
      const res = await fetch(`${url}/v1/site-videos/${key}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { key: string; playbackUrl: string };
      expect(body.key).toBe(key);
      expect(new URL(body.playbackUrl).pathname).toBe(
        `/embed/${LIBRARY}/${guid}`,
      );
    }
  });

  it('answers 404 for Next Steps when only the founder’s introduction is set', async () => {
    const url = await start(signing, { SITE_VIDEO_FOUNDER_INTRO: FOUNDER });
    const res = await fetch(`${url}/v1/site-videos/next-steps`);
    expect(res.status).toBe(404);
  });

  it.each([
    ['a key it doesn’t know', 'contact'],
    ['a video GUID instead of a key', FOUNDER],
    ['a key in another case', 'Founder-Intro'],
  ])('answers 404 for %s', async (_, key) => {
    const url = await start(signing, { SITE_VIDEO_FOUNDER_INTRO: FOUNDER });
    const res = await fetch(`${url}/v1/site-videos/${key}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('answers 404 when the key has no video configured, or signing is off', async () => {
    for (const url of [
      await start(signing, {}),
      await start(new MediaUrls(null), { SITE_VIDEO_FOUNDER_INTRO: FOUNDER }),
    ]) {
      const res = await fetch(`${url}/v1/site-videos/founder-intro`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not_found' });
    }
  });

  it('refuses query parameters', async () => {
    const url = await start(signing, { SITE_VIDEO_FOUNDER_INTRO: FOUNDER });
    const res = await fetch(
      `${url}/v1/site-videos/founder-intro?video=${FOUNDER}`,
    );
    expect(res.status).toBe(400);
  });

  it('won’t start with a malformed video id', () => {
    expect(() =>
      siteVideosFromEnv({ SITE_VIDEO_FOUNDER_INTRO: '../../etc' }),
    ).toThrow(/SITE_VIDEO_FOUNDER_INTRO/);
    expect(() =>
      siteVideosFromEnv({ SITE_VIDEO_NEXT_STEPS: 'not-a-guid' }),
    ).toThrow(/SITE_VIDEO_NEXT_STEPS/);
  });
});

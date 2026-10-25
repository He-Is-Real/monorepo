/// <reference lib="dom" />
// DOM types: playerControls runs inside the player frame.
import {
  type APIRequestContext,
  expect,
  type Frame,
  type Page,
  test,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATASET } from '../src/app/dataset';
import { imagePath } from '../src/app/media';
import { API_URL, WEB_URL } from './playwright.config';

// D52 on dev: published stories carry signed, expiring Bunny links, and Bunny refuses the same
// links unsigned or tampered with (403), so unpublished media isn't reachable either. Needs the
// bunny root's token auth and api-public-read's signing on (api_public_read_media in the gcp
// root). We can't make a validly signed expired link without the key, so "expired" is checked
// as a moved expiry: the token binds it.
const story = (id: string) => {
  const s = DATASET.stories.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} in the dataset`);
  return s;
};
const VIDEO = story('seed_v01'); // approved, clip-01 (has a thumbnail)
const AUDIO = story('seed_a01'); // approved, clip-08
const WRITTEN = story('seed_w01'); // approved, image-01
const UNPUBLISHED_IMAGES = ['seed_w02', 'seed_w05'].map((id) => {
  const s = story(id);
  expect(s.status).not.toBe('approved');
  return imagePath(s.image!.file);
});

// Bunny's Stream zone refuses requests without a referrer (direct_url_file_access_blocked).
const headers = { referer: `${WEB_URL}/` };
const SIX_HOURS = 6 * 60 * 60;

async function publicStory(request: APIRequestContext, slug: string) {
  const res = await request.get(`${API_URL}/v1/stories/${slug}`);
  expect(res.status()).toBe(200);
  return res.json();
}

function expectFreshExpiry(url: URL) {
  const left = Number(url.searchParams.get('expires')) - Date.now() / 1000;
  expect(left).toBeGreaterThanOrEqual(SIX_HOURS - 120); // clock skew
  expect(left).toBeLessThanOrEqual(SIX_HOURS + 3600 + 120);
}

const unsigned = (url: URL) => {
  const u = new URL(url);
  u.searchParams.delete('token');
  u.searchParams.delete('expires');
  return u.toString();
};
const movedExpiry = (url: URL) => {
  const u = new URL(url);
  u.searchParams.set(
    'expires',
    String(Number(u.searchParams.get('expires')) - 3600),
  );
  return u.toString();
};

async function expectStatus(
  request: APIRequestContext,
  url: string,
  status: number,
) {
  const res = await request.get(url, { headers, maxRedirects: 0 });
  expect(res.status(), url.replace(/token=[^&]+/, 'token=…')).toBe(status);
}

test('a published video’s player and thumbnail links are signed, and only signed ones load', async ({
  request,
}) => {
  const body = await publicStory(request, VIDEO.slug);
  const player = new URL(body.media[0].playbackUrl);
  expect(player.origin).toBe('https://player.mediadelivery.net');
  expect(player.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
  expectFreshExpiry(player);
  await expectStatus(request, player.toString(), 200);
  await expectStatus(request, unsigned(player), 403);
  await expectStatus(request, movedExpiry(player), 403);

  const thumb = new URL(body.media[0].thumbnailUrl);
  expect(thumb.searchParams.get('token')).toMatch(/^HS256-/);
  expectFreshExpiry(thumb);
  await expectStatus(request, thumb.toString(), 200);
  await expectStatus(request, unsigned(thumb), 403);
  await expectStatus(request, movedExpiry(thumb), 403);

  // Stream's files (HLS) refuse unsigned requests too (CDN token auth).
  const videoId = player.pathname.split('/').pop();
  await expectStatus(request, `${thumb.origin}/${videoId}/playlist.m3u8`, 403);
});

test('a published audio story’s player link is signed', async ({ request }) => {
  const body = await publicStory(request, AUDIO.slug);
  const player = new URL(body.media[0].playbackUrl);
  expect(player.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
  await expectStatus(request, player.toString(), 200);
  await expectStatus(request, unsigned(player), 403);
});

// Audio stories without a personal picture show the site's default audio thumbnail
// (apps/dev-seed/media), set on Bunny by upload.ts; Bunny serves it unchanged.
const DEFAULT_AUDIO_THUMBNAIL = createHash('sha256')
  .update(readFileSync(join(__dirname, '../media/default-audio-thumbnail.jpg')))
  .digest('hex');

test('a published audio story’s thumbnail is the site’s default, signed, and its size is the story’s', async ({
  request,
  page,
}) => {
  const body = await publicStory(request, AUDIO.slug);
  const videoId = new URL(body.media[0].playbackUrl).pathname.split('/').pop();
  const thumb = new URL(body.media[0].thumbnailUrl);
  expect(thumb.pathname).toMatch(
    new RegExp(`^/${videoId}/thumbnail_[0-9a-f]+\\.jpg$`),
  );
  expect(thumb.searchParams.get('token')).toMatch(/^HS256-/);
  expectFreshExpiry(thumb);
  const res = await request.get(thumb.toString(), { headers });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^image\//);
  expect(
    createHash('sha256')
      .update(await res.body())
      .digest('hex'),
  ).toBe(DEFAULT_AUDIO_THUMBNAIL);
  await expectStatus(request, unsigned(thumb), 403);

  // Joel, 2026-10-24: an audio story's width and height are its thumbnail's real pixel size.
  await page.goto(thumb.toString(), { referer: headers.referer });
  const real = await page.evaluate(() => {
    const img = document.images[0];
    return [img?.naturalWidth, img?.naturalHeight];
  });
  expect([body.media[0].width, body.media[0].height]).toEqual(real);
  const card = (
    await (
      await request.get(`${API_URL}/v1/stories?format=audio&limit=50`)
    ).json()
  ).data.find((c: { slug: string }) => c.slug === AUDIO.slug);
  expect([card.thumbnailWidth, card.thumbnailHeight]).toEqual(real);
});

test('a published image link is signed; unsigned, tampered and unpublished images are refused', async ({
  request,
}) => {
  const body = await publicStory(request, WRITTEN.slug);
  const image = new URL(body.image.url);
  expect(image.pathname).toBe(`/${imagePath(WRITTEN.image!.file)}`);
  expect(image.searchParams.get('token')).toMatch(/^HS256-/);
  expectFreshExpiry(image);
  await expectStatus(request, image.toString(), 200);
  await expectStatus(request, unsigned(image), 403);
  await expectStatus(request, movedExpiry(image), 403);
  for (const path of UNPUBLISHED_IMAGES) {
    await expectStatus(request, `${image.origin}/${path}`, 403);
  }
});

test('the story page plays the signed video in Bunny’s player, without autoplay', async ({
  page,
}) => {
  const playerLoaded = page.waitForResponse((r) =>
    r.url().startsWith('https://player.mediadelivery.net/embed/'),
  );
  await page.goto(`/stories/${VIDEO.slug}`);
  const frame = page.locator(`iframe[title="Video: ${VIDEO.title}"]`);
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute('src')).toContain('autoplay=false');
  expect((await playerLoaded).status()).toBe(200);

  // Pressing play fetches the HLS playlist, which the player signs itself (CDN token auth).
  const playlist = page.waitForResponse(
    (r) => /\.b-cdn\.net\/.*\.m3u8/.test(r.url()),
    { timeout: 30_000 },
  );
  await page
    .frameLocator(`iframe[title="Video: ${VIDEO.title}"]`)
    .getByRole('button', { name: /play/i })
    .first()
    .click();
  expect((await playlist).status()).toBe(200);
});

// The privacy page's storage list (web /privacy#cookies): Bunny's player stores nothing during
// default playback, and keeps the visitor's own playback preferences (speed, volume, mute) in
// its frame's localStorage only once they change one: strictly necessary, like our theme.
test('Bunny’s player stores nothing until the visitor changes a setting, then only that preference', async ({
  page,
}) => {
  const title = `Video: ${VIDEO.title}`;
  await page.goto(`/stories/${VIDEO.slug}`);
  const player = page.frameLocator(`iframe[title="${title}"]`);
  const playlist = page.waitForResponse(
    (r) => /\.b-cdn\.net\/.*\.m3u8/.test(r.url()),
    { timeout: 30_000 },
  );
  await player.getByRole('button', { name: /play/i }).first().click();
  expect((await playlist).status()).toBe(200);

  const frame = () => {
    const f = page
      .frames()
      .find((x) => x.url().startsWith('https://player.mediadelivery.net/'));
    if (!f) throw new Error('no Bunny player frame');
    return f;
  };
  const stored = () =>
    frame().evaluate(() => ({
      local: Object.fromEntries(
        Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]),
      ),
      session: Object.keys(sessionStorage),
      cookies: document.cookie,
    }));
  expect(await stored()).toEqual({ local: {}, session: [], cookies: '' });

  await player.getByRole('button', { name: 'settings' }).click();
  await player.getByRole('menuitem', { name: 'Playback rate' }).click();
  await player.getByRole('menuitemradio', { name: '1.5x' }).click();
  await expect
    .poll(async () => {
      const { local } = await stored();
      return Object.entries(local).map(([k, v]) => [
        k.replace(/\d+$/, '<library>'),
        JSON.parse(v ?? 'null'),
      ]);
    })
    .toEqual([['bunny_stream_settings_<library>', { speed: 1.5 }]]);
});

// Card playback: a browse card's play button asks web's server for the player link (a server
// action reading the story from api-public-read, D32), signed only then, and plays it in place.
test('a video card plays in place with a freshly signed Bunny embed link', async ({
  page,
  request,
}) => {
  await page.goto('/stories?format=video');
  const card = page.locator('main article').first();
  const slug = (await card.getByRole('link').getAttribute('href'))?.replace(
    '/stories/',
    '',
  );
  await card.getByRole('button', { name: /^Play / }).click();
  const frame = card.locator('iframe');
  await expect(frame).toBeVisible({ timeout: 30_000 });

  // It really plays, from that one click (Codex, #77): the media loads and its time advances.
  // Checked first, while the 12 s clip is still playing; the link checks below don't need it.
  const bunny = await playerFrame(page);
  const t1 = await expectPlaying(bunny);
  await expect
    .poll(() => mediaState(bunny).then((m) => m.time))
    .toBeGreaterThan(t1);
  await expect(page).toHaveURL(/\/stories\?format=video$/);

  const player = new URL((await frame.getAttribute('src')) ?? '');
  expect(player.origin).toBe('https://player.mediadelivery.net');
  expect(player.pathname).toMatch(/^\/embed\/\d+\/[0-9a-f-]{36}$/);
  expect(player.searchParams.get('token')).toMatch(/^[0-9a-f]{64}$/);
  expect(player.searchParams.get('autoplay')).toBe('true');
  expectFreshExpiry(player);
  // The same video as the story's own page, and Bunny accepts the link.
  const body = await publicStory(request, slug ?? '');
  expect(player.pathname).toBe(new URL(body.media[0].playbackUrl).pathname);
  await expectStatus(request, player.toString(), 200);
});

/** The player's media element (inside Bunny's <bunny-stream-video>): loaded, playing, time. */
function mediaState(frame: Frame) {
  return frame.evaluate(() => {
    const host = document.querySelector('bunny-stream-video');
    const v = (host?.shadowRoot?.querySelector('video') ??
      document.querySelector('video')) as HTMLVideoElement | null;
    return {
      ready: v?.readyState ?? 0,
      paused: v?.paused ?? true,
      time: v?.currentTime ?? 0,
    };
  });
}

/** Waits until the media has loaded and played past half a second; returns its time. */
async function expectPlaying(frame: Frame) {
  await expect
    .poll(() => mediaState(frame), { timeout: 30_000 })
    .toMatchObject({ ready: expect.any(Number), paused: false });
  await expect
    .poll(() => mediaState(frame).then((m) => m.time), { timeout: 30_000 })
    .toBeGreaterThan(0.5);
  const m = await mediaState(frame);
  expect(m.ready).toBeGreaterThanOrEqual(2); // HAVE_CURRENT_DATA
  return m.time;
}

/**
 * Every visible control in the Bunny Player's bars (its media-chrome buttons and the seek bar):
 * size and whether it lies inside the player. The web e2e stub can't prove this: only the real
 * player, with the library's custom head CSS (modules/bunny/player-head.html), can.
 */
async function playerControls(frame: Frame) {
  return frame.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        'media-control-bar *, bunny-media-control-bar *, bunny-media-time-range',
      ),
    )
      .filter((el) => /-button$|-time-range$/i.test(el.tagName))
      .filter((el) => {
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          r.width > 0
        );
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name: el.tagName.toLowerCase(),
          width: Math.round(r.width),
          height: Math.round(r.height),
          inside:
            r.left >= 0 &&
            r.top >= 0 &&
            r.right <= window.innerWidth + 0.5 &&
            r.bottom <= window.innerHeight + 0.5,
        };
      }),
  );
}

async function playerFrame(page: Page) {
  // Bunny's embed can take several seconds to load (a 7 s load was seen; no retries on main).
  await expect
    .poll(
      () => page.frames().some((f) => f.url().includes('mediadelivery.net')),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.frames().find((f) => f.url().includes('mediadelivery.net'))!;
}

test.describe('on a 320 px phone', () => {
  test.use({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
  });

  // Codex, #77: an audio card's 2:1 box is 144 px tall here; Bunny's controls need about 176 px,
  // so the playing card's player is at least 184 px tall (web's PLAYER_MIN_HEIGHT).
  test('an audio card plays in place with every control at least 44 × 44 px inside it', async ({
    page,
  }) => {
    await page.goto('/stories?format=audio');
    const card = page.locator('main article').first();
    await card.getByRole('button', { name: /^Play / }).tap();
    await expect(card.locator('iframe')).toBeVisible({ timeout: 30_000 });
    const frame = await playerFrame(page);
    await expectPlaying(frame);
    await expect
      .poll(async () => (await playerControls(frame)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(4);
    for (const c of await playerControls(frame)) {
      expect(c.inside, `${c.name} lies inside the player`).toBe(true);
      expect(c.height, `${c.name} height`).toBeGreaterThanOrEqual(44);
      if (c.name.endsWith('-button')) {
        expect(c.width, `${c.name} width`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('the real player’s controls are at least 44 × 44 px and fit inside it (AGENTS.md)', async ({
    page,
  }) => {
    await page.goto(`/stories/${VIDEO.slug}`);
    const title = `Video: ${VIDEO.title}`;
    await expect(page.locator(`iframe[title="${title}"]`)).toBeVisible();
    // The large play button over the picture is a round target of at least 44 px (the 44 px
    // rule for the bar's buttons once squashed it into an oval).
    const largePlay = page
      .frameLocator(`iframe[title="${title}"]`)
      .locator('media-play-button.large-play');
    await largePlay.waitFor();
    const box = await largePlay.boundingBox();
    expect(box?.width, 'large play width').toBeGreaterThanOrEqual(44);
    expect(box?.height, 'large play is round').toBeCloseTo(box?.width ?? 0, 0);
    // Start playback so the control bar shows (it hides before the first play).
    await largePlay.tap();
    const frame = await playerFrame(page);
    await expect
      .poll(async () => (await playerControls(frame)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(4);
    const controls = await playerControls(frame);
    for (const c of controls) {
      expect(c.inside, `${c.name} lies inside the player`).toBe(true);
      expect(c.height, `${c.name} height`).toBeGreaterThanOrEqual(44);
      if (c.name.endsWith('-button')) {
        expect(c.width, `${c.name} width`).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

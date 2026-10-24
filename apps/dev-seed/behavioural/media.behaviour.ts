/// <reference lib="dom" />
// DOM types: playerControls runs inside the player frame.
import {
  type APIRequestContext,
  expect,
  type Frame,
  type Page,
  test,
} from '@playwright/test';
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
  await expect
    .poll(() =>
      page.frames().some((f) => f.url().includes('mediadelivery.net')),
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

  test('the real player’s controls are at least 44 × 44 px and fit inside it (AGENTS.md)', async ({
    page,
  }) => {
    await page.goto(`/stories/${VIDEO.slug}`);
    const title = `Video: ${VIDEO.title}`;
    await expect(page.locator(`iframe[title="${title}"]`)).toBeVisible();
    // Start playback so the control bar shows (it hides before the first play).
    await page
      .frameLocator(`iframe[title="${title}"]`)
      .getByRole('button', { name: /play/i })
      .first()
      .tap();
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

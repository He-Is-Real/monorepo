import { type APIRequestContext, expect, test } from '@playwright/test';
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

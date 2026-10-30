import { expect, type Page, test } from '@playwright/test';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { execFileSync } from 'node:child_process';
import BUNNY_MEDIA from '../src/app/bunny-media.json';
import { DEV_PROJECT } from '../src/app/config';
import { API_USER_URL } from './playwright.config';

// A video story end to end on dev (M2 plan PR 7): a Clerk test user shares a real 2-second clip
// at /share, which api-user creates at Bunny Stream and signs, the browser uploads by TUS and
// submit checks; the story is then pending with that video, titled with the story id only (D69).
// Developer-run, like the upload spike (`pnpm nx run dev-seed:upload-spike`): it reads the Stream
// library key to check and delete the video (D50), which CI's behavioural job can't. Needs
// ffmpeg with libx264, your gcloud ADC, and this PR's api-user deployed with uploads on.
//
// The test user (a `+clerk_test` address: Clerk's dev instance takes the fixed code 424242) is
// signed up on first use and ticks the consent boxes a person would. It can submit one story a
// week unless dev-seed marks it trusted (the dataset's testAccounts, once its Clerk id is known).
// What's left behind: the pending story in dev's database (dummy data); the video is deleted,
// and a Stream video has no storage folder to remove (the empty-folder finding is the images
// zone's, handled by its own deletions).
const TEST_USER = 'upload-behaviour+clerk_test@example.com';
const TEST_CODE = '424242';
const STREAM_API = `https://video.bunnycdn.com/library/${BUNNY_MEDIA.libraryId}`;

let libraryKey: string;

test.beforeAll(async () => {
  const [version] = await new SecretManagerServiceClient().accessSecretVersion({
    name: `projects/${DEV_PROJECT}/secrets/bunny-stream-api-key/versions/latest`,
  });
  libraryKey = version.payload?.data?.toString() ?? '';
  expect(libraryKey).not.toBe('');
});

const stream = (path: string, method = 'GET') =>
  fetch(`${STREAM_API}${path}`, {
    method,
    headers: { AccessKey: libraryKey, Accept: 'application/json' },
  });

async function signIn(page: Page) {
  await page.goto('/share');
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await page.getByLabel(/email address/i).fill(TEST_USER);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel(/verification code/i)).toBeVisible();
  await page.keyboard.type(TEST_CODE);
  // First use: the sign-up consent step (D73), ticked as a person would.
  await page.waitForURL(/\/(share|consent\/sign-up)/, { timeout: 45_000 });
  if (page.url().includes('/consent/sign-up')) {
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: /continue|agree/i }).click();
    await page.waitForURL(/\/share/, { timeout: 45_000 });
  }
}

test('a test user shares a 2-second video: it reaches Bunny, and the story is pending with it', async ({
  page,
}, info) => {
  test.setTimeout(6 * 60_000);
  const clip = info.outputPath('story.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=12:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-ac',
    '1',
    '-shortest',
    '-movflags',
    '+faststart',
    clip,
  ]);
  let videoId: string | undefined;
  try {
    await signIn(page);
    await page
      .locator('label')
      .filter({ hasText: 'Upload a video file' })
      .click();
    await page.getByRole('button', { name: 'Share my video' }).click();
    const consent = page.getByRole('button', { name: 'I agree, continue' });
    if (await consent.isVisible().catch(() => false)) {
      await page
        .locator('label')
        .filter({ hasText: /storing and processing my story/ })
        .click();
      await consent.click();
    }
    await page.getByRole('button', { name: 'Upload my video' }).click();
    await page.getByLabel('Title').fill('Behavioural upload test');
    const target = page.waitForResponse(
      (r) =>
        r.url().startsWith(API_USER_URL) && r.url().endsWith('/upload-url'),
    );
    await page.getByLabel('Choose a file').setInputFiles(clip);
    const signed = (await (await target).json()) as {
      id: string;
      headers: { VideoId: string };
    };
    videoId = signed.headers.VideoId;
    await expect(page.getByText(/^Uploaded: story\.mp4/)).toBeVisible({
      timeout: 60_000,
    });

    // Bunny has the video, titled with the story id only (D69).
    const video = (await (await stream(`/videos/${videoId}`)).json()) as {
      title: string;
    };
    expect(video.title).toBe(signed.id);

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page
      .locator('label')
      .filter({ has: page.locator('input[type=checkbox]') })
      .first()
      .click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const publish = page
      .locator('label')
      .filter({ hasText: /Publish my story/ });
    if (await publish.isVisible().catch(() => false)) await publish.click();
    // Submit waits for Bunny to read the file's length (media_processing): try until it has.
    await expect(async () => {
      await page.getByRole('button', { name: 'Submit for review' }).click();
      await expect(
        page.getByRole('heading', { name: 'Thank you for sharing your story' }),
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 3 * 60_000, intervals: [10_000] });

    // The story is pending, with that video, as api-user has it.
    const story = await page.evaluate(
      async ({ api, id }) => {
        const token = await (
          window as unknown as {
            Clerk: { session: { getToken(): Promise<string> } };
          }
        ).Clerk.session.getToken();
        const res = await fetch(`${api}/v1/account/stories/${id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return res.json();
      },
      { api: API_USER_URL, id: signed.id },
    );
    expect(story).toMatchObject({
      status: 'pending',
      primaryFormat: 'video',
      media: [{ format: 'video' }],
    });
  } finally {
    // D50: the video goes, pass or fail.
    if (videoId) {
      const res = await stream(`/videos/${videoId}`, 'DELETE');
      expect.soft([200, 404]).toContain(res.status);
    }
  }
  if (videoId) expect((await stream(`/videos/${videoId}`)).status).toBe(404);
});

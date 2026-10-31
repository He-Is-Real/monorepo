import { expect, type Locator, type Page, test } from '@playwright/test';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { execFileSync } from 'node:child_process';
import BUNNY_MEDIA from '../src/app/bunny-media.json';
import { DEV_PROJECT } from '../src/app/config';
import { API_USER_URL } from './playwright.config';

// A video story end to end on dev (M2 plan PR 7): a Clerk test user shares a real 2-second clip
// at /share, which api-user creates at Bunny Stream and signs, the browser uploads by TUS and
// submit checks; the story is then pending with that video, titled with the story id only (D69).
// Developer-run, like the upload spike (`pnpm nx run dev-seed:upload-spike`): it reads the Stream
// library key to check the video (D50), which CI's behavioural job can't. Needs ffmpeg with
// libx264 and your gcloud ADC.
//
// The test user (a `+clerk_test` address: Clerk's dev instance takes the fixed code 424242) is
// signed up on first use and ticks the consent boxes a person would: the sign-up step (D73) the
// first time, then the testimony and publishing boxes on /share the first time it shares. It's
// a trusted submitter on dev (dev-seed's testAccounts, D112), so the weekly limit doesn't stop a
// second run; until a reset has marked it, it may submit once a week, and the test says so
// before uploading anything.
// What's left behind: nothing of the story. The test withdraws and deletes it as the person
// would (D71), which deletes its video at Bunny, and deletes the video itself if anything failed
// before that. A Stream video has no storage folder to remove (the empty-folder finding is the
// images zone's). The consents it gave stay in the append-only ledger, as anyone's would.
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

/** A call to api-user with the signed-in person's Clerk session, as web makes it. */
function asPerson(
  page: Page,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  return page.evaluate(
    async ({ url, init }) => {
      const token = await (
        window as unknown as {
          Clerk: { session: { getToken(): Promise<string> } };
        }
      ).Clerk.session.getToken();
      const res = await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { url: `${API_USER_URL}${path}`, init },
  );
}

/**
 * Ticks a consent box as a person does, on its label (the 44 px target; the native box is
 * visually hidden).
 */
async function tick(box: Locator) {
  await box.locator('xpath=ancestor::label[1]').click();
  await expect(box).toBeChecked();
}

/**
 * Signs in from /share and comes back to it. The header's account bootstrap (GET /v1/account)
 * says whether the sign-up consent is still to give: if so, the header takes the person to the
 * sign-up step and back (D73), and they tick its boxes. Either way the share flow then loads.
 */
async function signIn(page: Page) {
  await page.goto('/share');
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Sign in', exact: true })
    .click();
  await page.getByLabel(/email address/i).fill(TEST_USER);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel(/verification code/i)).toBeVisible();
  const bootstrap = page.waitForResponse(
    (r) =>
      new URL(r.url()).origin === new URL(API_USER_URL).origin &&
      new URL(r.url()).pathname === '/v1/account' &&
      r.request().method() === 'GET',
    { timeout: 45_000 },
  );
  await page.keyboard.type(TEST_CODE);
  const account = (await (await bootstrap).json()) as {
    signupConsent: { accepted: boolean };
  };
  if (!account.signupConsent.accepted) {
    await expect(page).toHaveURL(/\/consent\/sign-up\?redirect_url=%2Fshare$/, {
      timeout: 45_000,
    });
    for (const box of await page.getByRole('main').getByRole('checkbox').all())
      await tick(box);
    await page.getByRole('button', { name: 'Agree and continue' }).click();
  }
  await expect(page).toHaveURL(/\/share$/, { timeout: 45_000 });
  await expect(
    page.getByRole('heading', { name: 'How would you like to share?' }),
  ).toBeVisible({ timeout: 45_000 });
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
  let storyId: string | undefined;
  let videoId: string | undefined;
  try {
    await signIn(page);
    // The test needs a submission to spend: say so plainly, before anything is uploaded.
    const limits = await asPerson(page, '/v1/account/limits');
    expect(limits.status).toBe(200);
    expect(
      limits.body.submissions.nextAvailableAt,
      `${TEST_USER} has used its weekly submissions: it isn't a trusted submitter on dev yet (dev-seed's testAccounts, then "Reset dev data")`,
    ).toBeNull();

    await page.getByText('Upload a video file').click();
    // Which steps this person sees: "Your data" only until they've agreed to the testimony
    // form in force (D67).
    const askTestimony = await page
      .getByRole('navigation', { name: 'Steps' })
      .getByText(/Your data/)
      .count();
    await page.getByRole('button', { name: 'Share my video' }).click();
    if (askTestimony) {
      await expect(
        page.getByRole('heading', { name: 'Your story and your data' }),
      ).toBeVisible();
      await tick(page.getByRole('main').getByRole('checkbox'));
      await page.getByRole('button', { name: 'I agree, continue' }).click();
    }
    await expect(
      page.getByRole('heading', { name: 'Prepare your story' }),
    ).toBeVisible();
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
    storyId = signed.id;
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
    await expect(
      page.getByRole('heading', { name: 'Add some details' }),
    ).toBeVisible();
    // One theme (at least one is needed).
    await tick(page.getByRole('main').getByRole('checkbox').first());
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Review and submit' }),
    ).toBeVisible();
    // The publishing box, until this person has agreed to it once.
    const publish = page
      .locator('[data-grant="publish"]')
      .getByRole('checkbox');
    if (await publish.count()) await tick(publish);

    // Submit takes the video once Bunny has read its length (otherwise 409 media_processing,
    // "try again in a minute"), so wait for Bunny to have it, then submit once.
    await expect
      .poll(
        async () =>
          (
            (await (await stream(`/videos/${videoId}`)).json()) as {
              length: number;
            }
          ).length,
        { timeout: 3 * 60_000, intervals: [5_000] },
      )
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(
      page.getByRole('heading', { name: 'Thank you for sharing your story' }),
    ).toBeVisible({ timeout: 30_000 });

    // The story is pending, with that video, as api-user has it.
    const story = await asPerson(page, `/v1/account/stories/${storyId}`);
    expect(story.body).toMatchObject({
      status: 'pending',
      primaryFormat: 'video',
      media: [{ format: 'video' }],
    });
  } finally {
    // D50: nothing stays, pass or fail. As the person would: withdraw it if it was submitted,
    // then delete it, which deletes its video at Bunny (D71). The video goes directly too, in
    // case the story never got it or the delete failed.
    if (storyId) {
      const id = encodeURIComponent(storyId);
      let mine = await asPerson(page, `/v1/account/stories/${id}`);
      if (mine.status === 200 && mine.body.status === 'pending') {
        const withdrawn = await asPerson(page, `/v1/stories/${id}/withdraw`, {
          method: 'POST',
          headers: { 'if-match': `"${mine.body.version}"` },
        });
        expect.soft(withdrawn.status, 'withdraw the story').toBe(200);
        mine = await asPerson(page, `/v1/account/stories/${id}`);
      }
      if (mine.status === 200) {
        const deleted = await asPerson(page, `/v1/stories/${id}`, {
          method: 'DELETE',
          headers: { 'if-match': `"${mine.body.version}"` },
        });
        expect.soft(deleted.status, 'delete the story').toBe(204);
      }
      expect
        .soft(
          (await asPerson(page, `/v1/account/stories/${id}`)).status,
          'the story is gone',
        )
        .toBe(404);
    }
    if (videoId) {
      const res = await stream(`/videos/${videoId}`, 'DELETE');
      expect.soft([200, 404], 'delete the video').toContain(res.status);
    }
  }
  if (videoId) expect((await stream(`/videos/${videoId}`)).status).toBe(404);
});

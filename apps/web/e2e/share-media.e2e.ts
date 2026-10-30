import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow, shots } from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// Video and audio stories (M2 plan PR 7) on /share, against the stub api-user and its stand-in
// for Bunny Stream's TUS server (stub-api-user.mjs; its answers are checked against api-user.yaml
// in contract.e2e.ts). The real RequestUpload and its database rules are
// apps/api-user/integration/uploads.int-spec.ts and libs/database/integration/uploads.int-spec.ts;
// a real upload to Bunny is the dev behavioural suite's. Each test is its own person (T4).

const SHARE = `${WEB_SIGNED_IN_URL}/share`;
const ART9 = /storing and processing my story/;
const PUBLISH = /Publish my story on heisreal\.today/;

interface Video {
  id: string;
  story: string;
  length: number | null;
  received: number;
  done: boolean;
  deleted: boolean;
}

async function person(
  page: Page,
  request: APIRequestContext,
  settings: Record<string, number> = {},
) {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: {
      signupAccepted: true,
      granted: ['age_18plus', 'account_data'],
      settings,
    },
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  const auth = { authorization: `Bearer ${fixtureToken(id)}` };
  return {
    /** What the TUS server does with the next PATCHes. */
    tus: async (set: { fail?: number; hold?: boolean }) =>
      expect(
        (
          await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}/tus`, {
            data: set,
          })
        ).status(),
      ).toBe(204),
    /** RequestUpload calls made, and what reached each video. */
    uploads: async () =>
      (await (
        await request.get(`${STUB_USER_URL}/__e2e/sessions/${id}/uploads`)
      ).json()) as { requests: number; videos: Video[] },
    /** Another tab: a merge patch at the version it read. */
    editElsewhere: async (id: string, version: number, patch: object) =>
      expect(
        (
          await request.patch(`${STUB_USER_URL}/v1/stories/${id}`, {
            headers: {
              ...auth,
              'content-type': 'application/merge-patch+json',
              'if-match': `"${version}"`,
            },
            data: patch,
          })
        ).status(),
      ).toBe(200),
    stories: async () =>
      (
        await (
          await request.get(`${STUB_USER_URL}/v1/account/stories`, {
            headers: auth,
          })
        ).json()
      ).data as {
        id: string;
        status: string;
        description: string;
        primaryFormat: string;
        media: unknown[];
      }[],
  };
}

const step = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 2, name })).toBeFocused();

/** Choose → consent → Prepare → the upload step, as a new video (or audio) story. */
async function toUpload(page: Page, format: 'Video' | 'Audio' = 'Video') {
  await page.goto(SHARE);
  const noun = format === 'Video' ? 'video' : 'audio';
  await page
    .locator('label')
    .filter({
      hasText: `Upload a${format === 'Audio' ? 'n audio' : ' video'} file`,
    })
    .click();
  await page.getByRole('button', { name: `Share my ${noun}` }).click();
  await step(page, 'Your story and your data');
  await page.locator('label').filter({ hasText: ART9 }).click();
  await page.getByRole('button', { name: 'I agree, continue' }).click();
  await step(page, 'Prepare your story');
  const file = format === 'Video' ? 'video' : 'audio file';
  await page.getByRole('button', { name: `Upload my ${file}` }).click();
  await step(page, `Upload your ${file}`);
}

/** A file on disk (so a reload can choose the very same one again: same name, size, date). */
function clip(path: string, bytes = 256 * 1024) {
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

const phase = (page: Page) => page.locator('[data-upload-phase]');
/** The page's alert saying this (Next.js keeps an empty route announcer alert too). */
const alert = (page: Page, text: string) =>
  page.getByRole('alert').filter({ hasText: text });

test('the upload step fits every device, and a video story goes all the way to “waiting for review”', async ({
  page,
  request,
}, info) => {
  const me = await person(page, request);
  await toUpload(page);
  const fits = async (name: string) => {
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
    await shots(page, info.project.name, 'light', `share-${name}`, {
      signedIn: true,
    });
  };
  await expect(
    page.getByText(/MP4, MOV or WebM, up to 4 GB and 15 minutes/),
  ).toBeVisible();
  await fits('upload');
  await page.getByLabel('Title').fill('Twenty years of searching');
  await page
    .getByLabel('Choose a file')
    .setInputFiles(clip(info.outputPath('clip.mp4')));
  await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
  await expect(phase(page)).toHaveAttribute('data-upload-phase', 'done');
  await fits('upload-done');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await step(page, 'Add some details');
  await page.getByText('Hope', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await step(page, 'Review and submit');
  await expect(page.getByText('Your video', { exact: true })).toBeVisible();
  await page.locator('label').filter({ hasText: PUBLISH }).click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await step(page, 'Thank you for sharing your story');

  const [story] = await me.stories();
  expect(story).toMatchObject({
    status: 'pending',
    primaryFormat: 'video',
    media: [expect.anything()],
  });
  const { videos } = await me.uploads();
  expect(videos).toMatchObject([
    { story: story.id, length: 256 * 1024, received: 256 * 1024, done: true },
  ]);
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('shows the upload’s progress, and pauses and resumes it', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    await me.tus({ hold: true });
    await page
      .getByLabel('Choose a file')
      .setInputFiles(clip(info.outputPath('clip.mp4')));
    const bar = page.getByRole('progressbar', { name: 'Uploading clip.mp4' });
    await expect(bar).toBeVisible();
    await expect(
      page.getByText(/uploaded\. Keep this page open/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText(/^Paused at \d+%/)).toBeVisible();
    // Continue isn't offered while the file is unfinished.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(alert(page, 'hasn’t finished uploading')).toBeVisible();
    await me.tus({ hold: false });
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { videos } = await me.uploads();
    expect(videos).toMatchObject([{ done: true, received: 256 * 1024 }]);
  });

  test('a failed upload keeps the draft and carries on when tried again', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    await me.tus({ fail: 1 });
    await page
      .getByLabel('Choose a file')
      .setInputFiles(clip(info.outputPath('clip.mp4')));
    await expect(alert(page, 'The upload stopped')).toBeVisible();
    expect(await me.stories()).toMatchObject([
      { status: 'draft', primaryFormat: 'video' },
    ]);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { requests, videos } = await me.uploads();
    // The same video: trying again carried on, it didn't start another.
    expect([requests, videos.length, videos[0].done]).toEqual([1, 1, true]);
  });

  test('cancelling stops the upload and keeps the draft to come back to', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    await me.tus({ hold: true });
    await page
      .getByLabel('Choose a file')
      .setInputFiles(clip(info.outputPath('clip.mp4')));
    await expect(page.getByRole('progressbar')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel upload' }).click();
    await expect(page.getByText(/^Upload cancelled\./)).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    expect((await me.uploads()).videos).toMatchObject([{ done: false }]);
    expect(await me.stories()).toMatchObject([{ status: 'draft' }]);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(alert(page, 'Choose your video to upload.')).toBeVisible();
  });

  test('another file replaces the first, dropped onto the page', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page, 'Audio');
    await expect(page.getByText(/MP3, M4A or WAV, up to 500 MB/)).toBeVisible();
    await page.getByLabel('Title').fill('My testimony, spoken');
    await page
      .getByLabel('Choose a file')
      .setInputFiles(clip(info.outputPath('first.mp3')));
    await expect(page.getByText(/^Uploaded: first\.mp3/)).toBeVisible();
    // Drag and drop the second one.
    const dropped = await page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.items.add(
        new File([new Uint8Array(1024)], 'second.m4a', { type: 'audio/mp4' }),
      );
      return t;
    });
    await page.dispatchEvent('[data-drop-zone]', 'drop', {
      dataTransfer: dropped,
    });
    await expect(page.getByText(/^Uploaded: second\.m4a/)).toBeVisible();
    const { videos } = await me.uploads();
    expect(videos.map((v) => ({ deleted: v.deleted, done: v.done }))).toEqual([
      { deleted: true, done: true },
      { deleted: false, done: true },
    ]);
    expect((await me.stories())[0].media).toHaveLength(1);
  });

  test('a file over the limit is refused before anything is uploaded', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request, { videoMaxBytes: 100_000 });
    await toUpload(page);
    await expect(page.getByText(/up to 98 KB/)).toBeVisible();
    await page.getByLabel('Title').fill('My video');
    await page
      .getByLabel('Choose a file')
      .setInputFiles(clip(info.outputPath('big.mp4'), 200_000));
    await expect(alert(page, 'The most you can upload is 98 KB')).toBeVisible();
    // A file of another kind is refused too.
    await page.getByLabel('Choose a file').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('words'),
    });
    await expect(alert(page, 'Choose an MP4, MOV or WebM file')).toBeVisible();
    expect(await me.uploads()).toEqual({ requests: 0, videos: [] });
  });

  test('after a reload, choosing the same file carries on with the same video', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    const path = clip(info.outputPath('clip.mp4'));
    await me.tus({ hold: true });
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(page).toHaveURL(/\/share\?draft=/);
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeVisible();
    await expect(
      page.getByText(/didn’t finish\. Choose the same file again/),
    ).toBeVisible();
    await me.tus({ hold: false });
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { requests, videos } = await me.uploads();
    expect([requests, videos.length, videos[0].done]).toEqual([1, 1, true]);
  });

  test('an upload request whose answer is lost carries on when the file is chosen again, with the same video (Codex #133, 2)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    const path = clip(info.outputPath('clip.mp4'));
    // The first request reaches api-user, which makes the video and moves the draft on a
    // version; its answer never arrives.
    let dropped = false;
    await page.route(
      `${STUB_USER_URL}/v1/stories/*/upload-url`,
      async (route) => {
        if (dropped) return route.fallback();
        dropped = true;
        await route.fetch();
        return route.abort('connectionreset');
      },
    );
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(alert(page, 'can’t reach our server')).toBeVisible();
    expect((await me.uploads()).videos).toHaveLength(1);

    // Choosing it again sends the same request (same key, version and body): the same video.
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { requests, videos } = await me.uploads();
    expect([requests, videos.length, videos[0].done]).toEqual([2, 1, true]);
    // And the draft carries on at the version that request made: the next edit saves.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    await page.locator('#story-description').fill('Saved after the replay');
    await expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'saved',
    );
    expect(await me.stories()).toMatchObject([
      { description: 'Saved after the replay', media: [{}] },
    ]);
  });

  test('an upload request answered without its link counts as no answer: the same file carries on with the same video (Codex #133 rounds 2 and 3)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    const path = clip(info.outputPath('clip.mp4'));
    // api-user makes the video and moves the draft on, but the browser gets an empty success,
    // one with an empty object, then the link without each of Bunny's four headers in turn.
    const empty: (string | ((h: Record<string, string>) => void))[] = [
      '',
      '{}',
      ...[
        'AuthorizationSignature',
        'AuthorizationExpire',
        'VideoId',
        'LibraryId',
      ].map((name) => (h: Record<string, string>) => delete h[name]),
    ];
    const tries = empty.length;
    await page.route(
      `${STUB_USER_URL}/v1/stories/*/upload-url`,
      async (route) => {
        const answer = empty.shift();
        if (answer === undefined) return route.fallback();
        const res = await route.fetch();
        if (typeof answer === 'string') {
          return route.fulfill({ response: res, body: answer });
        }
        const json = await res.json();
        answer(json.headers);
        return route.fulfill({ response: res, json });
      },
    );
    for (let i = 0; i < tries; i++) {
      await page.getByLabel('Choose a file').setInputFiles(path);
      await expect(alert(page, 'can’t reach our server')).toBeVisible();
    }
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { requests, videos } = await me.uploads();
    expect([requests, videos.length, videos[0].done]).toEqual([
      tries + 1,
      1,
      true,
    ]);
  });

  test('leaving the step while the upload link is on its way starts no upload (Codex #133 round 3)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    const path = clip(info.outputPath('clip.mp4'));
    let creations = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/tusupload')) creations++;
    });
    // The link's answer waits until the person has pressed Back.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    await page.route(
      `${STUB_USER_URL}/v1/stories/*/upload-url`,
      async (route) => {
        if (!first) return route.fallback();
        first = false;
        const res = await route.fetch();
        await held;
        return route.fulfill({ response: res });
      },
    );
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Getting “clip\.mp4” ready/)).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await step(page, 'Prepare your story');
    const answered = page.waitForResponse(/\/upload-url$/);
    release();
    await answered;

    // Coming back, the same file goes up once, with the same video.
    await page.getByRole('button', { name: 'Upload my video' }).click();
    await step(page, 'Upload your video');
    await page.getByLabel('Choose a file').setInputFiles(path);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { requests, videos } = await me.uploads();
    expect([creations, requests, videos.length, videos[0].done]).toEqual([
      1,
      2,
      1,
      true,
    ]);
  });

  test('a draft changed in another tab is read again and the upload goes ahead (Codex #133, 2)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toUpload(page);
    await page.getByLabel('Title').fill('My video');
    await expect(page).toHaveURL(/\/share\?draft=/);
    const [story] = await me.stories();
    await me.editElsewhere(story.id, 1, { description: 'From the other tab' });
    await page
      .getByLabel('Choose a file')
      .setInputFiles(clip(info.outputPath('clip.mp4')));
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const { requests, videos } = await me.uploads();
    expect([requests, videos.length]).toEqual([2, 1]);
  });
});

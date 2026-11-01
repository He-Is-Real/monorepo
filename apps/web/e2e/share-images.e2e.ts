import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// Pictures on /share (M2 plan PR 10; D53, D65, D80): a written story's image and a video's own
// thumbnail (Joel, 2026-10-30), re-encoded to WebP in the browser and sent with a presigned PUT
// to the stub api-user's stand-in for Bunny's storage, which keeps the bytes it received. The
// database's rules are libs/database/integration/images.int-spec.ts. Each test is its own person.

const SHARE = `${WEB_SIGNED_IN_URL}/share`;
/** The testimony consent's box (plan 4e), before a first story. */
const ART9 = /I agree to the testimony consent/;
/** Text a photo's metadata carries here, which must never leave the browser. */
const MARKERS = ['HEISREAL-EXIF-MARKER', 'HEISREAL-GPS-MARKER'];

interface Uploaded {
  path: string;
  story: string;
  size: number;
  bytes: string | null;
}

async function person(page: Page, request: APIRequestContext) {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: {},
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  /** A newer version is saved after the page loaded: the person's is older than the latest. */
  const agreements = async (set: { terms?: number; testimony?: number }) =>
    expect(
      (
        await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}/agreements`, {
          data: set,
        })
      ).status(),
    ).toBe(204);
  /** The stub's Authorization for this person, as another tab of theirs would send it. */
  const auth = `Bearer e2e.${Buffer.from(
    JSON.stringify({ sub: 'user_e2efixture', session: id }),
  ).toString('base64url')}.fixture`;
  return {
    agreements,
    /** Another tab of theirs puts a picture of that size on the story (its file never sent). */
    otherTab: async (story: string, width: number, height: number) => {
      const headers = { authorization: auth };
      const now = await (
        await request.get(`${STUB_USER_URL}/v1/account/stories/${story}`, {
          headers,
        })
      ).json();
      const added = await request.post(
        `${STUB_USER_URL}/v1/stories/${story}/upload-url`,
        {
          headers: {
            ...headers,
            'if-match': `"${now.version}"`,
            'idempotency-key': randomUUID(),
          },
          data: {
            format: 'image',
            contentType: 'image/webp',
            fileSizeBytes: 1000,
            width,
            height,
            expectedImage: now.image?.path ?? null,
          },
        },
      );
      expect(added.status()).toBe(200);
    },
    uploads: async () =>
      (await (
        await request.get(`${STUB_USER_URL}/__e2e/sessions/${id}/uploads`)
      ).json()) as { requests: number; images: Uploaded[] },
  };
}

const step = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 2, name })).toBeFocused();
const alert = (page: Page, text: string) =>
  page.getByRole('alert').filter({ hasText: text });

/** A picture drawn in the page, as the browser encodes it (`image/jpeg` or `image/png`). */
async function drawn(page: Page, width: number, height: number, type: string) {
  const bytes = await page.evaluate(
    async ([w, h, t]) => {
      const c = new OffscreenCanvas(w as number, h as number);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = '#4e9ba0';
      ctx.fillRect(0, 0, w as number, h as number);
      ctx.fillStyle = '#fff';
      ctx.fillRect(10, 10, (w as number) / 2, (h as number) / 3);
      const blob = await c.convertToBlob({ type: t as string, quality: 0.9 });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    [width, height, type],
  );
  return Buffer.from(bytes);
}

/**
 * The JPEG with an Exif segment as a phone writes one: a description in IFD0 and a GPS IFD (a
 * latitude reference and a map datum), each carrying a marker the test looks for afterwards.
 */
function withExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.alloc(110);
  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number,
  ) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    tiff.writeUInt32LE(value, at + 8);
  };
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8); // IFD0: ImageDescription, GPSInfo
  entry(10, 0x010e, 2, 21, 38);
  entry(22, 0x8825, 4, 1, 60);
  tiff.write(`${MARKERS[0]}\0`, 38, 'ascii');
  tiff.writeUInt16LE(2, 60); // GPS IFD: GPSLatitudeRef 'N', GPSMapDatum
  entry(62, 0x0001, 2, 2, 0x4e);
  entry(74, 0x0012, 2, 20, 90);
  tiff.write(`${MARKERS[1]}\0`, 90, 'ascii');
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
}

async function toWrite(page: Page) {
  await page.goto(SHARE);
  await page.getByRole('button', { name: 'Write my story' }).click();
  await step(page, 'Your story and your data');
  await page.locator('label').filter({ hasText: ART9 }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await step(page, 'Prepare your story');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await step(page, 'Write your story');
}

test('a written story’s picture: previewed at its real shape, described, and uploaded as WebP without its EXIF or GPS', async ({
  page,
  request,
}) => {
  const me = await person(page, request);
  await toWrite(page);
  await page.getByLabel('Title').fill('A picture of where it happened');
  await page
    .getByLabel('Your story')
    .fill('It happened on a hill. '.repeat(10));

  const photo = withExif(await drawn(page, 900, 1200, 'image/jpeg'));
  for (const marker of MARKERS) expect(photo.includes(marker)).toBe(true);
  await page
    .getByLabel('Choose a picture')
    .setInputFiles({ name: 'hill.jpg', mimeType: 'image/jpeg', buffer: photo });

  // At its real shape (3:4), before anything is sent.
  const preview = page.locator('[data-picture-preview]');
  await expect(preview.locator('img')).toBeVisible();
  const box = await preview.boundingBox();
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(0.75, 1);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);

  // The description is never required (Joel, 2026-10-30); it can be added afterwards.
  await page.getByRole('button', { name: 'Add this picture' }).click();
  await expect(page.getByText('Picture added.')).toBeVisible();
  await page.getByLabel('Describe the picture').fill('A green hill at dawn');
  await page.getByRole('button', { name: 'Save description' }).click();
  await expect(page.getByText('Description saved.')).toBeVisible();

  const { images } = await me.uploads();
  expect(images).toHaveLength(1);
  expect(images[0].path).toMatch(
    new RegExp(`^stories/${images[0].story}/[0-9a-f]{32}\\.webp$`),
  );
  const sent = Buffer.from(images[0].bytes ?? '', 'base64');
  expect(sent.length).toBe(images[0].size);
  expect(sent.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(sent.subarray(8, 12).toString('ascii')).toBe('WEBP');
  expect(sent.includes('EXIF')).toBe(false);
  expect(sent.includes('Exif')).toBe(false);
  for (const marker of MARKERS) expect(sent.includes(marker)).toBe(false);
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('a picture wider than 3:1 is refused with a plain message, before anything is sent', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await toWrite(page);
    await page.getByLabel('Choose a picture').setInputFiles({
      name: 'panorama.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 1300, 400, 'image/png'),
    });
    await expect(alert(page, 'That picture is too wide')).toBeVisible();
    await expect(page.locator('[data-picture-preview]')).toHaveCount(0);
    expect(await me.uploads()).toMatchObject({ requests: 0, images: [] });
  });

  /** A written story with its text, on the Write step. */
  async function written(page: Page) {
    await toWrite(page);
    await page.getByLabel('Title').fill('A picture of where it happened');
    await page
      .getByLabel('Your story')
      .fill('It happened on a hill. '.repeat(10));
  }
  const choose = async (page: Page, width: number, height: number) =>
    page.getByLabel(/^Choose (a|another) picture$/).setInputFiles({
      name: `photo-${width}x${height}.png`,
      mimeType: 'image/png',
      buffer: await drawn(page, width, height, 'image/png'),
    });
  const isImageEdit = (r: { method(): string; postDataJSON(): unknown }) =>
    r.method() === 'PATCH' &&
    'image' in ((r.postDataJSON() as object | null) ?? {});

  test('a failed upload is tried again at the same path; a replacement not yet added can be discarded; removing a granted picture takes it off the story (Codex #140, 2 and 3)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    // The first PUT arrives but its answer is lost; the next fails outright; the rest go through.
    const puts: ('lose' | 'fail')[] = ['lose'];
    await page.route(`${STUB_USER_URL}/__s3/**`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const now = puts.shift();
      if (now === 'fail') return route.fulfill({ status: 500 });
      if (now !== 'lose') return route.fallback();
      await route.fetch();
      return route.abort('connectionreset');
    });
    const edits: unknown[] = [];
    page.on('request', (r) => {
      if (isImageEdit(r)) edits.push(r.postDataJSON());
    });

    await choose(page, 900, 1200);
    await page.getByLabel('Describe the picture').fill('A green hill at dawn');
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(alert(page, 'couldn’t be uploaded')).toBeVisible();
    // Trying again replays the same grant: the same path, found there already (412).
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    const [first] = (await me.uploads()).images;
    expect((await me.uploads()).images).toEqual([
      expect.objectContaining({ path: first.path, bytes: expect.any(String) }),
    ]);

    // Another picture, not added yet: discarding it keeps the story's, with nothing sent.
    await choose(page, 1280, 720);
    await page
      .getByRole('button', { name: 'Keep the earlier picture' })
      .click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    const box = await page.locator('[data-picture-preview]').boundingBox();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(0.75, 1);
    expect((await me.uploads()).images).toHaveLength(1);
    expect(edits).toEqual([]);

    // Added again, its PUT fails: it's on the draft, so removing it is an edit at the server.
    puts.push('fail');
    await choose(page, 1280, 720);
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(alert(page, 'couldn’t be uploaded')).toBeVisible();
    expect((await me.uploads()).images).toHaveLength(2);
    const removed = page.waitForResponse(
      (r) => isImageEdit(r.request()) && r.ok(),
    );
    await page.getByRole('button', { name: 'Remove picture' }).click();
    await removed;
    await expect(page.getByText('Picture removed.')).toBeVisible();
    expect(edits).toEqual([{ image: null }]);
  });

  test('a picture put on in another tab while this one asks is shown, never replaced on its own (Codex #140 round 2, 1)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    await choose(page, 900, 1200);
    // While this tab asks, another tab of theirs adds a 16:9 picture: this tab's request is stale.
    let other = false;
    await page.route(
      `${STUB_USER_URL}/v1/stories/*/upload-url`,
      async (route) => {
        if (other) return route.fallback();
        other = true;
        const id = /stories\/([^/]+)\/upload-url/.exec(
          route.request().url(),
        )?.[1];
        await me.otherTab(id ?? '', 1280, 720);
        return route.fallback();
      },
    );
    await page.getByRole('button', { name: 'Add this picture' }).click();

    // The story's picture now is shown, and nothing more was asked for.
    await expect(alert(page, 'was changed in another tab')).toBeVisible();
    const preview = page.locator('[data-picture-preview]');
    const wide = await preview.boundingBox();
    expect((wide?.width ?? 0) / (wide?.height ?? 1)).toBeCloseTo(16 / 9, 1);
    expect((await me.uploads()).images).toHaveLength(1);

    // Replacing it is the person's own choice.
    await page.getByRole('button', { name: 'Replace with my picture' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    const tall = await preview.boundingBox();
    expect((tall?.width ?? 0) / (tall?.height ?? 1)).toBeCloseTo(0.75, 1);
    const { images } = await me.uploads();
    expect(images).toHaveLength(2);
    expect(images[1].bytes).not.toBeNull();
  });

  test('a picture whose answer was lost is found on the story before a replacement is discarded, and counts as unfinished until its file arrives (Codex #140 round 2, 2; round 3, 2)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    // The first request goes through at the server, but its answer is lost.
    let lost = false;
    await page.route(
      `${STUB_USER_URL}/v1/stories/*/upload-url`,
      async (route) => {
        if (lost) return route.fallback();
        lost = true;
        await route.fetch();
        return route.abort('connectionreset');
      },
    );
    const edits: unknown[] = [];
    page.on('request', (r) => {
      if (isImageEdit(r)) edits.push(r.postDataJSON());
    });
    await choose(page, 900, 1200);
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(alert(page, 'can’t reach our server')).toBeVisible();
    expect((await me.uploads()).images).toHaveLength(1);

    // Another picture chosen, then discarded: the story is read, and its picture shown as it is,
    // with its file never sent, so not finished.
    await choose(page, 1280, 720);
    await page
      .getByRole('button', { name: /^(Remove|Keep the earlier) picture$/ })
      .click();
    await expect(page.getByText('didn’t finish uploading')).toBeVisible();
    await expect(page.getByText('Picture added.')).toHaveCount(0);
    const box = await page.locator('[data-picture-preview]').boundingBox();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(0.75, 1);
    expect(edits).toEqual([]);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByText('Add the picture you chose, or remove it'),
    ).toBeVisible();

    // Removing that one takes it off the story.
    await page.getByRole('button', { name: 'Remove picture' }).click();
    await expect(page.getByText('Picture removed.')).toBeVisible();
    expect(edits).toEqual([{ image: null }]);
  });

  test('a picture whose upload failed stays unfinished when a replacement is discarded, and is uploaded again at its own path (Codex #140 round 3, 2)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    let fail = true;
    await page.route(`${STUB_USER_URL}/__s3/**`, async (route) => {
      if (route.request().method() !== 'PUT' || !fail) return route.fallback();
      fail = false;
      return route.fulfill({ status: 500 });
    });
    await choose(page, 900, 1200);
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(alert(page, 'couldn’t be uploaded')).toBeVisible();

    // Another picture chosen, then the earlier one kept: its file never arrived, so it isn't
    // finished, and Continue waits for it.
    await choose(page, 1280, 720);
    await page
      .getByRole('button', { name: 'Keep the earlier picture' })
      .click();
    await expect(alert(page, 'didn’t finish uploading')).toBeVisible();
    await expect(page.getByText('Picture added.')).toHaveCount(0);
    const box = await page.locator('[data-picture-preview]').boundingBox();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(0.75, 1);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByText('Add the picture you chose, or remove it'),
    ).toBeVisible();

    // Adding it again uploads it to the path its grant has, counting nothing new.
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    expect((await me.uploads()).images).toEqual([
      expect.objectContaining({ bytes: expect.any(String) }),
    ]);
  });

  test('a picture asked for once the page caught up with a change made elsewhere still never replaces another tab’s picture (Codex #140 round 3, 1)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    await choose(page, 900, 1200);
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();

    // Another tab of theirs puts a 16:9 picture on in place of the one this tab shows. This tab
    // then edits the title (its save finds the story moved on and catches up) and adds a picture.
    const [first] = (await me.uploads()).images;
    await me.otherTab(first.story, 1280, 720);
    await page.getByLabel('Title').fill('Where it happened, on the hill');
    await choose(page, 600, 1200);
    await page.getByRole('button', { name: 'Add this picture' }).click();

    // The story's picture now is shown, and nothing more was granted.
    await expect(alert(page, 'was changed in another tab')).toBeVisible();
    const preview = page.locator('[data-picture-preview]');
    const wide = await preview.boundingBox();
    expect((wide?.width ?? 0) / (wide?.height ?? 1)).toBeCloseTo(16 / 9, 1);
    expect((await me.uploads()).images).toHaveLength(2);

    // Replacing it is the person's own choice.
    await page.getByRole('button', { name: 'Replace with my picture' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    const tall = await preview.boundingBox();
    expect((tall?.width ?? 0) / (tall?.height ?? 1)).toBeCloseTo(0.5, 1);
    const { images } = await me.uploads();
    expect(images).toHaveLength(3);
    expect(images[2].bytes).not.toBeNull();
  });

  test('signing out while a description is being saved keeps nothing of the story in the tab (Codex #140, 1)', async ({
    page,
    request,
  }) => {
    await person(page, request);
    await written(page);
    await choose(page, 900, 1200);
    await page.getByLabel('Describe the picture').fill('A green hill at dawn');
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();

    // Every save is held from here, so the text typed next is on this device only.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const described = new Promise<void>((r) => (arrived = r));
    await page.route(`${STUB_USER_URL}/v1/stories/*`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      if (isImageEdit(route.request())) arrived();
      const res = await route.fetch();
      await held;
      return route.fulfill({ response: res });
    });
    await page
      .getByLabel('Your story')
      .fill('Something private, never saved. '.repeat(8));
    await page.getByLabel('Describe the picture').fill('The hill at sunrise');
    await page.getByRole('button', { name: 'Save description' }).click();
    await described;

    // Signing out (as Clerk's does: Share's storage cleared, the flow gone), in the same page.
    await page.evaluate(() => window.sessionStorage.clear());
    await page.getByRole('link', { name: 'He Is Real Today, home' }).click();
    await expect(page).toHaveURL(/\/$/);
    const answered = page.waitForEvent('requestfinished', isImageEdit);
    release();
    await answered;
    // The answer's own handling runs in the tasks after it.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    expect(
      await page.evaluate(() => JSON.stringify(window.sessionStorage)),
    ).not.toMatch(/Something private|sunrise/);
  });

  test('a video’s own thumbnail is offered once the video is chosen, and shown when reviewing', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await page.goto(SHARE);
    await page
      .locator('label')
      .filter({ hasText: 'Upload a video file' })
      .click();
    await page.getByRole('button', { name: 'Share my video' }).click();
    await page.locator('label').filter({ hasText: ART9 }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Upload my video' }).click();
    await step(page, 'Upload your video');
    await expect(page.getByText('Add a thumbnail (optional)')).toHaveCount(0);
    await page.getByLabel('Title').fill('Twenty years of searching');
    const clip = info.outputPath('clip.mp4');
    writeFileSync(clip, Buffer.alloc(64 * 1024, 7));
    await page.getByLabel('Choose a file').setInputFiles(clip);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();

    await expect(page.getByText('Add a thumbnail (optional)')).toBeVisible();
    await page.getByLabel('Choose a thumbnail').setInputFiles({
      name: 'thumb.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 1280, 720, 'image/png'),
    });
    await page.getByRole('button', { name: 'Add this thumbnail' }).click();
    await expect(page.getByText('Thumbnail added.')).toBeVisible();
    expect((await me.uploads()).images).toMatchObject([
      { bytes: expect.any(String) },
    ]);

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    const shown = page.locator('[data-review-picture] img');
    await expect(shown).toBeVisible();
    await expect
      .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1280);
  });

  // Plan 4e: a newer testimony consent or terms of use saved while the person was writing makes
  // api-user refuse the picture's upload request (403): the same agree-again screen a refused save
  // opens (Joel, 2026-11-01, option B), and the picture is added once they agree.
  const AGAIN = [
    {
      code: 'testimony_consent_required',
      older: { testimony: 1 },
      heading: 'Our testimony consent has changed',
      box: /I agree to version 3 of the testimony consent/,
      text: 'testimony consent',
    },
    {
      code: 'terms_agreement_required',
      older: { terms: 1 },
      heading: 'Our terms of use have changed',
      box: /I agree to version 2 of the terms of use/,
      text: 'terms of use',
    },
  ] as const;
  const saved = (page: Page) =>
    expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'saved',
    );

  for (const again of AGAIN) {
    test(`a picture refused with ${again.code} opens the agree-again screen, and agreeing adds it`, async ({
      page,
      request,
    }) => {
      const me = await person(page, request);
      await written(page);
      await saved(page);
      await me.agreements(again.older);
      await choose(page, 900, 1200);
      await page.getByRole('button', { name: 'Add this picture' }).click();
      await step(page, again.heading);
      await page.locator('label').filter({ hasText: again.box }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await step(page, 'Write your story');
      await expect(page.getByText('Picture added.')).toBeVisible();
      await expect(page.getByLabel('Title')).toHaveValue(
        'A picture of where it happened',
      );
      const { requests, images } = await me.uploads();
      expect([requests, images.length]).toEqual([2, 1]);
    });
  }

  test('not agreeing for a picture leaves it to add, with the reason, and adding it asks again', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    await saved(page);
    await me.agreements({ testimony: 1 });
    await choose(page, 900, 1200);
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await step(page, 'Our testimony consent has changed');
    await page.getByRole('button', { name: 'Back' }).click();
    await step(page, 'Write your story');
    await expect(
      alert(page, 'please agree to the latest testimony consent'),
    ).toBeVisible();
    await expect(page.locator('[data-picture-preview] img')).toBeVisible();
    expect((await me.uploads()).images).toEqual([]);
    await page.getByRole('button', { name: 'Add this picture' }).click();
    await step(page, 'Our testimony consent has changed');
    await page
      .locator('label')
      .filter({ hasText: /I agree to version 3 of the testimony consent/ })
      .click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    expect((await me.uploads()).images).toHaveLength(1);
  });
});

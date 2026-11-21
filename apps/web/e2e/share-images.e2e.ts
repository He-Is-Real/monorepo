import { randomUUID } from 'node:crypto';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

async function person(
  page: Page,
  request: APIRequestContext,
  /** The admin's settings for this person's session, where a test needs others. */
  settings: Record<string, number> = {},
) {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: { settings },
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

/**
 * Real videos (made with ffmpeg, a few KB): a portrait MP4 stored sideways with a phone's "turn
 * this" note (160 × 90 turned to 90 × 160, its header after the media as phones write it) in a
 * format no browser plays (MPEG-4 Part 2), so its shape is read from its header (TC-4); and a
 * 2-second landscape WebM (160 × 90) every browser here plays.
 */
const FIXTURES = join(__dirname, 'fixtures');
function videoFile(
  info: { outputPath: (name: string) => string },
  fixture: 'portrait.mp4' | 'landscape.webm',
  name: string,
) {
  const path = info.outputPath(name);
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

/** An uploaded WebP's size, and the colour (red) at the given points, as this browser decodes it. */
async function decoded(
  page: Page,
  base64: string,
  points: [number, number][] = [],
) {
  return page.evaluate(
    async ([b64, at]) => {
      const bytes = Uint8Array.from(atob(b64 as string), (c) =>
        c.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: 'image/webp' }),
      );
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const red = (at as [number, number][]).map(
        ([x, y]) => ctx.getImageData(x, y, 1, 1).data[0],
      );
      return { width: bitmap.width, height: bitmap.height, red };
    },
    [base64, points] as const,
  );
}

/** A video story's upload step, with its title. */
async function toVideo(page: Page) {
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
  await page.getByLabel('Title').fill('Twenty years of searching');
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

/** A PNG of random noise: the hardest picture to make small, so its WebP stays large. */
async function noise(page: Page, width: number, height: number) {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      const img = ctx.createImageData(w, h);
      // getRandomValues fills at most 65,536 bytes at a time; alpha stays opaque.
      for (let at = 0; at < img.data.length; at += 65_536)
        crypto.getRandomValues(img.data.subarray(at, at + 65_536));
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      ctx.putImageData(img, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    [width, height],
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

/**
 * Files dropped onto the picture's drop area (Joel, 2026-11-14), as a browser hands them over
 * when they're dragged from the desktop.
 */
async function dropPictures(
  page: Page,
  files: { name: string; type: string; bytes: Buffer }[],
) {
  const dropped = await page.evaluateHandle(
    (all) => {
      const t = new DataTransfer();
      for (const f of all) {
        t.items.add(
          new File([new Uint8Array(f.bytes)], f.name, { type: f.type }),
        );
      }
      return t;
    },
    files.map((f) => ({ ...f, bytes: [...f.bytes] })),
  );
  const zone = page.locator('[data-picture-phase] [data-drop-zone]');
  await zone.dispatchEvent('dragover', { dataTransfer: dropped });
  // Highlighted while a file is over it.
  await expect(zone).toHaveClass(/border-brand/);
  await zone.dispatchEvent('drop', { dataTransfer: dropped });
  await expect(zone).not.toHaveClass(/border-brand/);
}

test('a written story’s picture is previewed at its real shape, and the step fits the screen', async ({
  page,
  request,
}) => {
  await person(page, request);
  await toWrite(page);
  await page.getByLabel('Title').fill('A picture of where it happened');
  await page
    .getByLabel('Your story')
    .fill('It happened on a hill. '.repeat(10));
  // The drop area with no picture yet fits too.
  await expect(page.getByText('Drag it here, or')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  await page.getByLabel('Choose a picture').setInputFiles({
    name: 'hill.jpg',
    mimeType: 'image/jpeg',
    buffer: await drawn(page, 900, 1200, 'image/jpeg'),
  });
  await expect(
    page.getByText('Want to use a different picture? Drag it here, or'),
  ).toBeVisible();
  // At its real shape (3:4).
  const preview = page.locator('[data-picture-preview]');
  await expect(preview.locator('img')).toBeVisible();
  const box = await preview.boundingBox();
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(0.75, 1);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('a written story’s picture: its file’s name is shown, and it’s uploaded as WebP without its EXIF or GPS', async ({
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
    await page.getByLabel('Choose a picture').setInputFiles({
      name: 'hill.jpg',
      mimeType: 'image/jpeg',
      buffer: photo,
    });

    // Added as soon as it's chosen (Joel, 2026-11-09), with the chosen file's name, and no
    // description to give (Joel, 2026-11-14).
    await expect(page.getByText('Picture added.')).toBeVisible();
    await expect(page.locator('[data-attached-name]')).toHaveText(
      'Attached: hill.jpg',
    );
    await expect(page.getByLabel(/Describe the/)).toHaveCount(0);

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

  // Joel, 2026-11-20: the largest picture file is the admin's setting, checked once prepared.
  test('a picture over the largest picture file is refused with a plain message, before anything is sent', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, { imageMaxBytes: 204_800 });
    await toWrite(page);
    // About 600 KB as a WebP: three times the 200 KB set here.
    await page.getByLabel('Choose a picture').setInputFiles({
      name: 'busy.png',
      mimeType: 'image/png',
      buffer: await noise(page, 1000, 800),
    });
    await expect(alert(page, 'This picture is too large: ')).toContainText(
      'the most we can take is 200 KB. Please choose a smaller one.',
    );
    await expect(page.locator('[data-picture-preview]')).toHaveCount(0);
    expect(await me.uploads()).toMatchObject({ requests: 0, images: [] });

    // A picture under it is added as usual.
    await page.getByLabel('Choose a picture').setInputFiles({
      name: 'calm.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 900, 1200, 'image/png'),
    });
    await expect(page.locator('[data-picture-preview]')).toBeVisible();
    await expect(alert(page, 'This picture is too large')).toHaveCount(0);
  });

  test('a picture dropped on a written story is added as a chosen one is: the first of several, as WebP without its EXIF or GPS', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await toWrite(page);
    await page.getByLabel('Title').fill('A picture of where it happened');
    await page
      .getByLabel('Your story')
      .fill('It happened on a hill. '.repeat(10));
    await dropPictures(page, [
      {
        name: 'hill.jpg',
        type: 'image/jpeg',
        bytes: withExif(await drawn(page, 900, 1200, 'image/jpeg')),
      },
      {
        name: 'other.png',
        type: 'image/png',
        bytes: await drawn(page, 800, 600, 'image/png'),
      },
    ]);
    await expect(page.getByText('Picture added.')).toBeVisible();
    await expect(page.locator('[data-attached-name]')).toHaveText(
      'Attached: hill.jpg',
    );
    const { requests, images } = await me.uploads();
    expect([requests, images.length]).toEqual([1, 1]);
    const sent = Buffer.from(images[0].bytes ?? '', 'base64');
    expect(sent.subarray(8, 12).toString('ascii')).toBe('WEBP');
    for (const marker of MARKERS) expect(sent.includes(marker)).toBe(false);
  });

  test('a dropped file that isn’t a picture is refused with the chooser’s message, before anything is sent', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await toWrite(page);
    await dropPictures(page, [
      {
        name: 'notes.txt',
        type: 'text/plain',
        bytes: Buffer.from('Not a picture at all.'),
      },
    ]);
    await expect(
      alert(page, 'We can’t read that file as a picture.'),
    ).toBeVisible();
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
  /**
   * Without a title the picture can't be added yet: one chosen then stays on this device only,
   * as a replacement not added (nothing is asked of api-user).
   */
  const chooseUnsent = async (page: Page, width: number, height: number) => {
    await page.getByLabel('Title').fill('');
    await choose(page, width, height);
    await expect(
      alert(page, 'Write your title and your story first'),
    ).toBeVisible();
    await page.getByLabel('Title').fill('A picture of where it happened');
  };
  const isImageEdit = (r: { method(): string; postDataJSON(): unknown }) =>
    r.method() === 'PATCH' &&
    'image' in ((r.postDataJSON() as object | null) ?? {});

  test('a chosen picture is added with no click, and Continue waits while it uploads', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    // The picture's file is held at the storage until the test lets it through.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${STUB_USER_URL}/__s3/**`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      await held;
      return route.fallback();
    });
    await choose(page, 900, 1200);
    await expect(page.getByText('Uploading your picture…')).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      alert(page, 'Your picture is still uploading. Wait for it to finish'),
    ).toBeVisible();

    release();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Picture added. You can continue.' }),
    ).toBeVisible();
    await expect(alert(page, 'still uploading')).toHaveCount(0);
    expect((await me.uploads()).images).toMatchObject([
      { bytes: expect.any(String) },
    ]);

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
  });

  test('the steps at the top keep a picture’s rules: forward waits while it uploads, back just goes and stops it (V-2)', async ({
    page,
    request,
  }) => {
    await person(page, request);
    await written(page);
    const stepButton = (name: RegExp) =>
      page
        .getByRole('navigation', { name: 'Steps' })
        .getByRole('button', { name });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${STUB_USER_URL}/__s3/**`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      await held;
      // Stopped by the browser meanwhile: there's nothing left to send.
      return route.fallback().catch(() => undefined);
    });
    await choose(page, 900, 1200);
    await expect(page.getByText('Uploading your picture…')).toBeVisible();

    // Forward: the step's own rule, as Continue says it.
    await stepButton(/^6\. Review/).click();
    await expect(
      alert(page, 'Your picture is still uploading. Wait for it to finish'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Write your story' }),
    ).toBeVisible();

    // Back: no question; the step changes and the picture's upload stops with it.
    const stopped = page.waitForEvent(
      'requestfailed',
      (r) => r.method() === 'PUT' && r.url().includes('/__s3/'),
    );
    await stepButton(/^3\. Prepare/).click();
    await step(page, 'Prepare your story');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByText('Uploading your picture…')).toHaveCount(0);
    await stopped;
    release();

    // The story has that picture without its file: forward stops at its step until it's added.
    await stepButton(/^6\. Review/).click();
    await step(page, 'Write your story');
    await expect(page.getByText('didn’t finish uploading')).toBeVisible();
  });

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
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();
    // Trying again replays the same grant: the same path, found there already (412).
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    const [first] = (await me.uploads()).images;
    expect((await me.uploads()).images).toEqual([
      expect.objectContaining({ path: first.path, bytes: expect.any(String) }),
    ]);

    // Another picture, not added yet: discarding it keeps the story's, with nothing sent.
    await chooseUnsent(page, 1280, 720);
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
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();
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
    await choose(page, 900, 1200);

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
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();
    expect((await me.uploads()).images).toHaveLength(1);

    // Another picture chosen, not added, then discarded: the story is read, and its picture
    // shown as it is, with its file never sent, so not finished.
    await chooseUnsent(page, 1280, 720);
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
      page.getByText('Your picture hasn’t been added yet'),
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
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();

    // Another picture chosen, not added, then the earlier one kept: its file never arrived, so
    // it isn't finished, and Continue waits for it.
    await chooseUnsent(page, 1280, 720);
    await page
      .getByRole('button', { name: 'Keep the earlier picture' })
      .click();
    await expect(alert(page, 'didn’t finish uploading')).toBeVisible();
    await expect(page.getByText('Picture added.')).toHaveCount(0);
    const box = await page.locator('[data-picture-preview]').boundingBox();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(0.75, 1);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByText('Your picture hasn’t been added yet'),
    ).toBeVisible();

    // Trying again uploads it to the path its grant has, counting nothing new.
    await page.getByRole('button', { name: 'Try again' }).click();
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
    await expect(page.getByText('Picture added.')).toBeVisible();

    // Another tab of theirs puts a 16:9 picture on in place of the one this tab shows. This tab
    // then edits the title (its save finds the story moved on and catches up) and adds a picture.
    const [first] = (await me.uploads()).images;
    await me.otherTab(first.story, 1280, 720);
    await page.getByLabel('Title').fill('Where it happened, on the hill');
    await choose(page, 600, 1200);

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

  test('a video’s own thumbnail is offered once the video is chosen, cut to the video’s shape: a square photo for a portrait video uploads as 9:16 (thumbnail crop TC-1 A, TC-2 A)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toVideo(page);
    await expect(page.getByText('Add a thumbnail (optional)')).toHaveCount(0);
    await page
      .getByLabel('Choose a file')
      .setInputFiles(videoFile(info, 'portrait.mp4', 'clip.mp4'));
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    const before = (await me.uploads()).requests;

    await expect(page.getByText('Add a thumbnail (optional)')).toBeVisible();
    await page.getByLabel('Choose a thumbnail').setInputFiles({
      name: 'thumb.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 1200, 1200, 'image/png'),
    });
    // The crop box opens at the video's shape; nothing is sent until it's used (TC-6 A).
    await expect(page.locator('[data-cropper]')).toBeVisible();
    await expect(page.getByText('Your video is portrait')).toBeVisible();
    // This browser can't play the video, so only "A picture" is offered (TC-1 D).
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.locator('[data-attached-name]')).toHaveText(
      'Chosen: thumb.png',
    );
    expect(await me.uploads()).toMatchObject({ requests: before, images: [] });
    // Continue waits for the crop to be used or cancelled.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      alert(page, 'Use this thumbnail, or cancel it, before you go on.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeVisible();

    // The keyboard moves and zooms it, and a polite line says where it is.
    await page.getByRole('group', { name: /^Thumbnail crop/ }).focus();
    await page.keyboard.press('+');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-crop-spoken]')).toHaveText(
      /^Zoom 1\.2 times\. Showing .+ of your picture\.$/,
    );
    await page.keyboard.press('0');
    await page.getByRole('button', { name: 'Use this thumbnail' }).click();
    await expect(page.getByText('Thumbnail added.')).toBeVisible();
    await expect(page.locator('[data-attached-name]')).toHaveText(
      'Attached: thumb.png',
    );
    const { images } = await me.uploads();
    expect(images).toHaveLength(1);
    const sent = await decoded(page, images[0].bytes ?? '');
    // 9:16, the whole height of the photo (1200 px).
    expect(sent.width / sent.height).toBeCloseTo(9 / 16, 2);
    expect(sent.height).toBe(1200);
    await expect(
      page.getByRole('button', { name: 'Change how it’s cropped' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    const shown = page.locator('[data-review-picture] img');
    await expect(shown).toBeVisible();
    await expect
      .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(sent.width);
    // What was attached, confirmed with its name in this tab, before it's sent (Joel, 2026-11-14).
    await expect(page.locator('[data-attached]')).toHaveText([
      'Video attachedclip.mp4',
      'Thumbnail attachedthumb.png',
    ]);
    await expect(page.locator('[data-attached] svg')).toHaveCount(2);
  });

  test('a video’s thumbnail can be dropped onto its own drop area, not the video’s', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toVideo(page);
    await page
      .getByLabel('Choose a file')
      .setInputFiles(videoFile(info, 'portrait.mp4', 'clip.mp4'));
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();

    await dropPictures(page, [
      {
        name: 'thumb.png',
        type: 'image/png',
        bytes: await drawn(page, 1280, 720, 'image/png'),
      },
    ]);
    await expect(page.locator('[data-cropper]')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
    await page.getByRole('button', { name: 'Use this thumbnail' }).click();
    await expect(page.getByText('Thumbnail added.')).toBeVisible();
    await expect(
      page.getByText('Want to use a different thumbnail? Drag it here, or'),
    ).toBeVisible();
    await expect(page.getByLabel('Choose another thumbnail')).toBeVisible();
    // The video stays as it was.
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    expect((await me.uploads()).images).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  });

  test('a thumbnail can be a moment from the video, when this browser plays it (TC-1 D)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toVideo(page);
    await page
      .getByLabel('Choose a file')
      .setInputFiles(videoFile(info, 'landscape.webm', 'walk.webm'));
    await expect(page.getByText(/^Uploaded: walk\.webm/)).toBeVisible();
    await page.getByRole('tab', { name: 'A moment from your video' }).click();
    const moment = page.getByRole('slider', { name: 'Moment' });
    await expect(moment).toBeEnabled();
    await moment.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(moment).toHaveAttribute('aria-valuetext', '0:00 of 0:02');
    await page.getByRole('button', { name: 'Use this moment' }).click();
    await expect(page.getByText('Thumbnail added.')).toBeVisible();
    await expect(page.locator('[data-attached-name]')).toHaveText(
      'Attached: walk.webm at 0:00',
    );
    const { images } = await me.uploads();
    expect(images).toHaveLength(1);
    // The video's own 16:9 frame (160 × 90), enlarged 7 times with hard edges (TC-7 A).
    const sent = await decoded(page, images[0].bytes ?? '');
    expect([sent.width, sent.height]).toEqual([1120, 630]);
  });

  test('a new video takes the thumbnail off and says why (TC-3 B)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toVideo(page);
    await page
      .getByLabel('Choose a file')
      .setInputFiles(videoFile(info, 'portrait.mp4', 'clip.mp4'));
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    await page.getByLabel('Choose a thumbnail').setInputFiles({
      name: 'thumb.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 1200, 1200, 'image/png'),
    });
    await page.getByRole('button', { name: 'Use this thumbnail' }).click();
    await expect(page.getByText('Thumbnail added.')).toBeVisible();

    await page
      .getByLabel('Choose another file')
      .setInputFiles(videoFile(info, 'landscape.webm', 'walk.webm'));
    await expect(page.getByText(/^Uploaded: walk\.webm/)).toBeVisible();
    await expect(
      page.getByText(
        'We’ve taken your thumbnail off because you changed your video. Choose one again if you still want it.',
      ),
    ).toBeVisible();
    await expect(page.locator('[data-picture-preview]')).toHaveCount(0);
    await expect(page.getByLabel('Choose a thumbnail')).toBeVisible();
    // Off the story at the server too: Review shows no thumbnail.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    await expect(page.locator('[data-review-picture]')).toHaveCount(0);
    expect((await me.uploads()).images).toHaveLength(1);
  });

  test('a new video’s old thumbnail that couldn’t be taken off holds the step until “Try again” takes it off (TC-3 B)', async ({
    page,
    request,
  }, info) => {
    const me = await person(page, request);
    await toVideo(page);
    await page
      .getByLabel('Choose a file')
      .setInputFiles(videoFile(info, 'portrait.mp4', 'clip.mp4'));
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    await page.getByLabel('Choose a thumbnail').setInputFiles({
      name: 'thumb.png',
      mimeType: 'image/png',
      buffer: await drawn(page, 1200, 1200, 'image/png'),
    });
    await page.getByRole('button', { name: 'Use this thumbnail' }).click();
    await expect(page.getByText('Thumbnail added.')).toBeVisible();

    // The first removal of the thumbnail fails (our service is unavailable).
    let failed = 0;
    await page.route('**/v1/stories/*', async (route) => {
      const req = route.request();
      if (
        failed === 0 &&
        req.method() === 'PATCH' &&
        req.postDataJSON()?.image === null
      ) {
        failed += 1;
        return route.fulfill({ status: 500, body: '' });
      }
      return route.fallback();
    });
    await page
      .getByLabel('Choose another file')
      .setInputFiles(videoFile(info, 'landscape.webm', 'walk.webm'));
    await expect(page.getByText(/^Uploaded: walk\.webm/)).toBeVisible();
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();
    await expect(page.locator('[data-picture-preview]')).toBeVisible();
    await expect(page.getByText('Thumbnail added.')).toHaveCount(0);
    expect(failed).toBe(1);

    // Continue waits while the old thumbnail is still on the story.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      alert(
        page,
        'We couldn’t take your old thumbnail off. Try again before you continue.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upload your video' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByText(
        'We’ve taken your thumbnail off because you changed your video. Choose one again if you still want it.',
      ),
    ).toBeVisible();
    await expect(page.locator('[data-picture-preview]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    await expect(page.locator('[data-review-picture]')).toHaveCount(0);
    expect((await me.uploads()).images).toHaveLength(1);
  });

  test('a video whose shape this browser can’t read waits for our video host before a thumbnail is chosen (TC-4)', async ({
    page,
    request,
  }, info) => {
    await person(page, request);
    await toVideo(page);
    const clip = info.outputPath('clip.mp4');
    writeFileSync(clip, Buffer.alloc(64 * 1024, 7));
    await page.getByLabel('Choose a file').setInputFiles(clip);
    await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
    await expect(page.locator('[data-thumbnail-waiting]')).toContainText(
      'We can’t read your video’s shape in this browser',
    );
    await expect(page.getByLabel('Choose a thumbnail')).toHaveCount(0);
  });

  test('a tiny picture is taken, enlarged with hard pixel edges (TC-7 A)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await toWrite(page);
    await page.getByLabel('Title').fill('Pixel by pixel');
    await page
      .getByLabel('Your story')
      .fill('It happened on a hill. '.repeat(10));
    // A 16 × 16 checkerboard of 2-pixel black and white squares: pixel art.
    const art = await page.evaluate(async () => {
      const c = new OffscreenCanvas(16, 16);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      for (let y = 0; y < 16; y += 2)
        for (let x = 0; x < 16; x += 2) {
          ctx.fillStyle = (x + y) % 4 === 0 ? '#000' : '#fff';
          ctx.fillRect(x, y, 2, 2);
        }
      const blob = await c.convertToBlob({ type: 'image/png' });
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.getByLabel('Choose a picture').setInputFiles({
      name: 'art.png',
      mimeType: 'image/png',
      buffer: Buffer.from(art),
    });
    await expect(page.getByText('Picture added.')).toBeVisible();
    const { images } = await me.uploads();
    expect(images).toHaveLength(1);
    // 63 times: each square is 126 px. A smoothed enlargement would blur its edges over tens of
    // pixels; a hard one stays black or white 4 px either side of an edge.
    const edge = 126;
    const sent = await decoded(page, images[0].bytes ?? '', [
      [edge - 4, 60],
      [edge + 4, 60],
    ]);
    expect([sent.width, sent.height]).toEqual([1008, 1008]);
    expect(sent.red[0]).toBeLessThan(40);
    expect(sent.red[1]).toBeGreaterThan(215);
  });

  // A tiny thumbnail keeps the video's shape through its enlargement: the crop is rounded only at
  // the size it's uploaded at, not in the photo's few pixels (8 × 8 → 4.5 × 8 for 9:16).
  for (const side of [8, 1]) {
    test(`a tiny ${side} × ${side} thumbnail is enlarged to the video’s shape (TC-7 A, TC-2 A)`, async ({
      page,
      request,
    }, info) => {
      const me = await person(page, request);
      await toVideo(page);
      await page
        .getByLabel('Choose a file')
        .setInputFiles(videoFile(info, 'portrait.mp4', 'clip.mp4'));
      await expect(page.getByText(/^Uploaded: clip\.mp4/)).toBeVisible();
      await page.getByLabel('Choose a thumbnail').setInputFiles({
        name: 'tiny.png',
        mimeType: 'image/png',
        buffer: await drawn(page, side, side, 'image/png'),
      });
      await page.getByRole('button', { name: 'Use this thumbnail' }).click();
      await expect(page.getByText('Thumbnail added.')).toBeVisible();
      const { images } = await me.uploads();
      expect(images).toHaveLength(1);
      const sent = await decoded(page, images[0].bytes ?? '');
      expect(sent.height).toBe(1000);
      expect(sent.width / sent.height).toBeCloseTo(9 / 16, 2);
    });
  }

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

  // A refusal to sign the link again doesn't mean nothing was granted (api-user checks the
  // agreements after finding the grant): agreeing finishes the same grant, counting nothing new.
  test('a picture whose upload failed, tried again after the consent changed, is finished at its own path once they agree', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    await saved(page);
    let fail = true;
    await page.route(`${STUB_USER_URL}/__s3/**`, async (route) => {
      if (route.request().method() !== 'PUT' || !fail) return route.fallback();
      fail = false;
      return route.fulfill({ status: 500 });
    });
    await choose(page, 900, 1200);
    await expect(
      alert(page, 'Something went wrong. Please try again later.'),
    ).toBeVisible();
    const [granted] = (await me.uploads()).images;
    await me.agreements({ testimony: 1 });
    await page.getByRole('button', { name: 'Try again' }).click();
    await step(page, 'Our testimony consent has changed');
    await page
      .locator('label')
      .filter({ hasText: /I agree to version 3 of the testimony consent/ })
      .click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Picture added.')).toBeVisible();
    // The grant, the refused replay, the replay after agreeing: one picture, at its own path.
    const { requests, images } = await me.uploads();
    expect(requests).toBe(3);
    expect(images).toEqual([
      expect.objectContaining({
        path: granted.path,
        bytes: expect.any(String),
      }),
    ]);
  });

  test('not agreeing for a picture leaves it to add, with the reason, and trying again asks again', async ({
    page,
    request,
  }) => {
    const me = await person(page, request);
    await written(page);
    await saved(page);
    await me.agreements({ testimony: 1 });
    await choose(page, 900, 1200);
    await step(page, 'Our testimony consent has changed');
    await page.getByRole('button', { name: 'Back' }).click();
    await step(page, 'Write your story');
    await expect(
      alert(page, 'please agree to the latest testimony consent'),
    ).toBeVisible();
    await expect(page.locator('[data-picture-preview] img')).toBeVisible();
    expect((await me.uploads()).images).toEqual([]);
    await page.getByRole('button', { name: 'Try again' }).click();
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

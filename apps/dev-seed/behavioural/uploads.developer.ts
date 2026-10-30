import { expect, type Page, test } from '@playwright/test';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import BUNNY_MEDIA from '../src/app/bunny-media.json';
import { DEV_PROJECT } from '../src/app/config';
import { WEB_URL } from './playwright.config';
import {
  presignStorageUrl,
  type StorageZone,
  tusSignature,
} from '@heisreal/story-cards/upload-signing';

// M2's upload spike (the "proven presigned PUT" prerequisite): a real browser at web's dev
// origin uploads straight to dev Bunny with links signed the way api-user will sign them
// (upload-signing.ts). A developer runs it, not CI: signing needs the dev upload keys, which
// only developers, tf-bunny and api-user can read (D57). Run: `pnpm nx run dev-seed:upload-spike`
// (needs your gcloud ADC and ffmpeg with libx264 and libwebp). It creates one 2-second clip and
// one ~20 KB WebP, both labelled `upload-spike` (test data, D50), and deletes both, pass or fail.

const LIBRARY_ID = BUNNY_MEDIA.libraryId;
const STREAM_API = `https://video.bunnycdn.com/library/${LIBRARY_ID}`;
const TUS_ENDPOINT = 'https://video.bunnycdn.com/tusupload';
// The images zone's S3 endpoint in London (modules/bunny: region UK, type S3).
const ZONE = {
  name: 'heisreal-dev-image-store',
  host: 'uk-s3.storage.bunnycdn.com',
  region: 'uk',
};
// Edge Storage API host for the same zone: the only way to delete a folder (below).
const STORAGE_API = 'https://uk.storage.bunnycdn.com/heisreal-dev-image-store';
const TEST_PREFIX = 'upload-spike';
// Bunny Stream video statuses: https://docs.bunny.net/reference/video_getvideo
const FINISHED = 4;

let libraryKey: string;
let zone: StorageZone;

// Read with the Secret Manager client directly: libs/secrets is a Nest provider, and Playwright's
// loader can't compile its parameter decorators.
async function secret(name: string): Promise<string> {
  const [version] = await new SecretManagerServiceClient().accessSecretVersion({
    name: `projects/${DEV_PROJECT}/secrets/${name}/versions/latest`,
  });
  const value = version.payload?.data?.toString();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

test.beforeAll(async () => {
  libraryKey = await secret('bunny-stream-api-key');
  zone = { ...ZONE, password: await secret('bunny-storage-password') };
});

/** A request from web's dev origin; `null` when the browser blocks it (CORS) or it fails. */
async function browserFetch(
  page: Page,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: number[] },
) {
  return page.evaluate(
    async ({ url, init }) => {
      try {
        const res = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body ? new Uint8Array(init.body) : undefined,
        });
        return {
          status: res.status,
          location: res.headers.get('location'),
          offset: res.headers.get('upload-offset'),
        };
      } catch (e) {
        return { status: null, error: String(e) };
      }
    },
    { url, init },
  );
}

function ffmpeg(args: string[], out: string): Buffer {
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...args,
    out,
  ]);
  return readFileSync(out);
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function stream(path: string, init: RequestInit = {}) {
  return fetch(`${STREAM_API}${path}`, {
    ...init,
    headers: {
      AccessKey: libraryKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

/**
 * D50: delete what a test uploaded. Every step is tried, even if an earlier one throws or answers
 * an unexpected status, and only then are the results checked. The checks are soft, so a cleanup
 * failure is reported alongside, never instead of, a failure in the test itself.
 */
async function cleanUp(
  steps: { name: string; ok: number[]; run: () => Promise<Response> }[],
) {
  const results: { name: string; ok: number[]; result: number | string }[] = [];
  for (const step of steps) {
    let result: number | string;
    try {
      result = (await step.run()).status;
    } catch (e) {
      result = String(e);
    }
    results.push({ ...step, result });
  }
  for (const { name, ok, result } of results) {
    expect.soft(ok, `${name}: ${result}`).toContain(result);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(WEB_URL);
  expect(new URL(page.url()).origin).toBe(new URL(WEB_URL).origin);
});

test('a WebP uploads from web’s origin by presigned PUT, once, and only as signed', async ({
  page,
}, info) => {
  const webp = ffmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=280x280:rate=1:duration=1',
      '-vf',
      'noise=alls=24:allf=u',
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      '70',
    ],
    info.outputPath('spike.webp'),
  );
  expect(webp.length).toBeGreaterThan(15_000);
  expect(webp.length).toBeLessThan(25_000);
  const body = [...webp];
  // A folder per run, as api-user will use a folder per story (D80).
  const folder = `${TEST_PREFIX}-${randomUUID()}`;
  const key = `${folder}/image.webp`;
  // What api-user will pin: the key it picked, type, exact size, one-shot, a few minutes.
  const pinned = {
    'content-type': 'image/webp',
    'content-length': webp.length,
    'if-none-match': '*',
  };
  const put = presignStorageUrl(zone, {
    method: 'PUT',
    key,
    expiresIn: 300,
    headers: pinned,
  });
  const asSigned = { 'Content-Type': 'image/webp', 'If-None-Match': '*' };

  try {
    // Refused unless the request is exactly what was signed (all before the real upload).
    const refused = {
      'another type': await browserFetch(page, put, {
        method: 'PUT',
        headers: { ...asSigned, 'Content-Type': 'image/png' },
        body,
      }),
      'a bigger file': await browserFetch(page, put, {
        method: 'PUT',
        headers: asSigned,
        body: [...body, 0],
      }),
      'overwrite allowed': await browserFetch(page, put, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body,
      }),
      'another key': await browserFetch(
        page,
        put.replace(key, `${folder}/other.webp`),
        {
          method: 'PUT',
          headers: asSigned,
          body,
        },
      ),
      expired: await browserFetch(
        page,
        presignStorageUrl(zone, {
          method: 'PUT',
          key,
          expiresIn: 60,
          headers: pinned,
          now: new Date(Date.now() - 5 * 60_000),
        }),
        { method: 'PUT', headers: asSigned, body },
      ),
    };
    expect(
      Object.fromEntries(
        Object.entries(refused).map(([k, r]) => [k, r.status]),
      ),
    ).toEqual({
      'another type': 403,
      'a bigger file': 403,
      'overwrite allowed': 403,
      'another key': 403,
      expired: 403,
    });

    expect(
      (
        await browserFetch(page, put, {
          method: 'PUT',
          headers: asSigned,
          body,
        })
      ).status,
    ).toBe(200);
    // One-shot: the same link can't replace what it uploaded.
    expect(
      (
        await browserFetch(page, put, {
          method: 'PUT',
          headers: asSigned,
          body,
        })
      ).status,
    ).toBe(412);

    // It arrived, byte for byte, as a WebP.
    const stored = await fetch(
      presignStorageUrl(zone, { method: 'GET', key, expiresIn: 60 }),
    );
    expect(stored.status).toBe(200);
    expect(stored.headers.get('content-type')).toBe('image/webp');
    expect(sha256(new Uint8Array(await stored.arrayBuffer()))).toBe(
      sha256(webp),
    );
  } finally {
    await cleanUp([
      {
        name: 'delete the image',
        ok: [204, 404],
        run: () =>
          fetch(
            presignStorageUrl(zone, { method: 'DELETE', key, expiresIn: 60 }),
            {
              method: 'DELETE',
            },
          ),
      },
      // Deleting a folder's last object leaves the folder behind (Bunny's storage keeps it), so
      // the folder is deleted too, through the Edge Storage API. It deletes what's inside it as
      // well, so it also cleans up if the image delete failed.
      {
        name: 'delete the folder',
        ok: [200, 404],
        run: () =>
          fetch(`${STORAGE_API}/${folder}/`, {
            method: 'DELETE',
            headers: { AccessKey: zone.password },
          }),
      },
    ]);
  }
  const gone = await fetch(
    presignStorageUrl(zone, { method: 'GET', key, expiresIn: 60 }),
  );
  expect(gone.status).toBe(404);
  const root = await fetch(`${STORAGE_API}/`, {
    headers: { AccessKey: zone.password, Accept: 'application/json' },
  });
  const names = ((await root.json()) as { ObjectName: string }[]).map(
    (o) => o.ObjectName,
  );
  expect(names).not.toContain(folder);
});

test('a 2-second clip uploads from web’s origin by presigned TUS and Bunny encodes it', async ({
  page,
}, info) => {
  test.setTimeout(5 * 60_000);
  const clip = ffmpeg(
    [
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
    ],
    info.outputPath('spike.mp4'),
  );
  // api-user's half: create the video (it saves the id on the draft, D80) and sign for it.
  const created = await stream('/videos', {
    method: 'POST',
    body: JSON.stringify({ title: `${TEST_PREFIX}/${randomUUID()}` }),
  });
  expect(created.status).toBe(200);
  const { guid } = (await created.json()) as { guid: string };

  try {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const tusHeaders = (signature: string, exp = expires) => ({
      'Tus-Resumable': '1.0.0',
      AuthorizationSignature: signature,
      AuthorizationExpire: String(exp),
      VideoId: guid,
      LibraryId: LIBRARY_ID,
    });
    const signature = tusSignature(LIBRARY_ID, libraryKey, expires, guid);
    const start = (headers: Record<string, string>) =>
      browserFetch(page, TUS_ENDPOINT, {
        method: 'POST',
        headers: {
          ...headers,
          'Upload-Length': String(clip.length),
          'Upload-Metadata': `filetype ${btoa('video/mp4')}`,
        },
      });

    // Refused: a wrong signature, or a moved expiry (the signature binds it).
    expect((await start(tusHeaders('0'.repeat(64)))).status).toBe(401);
    expect((await start(tusHeaders(signature, expires + 60))).status).toBe(401);

    const begun = await start(tusHeaders(signature));
    expect(begun.status).toBe(201);
    // The browser can read where to send the bytes (Bunny exposes Location to web's origin).
    expect(begun.location).toMatch(
      /^(https:\/\/video\.bunnycdn\.com)?\/tusupload\/\w+$/,
    );
    const sent = await browserFetch(
      page,
      new URL(begun.location ?? '', TUS_ENDPOINT).toString(),
      {
        method: 'PATCH',
        headers: {
          ...tusHeaders(signature),
          'Upload-Offset': '0',
          'Content-Type': 'application/offset+octet-stream',
        },
        body: [...clip],
      },
    );
    expect(sent).toMatchObject({ status: 204, offset: String(clip.length) });

    // It arrived: Bunny encodes it, 2 seconds long.
    await expect
      .poll(
        async () =>
          (
            (await (await stream(`/videos/${guid}`)).json()) as {
              status: number;
            }
          ).status,
        { timeout: 4 * 60_000, intervals: [5_000] },
      )
      .toBe(FINISHED);
    const video = (await (await stream(`/videos/${guid}`)).json()) as {
      length: number;
    };
    expect(video.length).toBe(2);
  } finally {
    await cleanUp([
      {
        name: 'delete the video',
        ok: [200, 404],
        run: () => stream(`/videos/${guid}`, { method: 'DELETE' }),
      },
    ]);
  }
  expect((await stream(`/videos/${guid}`)).status).toBe(404);
});

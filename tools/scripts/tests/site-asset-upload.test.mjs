// tools/scripts/site-asset-upload.mjs against a stand-in Bunny Stream API and a stub `gcloud`
// that hands out a fake library key: it uploads a site video into the `site-assets` collection
// once, sends nothing when the title is already there, refuses any environment but dev, and
// never prints the key.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../site-asset-upload.mjs', import.meta.url),
);
const KEY = 'fake-library-key-0f9e8d7c';
const COLLECTION = 'c0ffee00-0000-4000-8000-000000000001';
const NEW_GUID = 'aaaaaaaa-0000-4000-8000-000000000002';
const TITLE = 'The heart behind He Is Real';

let dir;
let server;
let api;
/** What the stand-in holds and was asked. */
let videos;
let requests;
/** When set, every request gets a 401 whose body repeats the key. */
let echoKey = false;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-asset-upload-'));
  writeFileSync(
    join(dir, 'gcloud'),
    `#!/bin/sh\necho "$@" >> "${join(dir, 'gcloud.log')}"\nprintf '%s\\n' '${KEY}'\n`,
  );
  chmodSync(join(dir, 'gcloud'), 0o755);
  writeFileSync(join(dir, 'video.mp4'), Buffer.alloc(1024, 7));
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        key: req.headers.accesskey,
        body: Buffer.concat(chunks),
      });
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.accesskey !== KEY) return send(401, {});
      // A Bunny that echoes the key back in an error body.
      if (echoKey)
        return send(401, {
          Message: `Invalid AccessKey ${req.headers.accesskey}`,
        });
      const lib = '/library/789855';
      if (req.method === 'GET' && url.pathname === `${lib}/collections`)
        return send(200, {
          items: [
            { guid: 'other', name: 'site-assets-old' },
            { guid: COLLECTION, name: 'site-assets' },
          ],
        });
      if (req.method === 'GET' && url.pathname === `${lib}/videos`)
        return send(200, {
          items: videos.filter(
            (v) =>
              v.collectionId === url.searchParams.get('collection') &&
              v.title.includes(url.searchParams.get('search')),
          ),
        });
      if (req.method === 'POST' && url.pathname === `${lib}/videos`) {
        const { title, collectionId } = JSON.parse(
          Buffer.concat(chunks).toString(),
        );
        videos.push({ guid: NEW_GUID, title, collectionId, status: 0 });
        return send(200, { guid: NEW_GUID, title });
      }
      if (url.pathname.startsWith(`${lib}/videos/`)) return send(200, {});
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function upload(...args) {
  requests = [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        SITE_ASSET_STREAM_API: api,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('uploads a new site video into the site-assets collection, once', async () => {
  videos = [
    // A story video with the same title elsewhere in the library doesn't count.
    { guid: 'story', title: TITLE, collectionId: '', status: 4 },
  ];
  const first = await upload(
    join(dir, 'video.mp4'),
    '--title',
    TITLE,
    '--description',
    'Hello.',
  );
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(NEW_GUID));
  const created = requests.find(
    (r) => r.method === 'POST' && r.path.endsWith('/videos'),
  );
  assert.deepEqual(JSON.parse(created.body), {
    title: TITLE,
    collectionId: COLLECTION,
  });
  const description = requests.find(
    (r) => r.method === 'POST' && r.path.endsWith(`/videos/${NEW_GUID}`),
  );
  assert.deepEqual(JSON.parse(description.body).metaTags, [
    { property: 'description', value: 'Hello.' },
  ]);
  const put = requests.find((r) => r.method === 'PUT');
  assert.equal(put.path, `/library/789855/videos/${NEW_GUID}`);
  assert.equal(put.body.length, 1024);
  assert.ok(requests.every((r) => r.key === KEY));
  assert.ok(!first.out.includes(KEY), 'the key is never printed');

  // Bunny has it now: a second run sends nothing.
  videos.find((v) => v.guid === NEW_GUID).status = 4;
  const second = await upload(join(dir, 'video.mp4'), '--title', TITLE);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, new RegExp(`${NEW_GUID} \\(finished\\)`));
  assert.deepEqual(
    requests.map((r) => r.method),
    ['GET', 'GET'],
  );
});

test('a video whose file never arrived gets it, without a second video', async () => {
  videos = [
    { guid: NEW_GUID, title: TITLE, collectionId: COLLECTION, status: 6 },
  ];
  const run = await upload(join(dir, 'video.mp4'), '--title', TITLE);
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(
    requests.map((r) => r.method),
    ['GET', 'GET', 'PUT'],
  );
});

test('refuses any environment but dev before reading a key', async () => {
  writeFileSync(join(dir, 'gcloud.log'), '');
  const run = await upload(
    join(dir, 'video.mp4'),
    '--title',
    TITLE,
    '--env',
    'prod',
  );
  assert.equal(run.code, 1);
  assert.match(run.out, /unknown environment "prod"/);
  assert.equal(requests.length, 0);
  assert.equal(readFileSync(join(dir, 'gcloud.log'), 'utf8'), '');
});

test('an error that echoes the key never prints it', async () => {
  echoKey = true;
  try {
    const run = await upload(join(dir, 'video.mp4'), '--title', TITLE);
    assert.equal(run.code, 1);
    assert.match(run.out, /HTTP 401/);
    assert.ok(requests.length > 0, 'the stand-in was asked');
    assert.ok(!run.out.includes(KEY), 'the key is never printed');
  } finally {
    echoKey = false;
  }
});

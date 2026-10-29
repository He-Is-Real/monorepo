#!/usr/bin/env node
// Uploads a site video (part of the site itself, never a story) to the Stream library's
// `site-assets` collection, which OpenTofu makes (modules/bunny). Idempotent: if the collection
// already has a video with this exact title, it uploads nothing and prints that video's GUID and
// state (a video whose upload never arrived gets its file now). Dev only unless another
// environment is added to ENVIRONMENTS below.
//
//   node tools/scripts/site-asset-upload.mjs <file> --title "<title>" [--description "<text>"] [--env dev]
//
// Then put the GUID it prints into OpenTofu (live/<env>/gcp, `site_videos`), so api-public-read
// signs it; see infra/terraform/README.md, "Site assets".
//
// The library key comes from Secret Manager (`bunny-stream-api-key`, written by the bunny root)
// through your own gcloud login, lives in this process only, and goes nowhere but Bunny's
// AccessKey header: never printed, never in a URL or an error (CI logs are public).
import { execFileSync } from 'node:child_process';
import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

const ENVIRONMENTS = {
  dev: { project: 'heisreal-dev', libraryId: '789855' },
};
const COLLECTION = 'site-assets';
// Bunny Stream video statuses (https://docs.bunny.net/reference/video_getvideo).
const STATUS = {
  0: 'created, no file yet',
  1: 'uploaded',
  2: 'processing',
  3: 'encoding',
  4: 'finished',
  5: 'error',
  6: 'upload failed',
  7: 'encoding (JIT)',
  8: 'encoding (JIT)',
};
const NEEDS_FILE = new Set([0, 6]);
// Tests point this at a stand-in (tools/scripts/tests/site-asset-upload.test.mjs).
const API = process.env.SITE_ASSET_STREAM_API ?? 'https://video.bunnycdn.com';

/** The library key, once read. Declared first so `fail` can always redact it. */
let key = '';

/** Prints `message` without the key (belt and braces: no message should hold it) and exits. */
function fail(message) {
  const safe = key ? message.replaceAll(key, '[redacted]') : message;
  console.error(`site-asset-upload: ${safe}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string' },
    description: { type: 'string' },
    env: { type: 'string', default: 'dev' },
  },
});
const [file, ...extra] = positionals;
if (!file || extra.length > 0 || !values.title?.trim()) {
  fail(
    'usage: site-asset-upload.mjs <file> --title "<title>" [--description "<text>"] [--env dev]',
  );
}
const title = values.title.trim();
const target = Object.hasOwn(ENVIRONMENTS, values.env)
  ? ENVIRONMENTS[values.env]
  : null;
if (!target) {
  fail(
    `unknown environment "${values.env}"; only ${Object.keys(ENVIRONMENTS).join(', ')} (add it to ENVIRONMENTS when it exists)`,
  );
}
let size;
try {
  size = statSync(file).size;
} catch {
  fail(`can't read ${file}`);
}

try {
  key = execFileSync(
    'gcloud',
    [
      'secrets',
      'versions',
      'access',
      'latest',
      '--secret=bunny-stream-api-key',
      `--project=${target.project}`,
      '--quiet',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
} catch {
  fail(
    `couldn't read bunny-stream-api-key in ${target.project} (gcloud auth login?)`,
  );
}
// Bunny's keys are letters, digits and dashes. Anything else could end up in fetch's own error
// message (an invalid header value), so it's refused here without showing it.
if (!/^[A-Za-z0-9-]+$/.test(key)) {
  fail('bunny-stream-api-key is empty or not a Bunny key');
}

const library = `${API}/library/${encodeURIComponent(target.libraryId)}`;

/** A Stream API call. Errors carry the method, path and status only. */
async function call(method, path, body, contentType = 'application/json') {
  const res = await fetch(`${library}${path}`, {
    method,
    headers: {
      AccessKey: key,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': contentType }),
    },
    body,
  });
  // Never Bunny's response body: it could echo what we sent, the key included.
  if (!res.ok) {
    throw new Error(
      `${method} ${new URL(res.url).pathname}: Bunny answered HTTP ${res.status}`,
    );
  }
  return res.json().catch(() => ({}));
}

try {
  const collections = await call(
    'GET',
    `/collections?search=${encodeURIComponent(COLLECTION)}&itemsPerPage=100`,
  );
  const collection = (collections.items ?? []).find(
    (c) => c.name === COLLECTION,
  );
  if (!collection) {
    fail(
      `no "${COLLECTION}" collection in library ${target.libraryId}: apply the bunny root first`,
    );
  }

  // Bunny's search is a substring match: keep exact titles only.
  const videos = await call(
    'GET',
    `/videos?collection=${encodeURIComponent(collection.guid)}&search=${encodeURIComponent(title)}&itemsPerPage=100`,
  );
  const same = (videos.items ?? []).filter((v) => v.title === title);
  if (same.length > 1) {
    fail(
      `${same.length} videos titled "${title}" in ${COLLECTION}: delete the extra ones first (${same.map((v) => v.guid).join(', ')})`,
    );
  }
  let video = same[0];
  if (video && !NEEDS_FILE.has(video.status)) {
    console.log(
      `Already uploaded, nothing sent: "${title}" is ${video.guid} (${STATUS[video.status] ?? `status ${video.status}`}).`,
    );
  } else {
    if (!video) {
      video = await call(
        'POST',
        '/videos',
        JSON.stringify({ title, collectionId: collection.guid }),
      );
      console.log(`Created "${title}" as ${video.guid} in ${COLLECTION}.`);
    } else {
      console.log(`"${title}" (${video.guid}) has no file yet: uploading it.`);
    }
    if (values.description?.trim()) {
      await call(
        'POST',
        `/videos/${encodeURIComponent(video.guid)}`,
        JSON.stringify({
          title,
          metaTags: [
            { property: 'description', value: values.description.trim() },
          ],
        }),
      );
    }
    console.log(
      `Uploading ${basename(file)} (${(size / 1e6).toFixed(1)} MB) to ${values.env}...`,
    );
    await call(
      'PUT',
      `/videos/${encodeURIComponent(video.guid)}`,
      await openAsBlob(file),
      'application/octet-stream',
    );
    console.log(
      `Uploaded. Bunny is encoding it; run this again to see its state.`,
    );
  }
  console.log(
    `Next: set its GUID in live/${values.env}/gcp/main.tf, site_videos = { <key> = "${video.guid}" }.`,
  );
} catch (err) {
  fail(err instanceof Error ? err.message : 'failed');
}

/**
 * Uploads the dummy media (D47) to the DEV Bunny library and storage zone, once: each clip is
 * found again by its title (`dev-seed/<id>`) and each image by its path (`dev-seed/<id>.webp`),
 * and only what's missing is uploaded, so running it again uploads nothing. It records Bunny's
 * video ids and encode results (size, duration) in src/app/bunny-media.json, which you commit;
 * the dev-seed Job reads only that file and never talks to Bunny.
 *
 * A developer runs it (it needs the dev `bunny-stream-api-key` and `bunny-storage-password`
 * from Secret Manager, which only developers and tf-bunny can read):
 *
 *   pnpm nx run dev-seed:generate-media
 *   pnpm nx run dev-seed:upload-media --args="--library-id <dev Stream library id> [--dry-run]"
 *
 * The library id: `tools/scripts/tf.sh bunny output bunny` (stream_library_id). Prints ids,
 * sizes and statuses, never a key.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { SecretsService } from '@heisreal/secrets';
import { DEV_PROJECT } from '../app/config';
import {
  type BunnyMedia,
  CLIPS,
  IMAGES,
  imagePath,
  type ClipId,
  type ImageId,
} from '../app/media';
import {
  Bunny,
  clipTitle,
  recordClip,
  recordImage,
  serialise,
  VIDEO_STATUS,
} from './bunny';
import { clipFile, imageFile } from './ffmpeg';
import { MEDIA_DIR } from './generate';

const RECORD = join(__dirname, '../app/bunny-media.json');
const STORAGE_ZONE = 'heisreal-dev-images';
const STORAGE_HOST = 'uk.storage.bunnycdn.com'; // the zone's region: London

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'library-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const libraryId = values['library-id'];
  if (!libraryId || !/^\d+$/.test(libraryId)) {
    throw new Error(
      '--library-id <the dev Stream library id> is required (tf.sh bunny output bunny)',
    );
  }
  const dryRun = values['dry-run'] ?? false;
  const secrets = new SecretsService(
    new SecretManagerServiceClient(),
    DEV_PROJECT,
  );
  const bunny = new Bunny({
    libraryId,
    libraryKey: await secrets.get('bunny-stream-api-key'),
    storageZone: STORAGE_ZONE,
    storagePassword: await secrets.get('bunny-storage-password'),
    storageHost: STORAGE_HOST,
  });

  const record = JSON.parse(readFileSync(RECORD, 'utf8')) as BunnyMedia;
  if (record.libraryId && record.libraryId !== libraryId) {
    throw new Error(
      `bunny-media.json is for library ${record.libraryId}, not ${libraryId}`,
    );
  }
  const media: BunnyMedia = {
    libraryId,
    clips: { ...record.clips },
    images: { ...record.images },
  };

  for (const [id, spec] of Object.entries(CLIPS) as [
    ClipId,
    (typeof CLIPS)[ClipId],
  ][]) {
    const title = clipTitle(id);
    const found = await bunny.findVideo(title);
    if (found.length > 1)
      throw new Error(
        `${title}: ${found.length} videos with this title; delete the extras`,
      );
    let guid = found[0]?.guid;
    if (!guid) {
      if (dryRun) {
        console.log(`${title}: missing, would upload ${clipFile(id, spec)}`);
        continue;
      }
      guid = await bunny.uploadVideo(
        title,
        readFileSync(join(MEDIA_DIR, clipFile(id, spec))),
      );
      console.log(
        `${title}: uploaded as ${guid}, waiting for Bunny to encode it`,
      );
    } else if (found[0].status !== VIDEO_STATUS.finished) {
      console.log(
        `${title}: found ${guid} (status ${found[0].status}), waiting`,
      );
    }
    if (dryRun && found[0]?.status !== VIDEO_STATUS.finished) continue;
    media.clips[id] = recordClip(id, spec, await bunny.waitForVideo(guid));
    console.log(`${title}: ${JSON.stringify(media.clips[id])}`);
  }

  for (const [id, spec] of Object.entries(IMAGES) as [
    ImageId,
    (typeof IMAGES)[ImageId],
  ][]) {
    const path = imagePath(id);
    const bytes = readFileSync(join(MEDIA_DIR, imageFile(id)));
    const size = await bunny.storedSize(path);
    if (size === null) {
      if (dryRun) {
        console.log(`${path}: missing, would upload ${bytes.length} bytes`);
        continue;
      }
      await bunny.putFile(path, bytes);
      console.log(`${path}: uploaded, ${bytes.length} bytes`);
    } else {
      console.log(`${path}: already there (${size} bytes)`);
    }
    media.images[id] = recordImage(path, spec);
  }

  if (dryRun) {
    console.log('Dry run: bunny-media.json not changed.');
    return;
  }
  writeFileSync(RECORD, serialise(media));
  console.log(`Wrote ${RECORD}. Commit it; the dev-seed Job reads it.`);
}

main().catch((err) => {
  console.error(`upload-media failed: ${(err as Error).message}`);
  process.exit(1);
});

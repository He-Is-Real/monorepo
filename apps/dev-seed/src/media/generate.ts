/**
 * Generates the dummy media (D47) with ffmpeg into tmp/dev-seed-media (git-ignored), then checks
 * each file with ffprobe against the spec in src/app/media.ts. Run once by a developer before
 * `upload-media`; the files aren't committed (the uploaded copies are the ones that matter,
 * and the spec regenerates equivalent files any time).
 *
 *   pnpm nx run dev-seed:generate-media     (needs ffmpeg and ffprobe, with libx264, libwebp,
 *                                            libmp3lame and drawtext)
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPS, IMAGES, type ClipSpec, type ImageSpec } from '../app/media';
import { exifBlock, readGps, withExif } from './exif';
import { clipArgs, clipFile, imageArgs, imageFile } from './ffmpeg';

export const MEDIA_DIR = join(__dirname, '../../../../tmp/dev-seed-media');
const IMAGE_BYTES = { min: 50_000, max: 150_000 }; // D47: 50–150 KB each

interface Probe {
  width?: number;
  height?: number;
  durationSeconds: number;
}

export function probe(file: string): Probe {
  const out = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height:format=duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration?: string };
  };
  const video = out.streams.find((s) => s.codec_type === 'video');
  return {
    width: video?.width,
    height: video?.height,
    durationSeconds: Math.round(Number(out.format.duration ?? 0)),
  };
}

function generateClip(id: string, clip: ClipSpec, work: string): void {
  const label = join(work, `${id}.txt`);
  writeFileSync(label, clip.label);
  const out = join(MEDIA_DIR, clipFile(id, clip));
  execFileSync('ffmpeg', clipArgs(clip, label, out), { stdio: 'inherit' });
  const p = probe(out);
  const expected = {
    width: clip.width,
    height: clip.height,
    durationSeconds: clip.durationSeconds,
  };
  if (JSON.stringify(p) !== JSON.stringify(expected)) {
    throw new Error(
      `${id}: ffprobe says ${JSON.stringify(p)}, the spec ${JSON.stringify(expected)}`,
    );
  }
  console.log(
    `${clipFile(id, clip)}: ${clip.label}, ${statSync(out).size} bytes`,
  );
}

function generateImage(id: string, image: ImageSpec, work: string): void {
  const label = join(work, `${id}.txt`);
  writeFileSync(label, image.label);
  const plain = join(work, imageFile(id));
  // Lower the quality until the file is inside D47's size range.
  for (const quality of [80, 70, 60, 50, 40, 30, 20]) {
    execFileSync('ffmpeg', imageArgs(image, label, plain, quality), {
      stdio: 'inherit',
    });
    if (statSync(plain).size <= IMAGE_BYTES.max) break;
  }
  const out = join(MEDIA_DIR, imageFile(id));
  const tagged = withExif(
    readFileSync(plain),
    exifBlock(`${image.label} (dummy image for development)`, image.gps),
    image.width,
    image.height,
  );
  writeFileSync(out, tagged);
  const p = probe(out);
  if (p.width !== image.width || p.height !== image.height) {
    throw new Error(
      `${id}: ffprobe says ${p.width}x${p.height}, the spec ${image.width}x${image.height}`,
    );
  }
  const gps = readGps(tagged);
  if (!gps) throw new Error(`${id}: no GPS position in the file`);
  if (tagged.length < IMAGE_BYTES.min || tagged.length > IMAGE_BYTES.max) {
    console.warn(`${id}: ${tagged.length} bytes, outside D47's 50–150 KB`);
  }
  console.log(
    `${imageFile(id)}: ${image.label}, ${tagged.length} bytes, GPS ${gps.latitude.toFixed(4)},${gps.longitude.toFixed(4)}`,
  );
}

function main(): void {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'dev-seed-media-'));
  try {
    for (const [id, clip] of Object.entries(CLIPS))
      generateClip(id, clip, work);
    for (const [id, image] of Object.entries(IMAGES))
      generateImage(id, image, work);
    console.log(
      `Done: ${MEDIA_DIR}. Next: pnpm nx run dev-seed:upload-media (README in apps/dev-seed).`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) main();

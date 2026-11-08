import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { BunnyFailure, type BunnyLibrary } from './bunny';

/**
 * An audio story's picture video (Joel, 2026-11-07: audio-picture-video.html decisions 1B, 2 = K1
 * and 4 = own shape). The worker takes the sound from Bunny's largest MP4 copy of the story's
 * file, read from the library's storage with its read-only password (never through Bunny's CDN,
 * which would keep the old copy), puts it under the story's picture (or the site's default
 * background) with ffmpeg, the sound copied unchanged and every tag dropped, and uploads the file
 * to the one new Bunny video its pass is for. Files live in a folder of their own in memory
 * ($XDG_RUNTIME_DIR, tools/scripts/media-worker.sh) only while the job runs.
 */

/** What the writer's upload-pass route gives the worker (worker.yaml `UploadPassReply`). */
export interface RenderPass {
  renderVideoId: string;
  title: string;
  upload: {
    uploadUrl: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
  picture: string | null;
  pictureUrl: string | null;
}

/** The finished upload's size, or a short failure code for the job (mediaJob.lastError). */
export type RenderResult = { sizeBytes: number } | { failure: string };

export interface Renderer {
  /** Makes the picture video of `sourceVideoId`'s sound and uploads it with `pass`. */
  render(sourceVideoId: string, pass: RenderPass): Promise<RenderResult>;
}

const STORAGE = 'https://storage.bunnycdn.com';
const ZONE = /^[A-Za-z0-9-]{1,64}$/;
/** Bunny makes MP4 copies up to 1080p (Bunny's docs, "MP4 downloads"). */
const MP4_MAX_HEIGHT = 1080;
/** Our longest story's sound is far smaller; anything bigger isn't one of ours. */
const MAX_SOURCE_BYTES = 2 * 1024 ** 3;
/** Pictures are WebP at most 5 MB, 4096 px on either side (fn::upload::image_limits). */
const MAX_PICTURE_BYTES = 5 * 1024 ** 2;
const MAX_PICTURE_SIDE = 4096;
/**
 * The picture video's file: the sound copied plus a picture a second, so never far over the sound
 * itself. ffmpeg stops writing there (`-fs`), and a file that reaches it is refused, not uploaded.
 */
export const MAX_OUTPUT_BYTES = MAX_SOURCE_BYTES;
/**
 * ffmpeg's threads: Joel's machine runs other things, and a still picture needs few. With one
 * render at a time (the worker's render slot), a render never takes more than two cores.
 */
const FFMPEG_THREADS = '2';
const FETCH_TIMEOUT_MS = 10 * 60_000;
const FFMPEG_TIMEOUT_MS = 15 * 60_000;
/** TUS chunks: small enough to retry cheaply, large enough to be quick. */
const CHUNK_BYTES = 8 * 1024 ** 2;

/** A picture ffmpeg reads: a story's WebP, or the site's default background (a JPEG). */
export type PictureFormat = 'webp' | 'jpeg';

/**
 * The render (audio-picture-video.html section 3): one picture frame a second, at most 1280 px on
 * its longer side in the picture's own shape (decision 4), the sound copied as it is, and no tags,
 * chapters or other metadata from either file. A person uploaded the picture, so ffmpeg never
 * guesses what a file is: each input names its format (a WebP or JPEG image, Bunny's MP4) and may
 * read only local files, so no file can make ffmpeg open another file or a URL.
 */
export function ffmpegArgs(
  picture: string,
  pictureFormat: PictureFormat,
  sound: string,
  out: string,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-filter_threads',
    FFMPEG_THREADS,
    // Stop at the first decoding error: with a looped picture, ffmpeg would otherwise retry a
    // picture it can't decode until its timeout.
    '-xerror',
    '-protocol_whitelist',
    'file',
    '-f',
    pictureFormat === 'webp' ? 'webp_pipe' : 'jpeg_pipe',
    // The decoder enforces the picture limit itself too: a WebP's header (pictureFits) names
    // its canvas, and the frame inside might claim more.
    '-max_pixels',
    String(MAX_PICTURE_SIDE * MAX_PICTURE_SIDE),
    '-loop',
    '1',
    '-framerate',
    '1',
    '-i',
    picture,
    '-protocol_whitelist',
    'file',
    '-f',
    'mov',
    '-i',
    sound,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-vf',
    "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-crf',
    '30',
    '-r',
    '1',
    '-g',
    '10',
    '-c:a',
    'copy',
    '-shortest',
    '-threads',
    FFMPEG_THREADS,
    '-fs',
    String(MAX_OUTPUT_BYTES),
    '-movflags',
    '+faststart',
    out,
  ];
}

/**
 * The MP4 copies to try, largest first: those Bunny lists as encoded (up to 1080p), then the
 * library's usual sizes in case the list is behind.
 */
export function mp4Heights(resolutions: unknown): number[] {
  const listed =
    typeof resolutions === 'string'
      ? resolutions
          .split(',')
          .map((r) => /^([0-9]{3,4})p$/.exec(r.trim())?.[1])
          .filter((h): h is string => h !== undefined)
          .map(Number)
          .filter((h) => h <= MP4_MAX_HEIGHT)
      : [];
  return [...new Set([...listed.sort((a, b) => b - a), 720, 480, 360])];
}

/** Whether a file starts as a WebP image ("RIFF", its size, "WEBP") or a JPEG does. */
export function isPicture(head: Buffer, format: PictureFormat): boolean {
  return format === 'webp'
    ? head.length >= 12 &&
        head.toString('latin1', 0, 4) === 'RIFF' &&
        head.toString('latin1', 8, 12) === 'WEBP'
    : head.length >= 3 &&
        head[0] === 0xff &&
        head[1] === 0xd8 &&
        head[2] === 0xff;
}

/**
 * A WebP's real size, from its header (Google's WebP container spec): the canvas of an extended
 * file (VP8X), or the frame of a simple lossy (VP8) or lossless (VP8L) one. null if the header is
 * none of those, so the picture is refused.
 */
export function webpSize(
  head: Buffer,
): { width: number; height: number } | null {
  if (head.length < 30 || !isPicture(head, 'webp')) return null;
  switch (head.toString('latin1', 12, 16)) {
    case 'VP8X':
      return {
        width: head.readUIntLE(24, 3) + 1,
        height: head.readUIntLE(27, 3) + 1,
      };
    case 'VP8L': {
      if (head[20] !== 0x2f) return null;
      const bits = head.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    case 'VP8 ':
      if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) {
        return null;
      }
      return {
        width: head.readUInt16LE(26) & 0x3fff,
        height: head.readUInt16LE(28) & 0x3fff,
      };
    default:
      return null;
  }
}

/** Whether a picture's header says it is within the site's limits, before anything decodes it. */
export function pictureFits(head: Buffer, format: PictureFormat): boolean {
  if (!isPicture(head, format)) return false;
  // The default background is ours; only a person's WebP is measured.
  if (format === 'jpeg') return true;
  const size = webpSize(head);
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_PICTURE_SIDE &&
    size.height <= MAX_PICTURE_SIDE
  );
}

/** Enough of a picture's start for its type and (a WebP's) size. */
const HEAD_BYTES = 30;

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

class RenderFailure extends Error {
  override name = 'RenderFailure';
  constructor(readonly code: string) {
    super(code);
  }
}

export interface FfmpegRendererConfig {
  /** Reads the source video's status and sizes with the library's read-only key. */
  bunny: BunnyLibrary;
  /** The library's storage zone (its name) and that zone's read-only password. */
  storageZone: string;
  storagePassword: () => Promise<string>;
  /** Where the job's files go (in memory), and the site's default background (a JPEG). */
  workDir: string;
  defaultPicture: string;
  ffmpeg?: string;
  fetcher?: typeof fetch;
}

export class FfmpegRenderer implements Renderer {
  // One render at a time: the worker's render slot (worker.ts RenderSlot) sees to it.
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: FfmpegRendererConfig) {
    if (!ZONE.test(config.storageZone))
      throw new Error('Malformed storage zone');
    this.fetcher = config.fetcher ?? fetch;
  }

  async render(sourceVideoId: string, pass: RenderPass): Promise<RenderResult> {
    const dir = await mkdtemp(join(this.config.workDir, 'render-'));
    try {
      const sound = join(dir, 'sound.mp4');
      await this.fetchSound(sourceVideoId, sound);
      let picture = this.config.defaultPicture;
      let format: PictureFormat = 'jpeg';
      if (pass.pictureUrl) {
        picture = join(dir, 'picture.webp');
        await this.download(
          pass.pictureUrl,
          {},
          picture,
          MAX_PICTURE_BYTES,
          'picture_unreachable',
        );
        format = 'webp';
      }
      // Only a WebP (or the default JPEG) goes to ffmpeg as its picture, and only one whose
      // header says it is within the site's picture limits.
      const head = await readHead(picture);
      if (!isPicture(head, format)) throw new RenderFailure('picture_not_webp');
      if (!pictureFits(head, format))
        throw new RenderFailure('picture_too_big');
      const out = join(dir, 'out.mp4');
      await this.ffmpeg(ffmpegArgs(picture, format, sound, out));
      const { size } = await stat(out);
      // ffmpeg stopped at its -fs limit: a cut-off file never goes to Bunny.
      if (size >= MAX_OUTPUT_BYTES) throw new RenderFailure('too_large');
      await this.upload(out, size, pass);
      return { sizeBytes: size };
    } catch (err) {
      if (err instanceof RenderFailure) return { failure: err.code };
      if (err instanceof BunnyFailure) return { failure: err.code };
      throw err;
    } finally {
      // Nothing of the story stays on the machine.
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Bunny's largest MP4 copy of the story's file, from storage (never the CDN). */
  private async fetchSound(videoId: string, to: string): Promise<void> {
    const video = await this.config.bunny.video(videoId);
    if (video === null) throw new RenderFailure('source_gone');
    if (video.status !== 4) throw new RenderFailure('source_not_ready');
    let password: string;
    try {
      password = (await this.config.storagePassword()).trim();
    } catch {
      throw new RenderFailure('key_unavailable');
    }
    if (!password) throw new RenderFailure('key_unavailable');
    for (const height of mp4Heights(video.availableResolutions)) {
      const url = `${STORAGE}/${this.config.storageZone}/${videoId}/play_${height}p.mp4`;
      if (
        await this.download(
          url,
          { AccessKey: password },
          to,
          MAX_SOURCE_BYTES,
          'source_unreachable',
          true,
        )
      ) {
        return;
      }
    }
    throw new RenderFailure('source_missing');
  }

  /**
   * Saves `url` to `to`, at most `max` bytes. With `missingOk`, a 404 answers false; anything else
   * that isn't a 200 fails with `code`.
   */
  private async download(
    url: string,
    headers: Record<string, string>,
    to: string,
    max: number,
    code: string,
    missingOk = false,
  ): Promise<boolean> {
    let res: Response;
    try {
      res = await this.fetcher(url, {
        headers,
        // A key or signed link goes to Bunny only, never on to wherever a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new RenderFailure(code);
    }
    if (missingOk && res.status === 404) return false;
    if (!res.ok || !res.body) throw new RenderFailure(code);
    let seen = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        done(seen > max ? new RenderFailure('too_large') : null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        cap,
        createWriteStream(to, { mode: 0o600 }),
      );
    } catch (err) {
      throw err instanceof RenderFailure ? err : new RenderFailure(code);
    }
    return true;
  }

  private ffmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      // Its error output can name the files: kept out of the log, only the exit counts.
      const child = spawn(this.config.ffmpeg ?? 'ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: FFMPEG_TIMEOUT_MS,
      });
      child.on('error', () => reject(new RenderFailure('ffmpeg_missing')));
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new RenderFailure('render_failed')),
      );
    });
  }

  /**
   * Bunny's resumable upload (TUS 1.0, as browsers use it) with the pass's headers: create the
   * upload, then send the file in chunks.
   */
  private async upload(
    file: string,
    size: number,
    pass: RenderPass,
  ): Promise<void> {
    const base = {
      ...pass.upload.headers,
      'Tus-Resumable': '1.0.0',
    };
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const created = await this.tus(pass.upload.uploadUrl, {
      method: 'POST',
      headers: {
        ...base,
        'Upload-Length': String(size),
        // The title is the story's id only (D69), as the browser's upload says.
        'Upload-Metadata': `filetype ${b64('video/mp4')},title ${b64(pass.title)}`,
      },
    });
    if (created.status !== 201) throw new RenderFailure('upload_refused');
    const location = created.headers.get('location');
    if (!location) throw new RenderFailure('upload_refused');
    const target = new URL(location, pass.upload.uploadUrl);
    if (target.origin !== new URL(pass.upload.uploadUrl).origin) {
      throw new RenderFailure('upload_refused');
    }
    const handle = await open(file, 'r');
    try {
      let offset = 0;
      while (offset < size) {
        const length = Math.min(CHUNK_BYTES, size - offset);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        const res = await this.tus(target.toString(), {
          method: 'PATCH',
          headers: {
            ...base,
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: chunk,
        });
        if (res.status !== 204) throw new RenderFailure('upload_refused');
        const next = Number(res.headers.get('upload-offset'));
        if (!Number.isInteger(next) || next <= offset) {
          throw new RenderFailure('upload_refused');
        }
        offset = next;
      }
    } finally {
      await handle.close();
    }
  }

  private async tus(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new RenderFailure('upload_unreachable');
    }
  }
}

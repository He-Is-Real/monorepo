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
/** Pictures are WebP at most 5 MB (fn::upload::image_limits). */
const MAX_PICTURE_BYTES = 5 * 1024 ** 2;
const FETCH_TIMEOUT_MS = 10 * 60_000;
const FFMPEG_TIMEOUT_MS = 15 * 60_000;
/** TUS chunks: small enough to retry cheaply, large enough to be quick. */
const CHUNK_BYTES = 8 * 1024 ** 2;

/**
 * The render (audio-picture-video.html section 3): one picture frame a second, at most 1280 px on
 * its longer side in the picture's own shape (decision 4), the sound copied as it is, and no tags,
 * chapters or other metadata from either file.
 */
export function ffmpegArgs(
  picture: string,
  sound: string,
  out: string,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-loop',
    '1',
    '-framerate',
    '1',
    '-i',
    picture,
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
  /** Where the job's files go (in memory), and the site's default background. */
  workDir: string;
  defaultPicture: string;
  ffmpeg?: string;
  fetcher?: typeof fetch;
}

export class FfmpegRenderer implements Renderer {
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
      if (pass.pictureUrl) {
        picture = join(dir, 'picture.webp');
        await this.download(
          pass.pictureUrl,
          {},
          picture,
          MAX_PICTURE_BYTES,
          'picture_unreachable',
        );
      }
      const out = join(dir, 'out.mp4');
      await this.ffmpeg(ffmpegArgs(picture, sound, out));
      const { size } = await stat(out);
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

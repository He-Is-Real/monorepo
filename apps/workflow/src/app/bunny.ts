import type { SecretsService } from '@heisreal/secrets';
import { signCdnUrl, tusSignature } from '@heisreal/story-cards';

/**
 * Bunny, as the result writer uses it (Joel, 2026-11-07: audio-picture-video.html decisions 1B
 * and 2 = K1; 2026-11-06: video-bundle-rethink.html part A). The full library key never leaves
 * Google Cloud: with it the writer makes an audio story's picture video at Bunny and signs the
 * worker a one-hour upload pass for that one video, and tells Bunny which picture to show for a
 * video. With the images zone's token key it signs a 10-minute link to the story's picture, for
 * the worker (its picture video) or for Bunny (a video's thumbnail). With the sound zone's token
 * key it signs the worker a 2-minute link to one MP4 copy of an audio file, when the worker is
 * about to download it (Joel, 2026-11-08, R3: single-file links on a need-to-use basis). The keys
 * come from Secret Manager and are never logged.
 */
export const WRITER_BUNNY = Symbol('WRITER_BUNNY');

const API = 'https://video.bunnycdn.com';
/** Where the worker sends its upload (Bunny's resumable uploads, as browsers use). */
export const TUS_ENDPOINT = `${API}/tusupload`;
/**
 * How long the worker's upload pass lasts: one hour, as a person's (decision 2, K1). The
 * database's fn::upload::link_lifetime('audio') says the same: a moderator waits that long after
 * the picture video's row is made before approving.
 */
export const UPLOAD_PASS_SECONDS = 3600;
/** How long a link to a story's picture lasts: as long as a picture's upload link (D68). */
export const PICTURE_LINK_SECONDS = 600;
/**
 * How long a link to an audio file's sound lasts (R3): only long enough to start its download,
 * which the worker does at once. Bunny checks a link when the download starts, not while it runs.
 */
export const SOUND_LINK_SECONDS = 120;
/** The MP4 copies Bunny makes (its docs, "MP4 downloads"): the only files a sound link may name. */
export const SOUND_HEIGHTS = [240, 360, 480, 720, 1080] as const;
const TIMEOUT_MS = 15_000;

/** Bunny's video ids are GUIDs; anything else never reaches a URL. */
export const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One path segment at Bunny (fn::media::safe_segment). */
const FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
/** A story's own picture (fn::media::own_image). */
const PICTURE = /^stories\/[A-Za-z0-9_]{1,64}\/[0-9a-f]{32}\.webp$/;

/** Bunny wouldn't do what we asked, with a short code for the job's lastError. */
export class BunnyCallFailed extends Error {
  override name = 'BunnyCallFailed';
  constructor(readonly code: string) {
    super(code);
  }
}

/** The worker's one-hour pass to upload to one video (the contract's `UploadPass`). */
export interface UploadPass {
  uploadUrl: string;
  headers: {
    AuthorizationSignature: string;
    AuthorizationExpire: string;
    VideoId: string;
    LibraryId: string;
  };
  expiresAt: string;
}

export interface WriterBunny {
  /** Makes an empty video titled `title` (its story's id, D69); answers its id. */
  createVideo(title: string): Promise<string>;
  /** Whether Bunny still has the video (a picture video made for an earlier try). */
  exists(videoId: string): Promise<boolean>;
  /**
   * Shows `picture` (a story picture's path in the images zone) as the video's thumbnail, or, with
   * null, Bunny's own first frame again; answers the video's thumbnail file name afterwards.
   */
  setThumbnail(videoId: string, picture: string | null): Promise<string>;
  /** The worker's upload pass for that one video, for an hour from now. */
  uploadPass(videoId: string, now?: number): Promise<UploadPass>;
  /** A 10-minute link to a story's picture, or null if the path isn't one. */
  pictureUrl(path: string, now?: number): Promise<string | null>;
  /**
   * A 2-minute link to one MP4 copy (`height`p) of a video's sound, read straight from the
   * library's storage through the sound zone, which keeps no copies (R3); null if the video id or
   * height isn't one.
   */
  soundUrl(
    videoId: string,
    height: number,
    now?: number,
  ): Promise<{ url: string; expiresAt: string } | null>;
}

export interface WriterBunnyConfig {
  libraryId: string;
  imagesCdnHost: string;
  /** The sound zone's host (a pull zone over the library's storage, with no cache; R3). */
  soundCdnHost: string;
  /** Read once a few minutes old, so a rotated key arrives without a redeploy. */
  libraryKey: () => Promise<string>;
  imagesTokenKey: () => Promise<string>;
  soundTokenKey: () => Promise<string>;
}

export class BunnyLibrary implements WriterBunny {
  // The signing keys, read when a call needs them (both rotate at Bunny).
  private signingKeys: {
    library: string;
    images: string;
    sound: string;
  } | null = null;

  constructor(
    private readonly config: WriterBunnyConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Reads the keys (Secret Manager's cache reads them again once a few minutes old). */
  private async refreshKeys(): Promise<void> {
    let library: string;
    let images: string;
    let sound: string;
    try {
      library = (await this.config.libraryKey()).trim();
      images = (await this.config.imagesTokenKey()).trim();
      sound = (await this.config.soundTokenKey()).trim();
    } catch {
      throw new BunnyCallFailed('key_unavailable');
    }
    if (!library || !images || !sound) {
      throw new BunnyCallFailed('key_unavailable');
    }
    this.signingKeys = { library, images, sound };
  }

  private keys() {
    if (!this.signingKeys) throw new BunnyCallFailed('key_unavailable');
    return this.signingKeys;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    await this.refreshKeys();
    try {
      return await this.fetcher(
        `${API}/library/${this.config.libraryId}/videos${path}`,
        {
          method,
          headers: {
            AccessKey: this.keys().library,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          // The library key goes to Bunny's API only, never on to wherever a redirect points.
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      throw new BunnyCallFailed('bunny_unreachable');
    }
  }

  private static fail(res: Response): never {
    if (res.status === 401 || res.status === 403) {
      throw new BunnyCallFailed('bunny_refused');
    }
    if (res.status === 429 || res.status >= 500) {
      throw new BunnyCallFailed('bunny_unreachable');
    }
    throw new BunnyCallFailed('bunny_error');
  }

  async createVideo(title: string): Promise<string> {
    const res = await this.call('POST', '', { title });
    if (!res.ok) BunnyLibrary.fail(res);
    const { guid } = (await res.json().catch(() => ({}))) as { guid?: unknown };
    if (typeof guid !== 'string' || !VIDEO_ID.test(guid)) {
      throw new BunnyCallFailed('bunny_bad_reply');
    }
    return guid;
  }

  async exists(videoId: string): Promise<boolean> {
    if (!VIDEO_ID.test(videoId)) return false;
    const res = await this.call('GET', `/${videoId}`);
    if (res.status === 404) return false;
    if (!res.ok) BunnyLibrary.fail(res);
    return true;
  }

  async setThumbnail(videoId: string, picture: string | null): Promise<string> {
    if (!VIDEO_ID.test(videoId)) throw new BunnyCallFailed('bunny_error');
    await this.refreshKeys();
    // Bunny fetches the picture itself through a 10-minute link; null puts back its own first
    // frame (Bunny's docs, "Set Thumbnail": thumbnail_1.jpg is one it made).
    const source =
      picture === null
        ? 'thumbnail_1.jpg'
        : this.signPicture(picture, Date.now());
    if (!source) throw new BunnyCallFailed('picture_unsafe');
    const set = await this.call(
      'POST',
      `/${videoId}/thumbnail?thumbnailUrl=${encodeURIComponent(source)}`,
    );
    if (!set.ok) BunnyLibrary.fail(set);
    const res = await this.call('GET', `/${videoId}`);
    if (!res.ok) BunnyLibrary.fail(res);
    const { thumbnailFileName } = (await res.json().catch(() => ({}))) as {
      thumbnailFileName?: unknown;
    };
    if (
      typeof thumbnailFileName !== 'string' ||
      !FILE_NAME.test(thumbnailFileName) ||
      thumbnailFileName === '.' ||
      thumbnailFileName === '..'
    ) {
      throw new BunnyCallFailed('bunny_bad_reply');
    }
    return thumbnailFileName;
  }

  async uploadPass(videoId: string, now = Date.now()): Promise<UploadPass> {
    await this.refreshKeys();
    const expires = Math.floor(now / 1000) + UPLOAD_PASS_SECONDS;
    const { libraryId } = this.config;
    return {
      uploadUrl: TUS_ENDPOINT,
      headers: {
        AuthorizationSignature: tusSignature(
          libraryId,
          this.keys().library,
          expires,
          videoId,
        ),
        AuthorizationExpire: String(expires),
        VideoId: videoId,
        LibraryId: libraryId,
      },
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  async pictureUrl(path: string, now = Date.now()): Promise<string | null> {
    await this.refreshKeys();
    return this.signPicture(path, now);
  }

  async soundUrl(
    videoId: string,
    height: number,
    now = Date.now(),
  ): Promise<{ url: string; expiresAt: string } | null> {
    if (
      !VIDEO_ID.test(videoId) ||
      !(SOUND_HEIGHTS as readonly number[]).includes(height)
    ) {
      return null;
    }
    await this.refreshKeys();
    const expires = Math.floor(now / 1000) + SOUND_LINK_SECONDS;
    const url = signCdnUrl(
      this.config.soundCdnHost,
      `${videoId}/play_${height}p.mp4`,
      this.keys().sound,
      expires,
    );
    return url
      ? { url, expiresAt: new Date(expires * 1000).toISOString() }
      : null;
  }

  private signPicture(path: string, now: number): string | null {
    if (!PICTURE.test(path)) return null;
    return signCdnUrl(
      this.config.imagesCdnHost,
      path,
      this.keys().images,
      Math.floor(now / 1000) + PICTURE_LINK_SECONDS,
    );
  }
}

type Env = Record<string, string | undefined>;
const VARIABLES = [
  'BUNNY_STREAM_LIBRARY_ID',
  'BUNNY_STREAM_API_KEY_SECRET',
  'BUNNY_IMAGES_CDN_HOST',
  'BUNNY_IMAGES_TOKEN_KEY_SECRET',
  'BUNNY_SOUND_CDN_HOST',
  'BUNNY_SOUND_TOKEN_KEY_SECRET',
] as const;
const HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const FORMATS: Record<(typeof VARIABLES)[number], RegExp> = {
  BUNNY_STREAM_LIBRARY_ID: /^[0-9]{1,12}$/,
  BUNNY_STREAM_API_KEY_SECRET: /^[A-Za-z0-9_-]{1,255}$/,
  BUNNY_IMAGES_CDN_HOST: HOST,
  BUNNY_IMAGES_TOKEN_KEY_SECRET: /^[A-Za-z0-9_-]{1,255}$/,
  BUNNY_SOUND_CDN_HOST: HOST,
  BUNNY_SOUND_TOKEN_KEY_SECRET: /^[A-Za-z0-9_-]{1,255}$/,
};
/** How long a key read from Secret Manager is used before it is read again. */
const KEY_MAX_AGE_MS = 5 * 60_000;

/**
 * Bunny on when every variable is set (OpenTofu, modules/gcp/media.tf), off (null) when none is:
 * then no picture video is made (the render routes answer 503 and the worker tries later) and a
 * video's thumbnail isn't set. Anything in between fails startup.
 */
export function writerBunnyFromEnv(
  secrets: Pick<SecretsService, 'get'>,
  env: Env = process.env,
): WriterBunny | null {
  const value = (k: (typeof VARIABLES)[number]) => env[k]?.trim() ?? '';
  const missing = VARIABLES.filter((k) => value(k) === '');
  if (missing.length === VARIABLES.length) return null;
  if (missing.length > 0) {
    throw new Error(
      `Bunny needs every variable or none; missing ${missing.join(', ')}`,
    );
  }
  const malformed = VARIABLES.filter((k) => !FORMATS[k].test(value(k)));
  if (malformed.length > 0)
    throw new Error(`Malformed ${malformed.join(', ')}`);
  return new BunnyLibrary({
    libraryId: value('BUNNY_STREAM_LIBRARY_ID'),
    imagesCdnHost: value('BUNNY_IMAGES_CDN_HOST'),
    soundCdnHost: value('BUNNY_SOUND_CDN_HOST'),
    libraryKey: () =>
      secrets.get(value('BUNNY_STREAM_API_KEY_SECRET'), 'latest', {
        maxAgeMs: KEY_MAX_AGE_MS,
      }),
    imagesTokenKey: () =>
      secrets.get(value('BUNNY_IMAGES_TOKEN_KEY_SECRET'), 'latest', {
        maxAgeMs: KEY_MAX_AGE_MS,
      }),
    soundTokenKey: () =>
      secrets.get(value('BUNNY_SOUND_TOKEN_KEY_SECRET'), 'latest', {
        maxAgeMs: KEY_MAX_AGE_MS,
      }),
  });
}

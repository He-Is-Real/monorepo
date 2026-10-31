import { Logger } from '@nestjs/common';
import type { SecretsService } from '@heisreal/secrets';
import { tusSignature } from '@heisreal/story-cards';

/**
 * Bunny Stream for uploads (M2 plan PR 7; D68, D80, D89): api-user creates each story's video,
 * signs the browser's TUS upload for it, checks it arrived and deletes replaced ones. At submit it
 * sets a video's own picture as its thumbnail (O1 a), and "Download my data" asks whether Bunny
 * kept a video's original file (O2 B). The library
 * key (`bunny-stream-api-key`, which only api-user may read: `upload_key_readers`, bunny root)
 * comes from Secret Manager at startup and is never logged. Video and audio both go to the
 * library (in Frankfurt, D89): an audio story is an audio-only upload Bunny encodes like a video.
 * Without `BUNNY_STREAM_API_KEY_SECRET`, uploads are off and RequestUpload answers `503`.
 */
export const BUNNY_STREAM = Symbol('BUNNY_STREAM');

const API = 'https://video.bunnycdn.com';
/** Where the browser sends the TUS upload (infra/terraform/README.md, "Uploads"). */
export const TUS_ENDPOINT = `${API}/tusupload`;
/** How long an upload link lasts (D68: about an hour). A resume after that gets a new one. */
export const UPLOAD_LINK_SECONDS = 3600;
const TIMEOUT_MS = 15_000;

/**
 * Bunny's video statuses (https://docs.bunny.net/reference/video_getvideo): 0 created (nothing
 * uploaded yet), 1 uploaded, 2 processing, 3 transcoding, 4 finished, 5 error (couldn't be
 * encoded), 6 upload failed, 7–8 still being prepared (just-in-time encoding).
 */
export interface StreamVideo {
  status: number;
  /** Seconds, once Bunny has read the file (0 before). */
  length: number;
  /** Bunny kept the file as uploaded (`<video id>/original`; the library keeps originals, O2 B). */
  hasOriginal: boolean;
}

/** What RequestUpload returns for the browser's TUS client: the contract's `UploadTarget` bits. */
export interface SignedUpload {
  uploadUrl: string;
  headers: {
    AuthorizationSignature: string;
    AuthorizationExpire: string;
    VideoId: string;
    LibraryId: string;
  };
  expiresAt: string;
}

/** The Bunny Stream calls uploads need; a fake stands in for it in the integration tests. */
export interface BunnyStream {
  /** Creates an empty video titled `title` (the story id only, D69); answers its id. */
  createVideo(title: string): Promise<string>;
  /** The video, or null if Bunny has none with that id. */
  video(id: string): Promise<StreamVideo | null>;
  /** Deletes it; a video that's already gone is fine. */
  deleteVideo(id: string): Promise<void>;
  /** A TUS upload link for that video only, valid for UPLOAD_LINK_SECONDS. */
  sign(videoId: string, now?: number): SignedUpload;
  /**
   * Makes the picture at `pictureUrl` (a short-lived signed link, which Bunny fetches itself) the
   * video's thumbnail. Repeating it is harmless: Bunny keeps the latest.
   */
  setThumbnail(videoId: string, pictureUrl: string): Promise<void>;
  /**
   * Puts one of Bunny's own frames of the video back as its thumbnail, from `frameUrl` (that
   * frame, signed on the Stream CDN).
   */
  resetThumbnail(videoId: string, frameUrl: string): Promise<void>;
}

/**
 * The frame a removed picture gives way to. Setting a picture deletes Bunny's `thumbnail.jpg`, but
 * keeps the frames it generated from the video, `thumbnail_1.jpg` onwards (tested on dev,
 * 2026-10-31), so the first of those goes back.
 */
export const BUNNY_FRAME = 'thumbnail_1.jpg';

const LIBRARY = /^[0-9]{1,12}$/;
const SECRET = /^[A-Za-z0-9_-]{1,255}$/;
/** Bunny's video ids are GUIDs; anything else never reaches a URL. */
export const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BunnyStreamApi implements BunnyStream {
  constructor(
    private readonly libraryId: string,
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await this.fetcher(
      `${API}/library/${this.libraryId}/videos${path}`,
      {
        method,
        headers: {
          AccessKey: this.key,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        // The library key goes to Bunny's API only, never on to wherever a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    return res;
  }

  async createVideo(title: string): Promise<string> {
    const res = await this.call('POST', '', { title });
    if (!res.ok) throw new Error(`Bunny Stream create answered ${res.status}`);
    const { guid } = (await res.json()) as { guid?: unknown };
    if (typeof guid !== 'string' || !VIDEO_ID.test(guid)) {
      throw new Error('Bunny Stream create answered no video id');
    }
    return guid;
  }

  async video(id: string): Promise<StreamVideo | null> {
    if (!VIDEO_ID.test(id)) return null;
    const res = await this.call('GET', `/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Bunny Stream get answered ${res.status}`);
    const v = (await res.json()) as {
      status?: unknown;
      length?: unknown;
      hasOriginal?: unknown;
    };
    return {
      status: typeof v.status === 'number' ? v.status : -1,
      length: typeof v.length === 'number' ? v.length : 0,
      hasOriginal: v.hasOriginal === true,
    };
  }

  async setThumbnail(videoId: string, pictureUrl: string): Promise<void> {
    if (!VIDEO_ID.test(videoId)) throw new Error('Not a Bunny video id');
    const res = await this.call(
      'POST',
      `/${videoId}/thumbnail?thumbnailUrl=${encodeURIComponent(pictureUrl)}`,
    );
    if (!res.ok) {
      throw new Error(`Bunny Stream set thumbnail answered ${res.status}`);
    }
  }

  async resetThumbnail(videoId: string, frameUrl: string): Promise<void> {
    if (!VIDEO_ID.test(videoId)) throw new Error('Not a Bunny video id');
    // Bunny can't fetch its own frame by link: the library refuses Stream files to requests
    // without a referrer (direct_url_file_access_blocked, modules/bunny), and its fetcher sends
    // none. So the frame (a small JPEG of the person's own video) is passed through as a stream,
    // never held whole, with the player's origin as referrer, as the player itself fetches it.
    const frame = await this.fetcher(frameUrl, {
      headers: { Referer: 'https://player.mediadelivery.net/' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!frame.ok || !frame.body) {
      throw new Error(`Bunny's own frame answered ${frame.status}`);
    }
    const res = await this.fetcher(
      `${API}/library/${this.libraryId}/videos/${videoId}/thumbnail`,
      {
        method: 'POST',
        headers: {
          AccessKey: this.key,
          Accept: 'application/json',
          'Content-Type': frame.headers.get('content-type') ?? 'image/jpeg',
        },
        body: frame.body,
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      } as RequestInit,
    );
    if (!res.ok) {
      throw new Error(`Bunny Stream reset thumbnail answered ${res.status}`);
    }
  }

  async deleteVideo(id: string): Promise<void> {
    if (!VIDEO_ID.test(id)) return;
    const res = await this.call('DELETE', `/${id}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`Bunny Stream delete answered ${res.status}`);
    }
  }

  sign(videoId: string, now = Date.now()): SignedUpload {
    return signUpload(this.libraryId, this.key, videoId, now);
  }
}

export function signUpload(
  libraryId: string,
  key: string,
  videoId: string,
  now = Date.now(),
): SignedUpload {
  const expires = Math.floor(now / 1000) + UPLOAD_LINK_SECONDS;
  return {
    uploadUrl: TUS_ENDPOINT,
    headers: {
      AuthorizationSignature: tusSignature(libraryId, key, expires, videoId),
      AuthorizationExpire: String(expires),
      VideoId: videoId,
      LibraryId: libraryId,
    },
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

type Env = Record<string, string | undefined>;

/**
 * Uploads on when `BUNNY_STREAM_API_KEY_SECRET` names the key's secret, with the library in
 * `BUNNY_STREAM_LIBRARY_ID` (the same variable media signing uses). Off (null) without it.
 */
export async function createBunnyStream(
  secrets: Pick<SecretsService, 'get'>,
  env: Env = process.env,
): Promise<BunnyStream | null> {
  const logger = new Logger('BunnyStream');
  const secret = env['BUNNY_STREAM_API_KEY_SECRET']?.trim() ?? '';
  const libraryId = env['BUNNY_STREAM_LIBRARY_ID']?.trim() ?? '';
  if (secret === '') {
    logger.warn(
      'Uploads are off (no BUNNY_STREAM_API_KEY_SECRET): RequestUpload answers 503',
    );
    return null;
  }
  if (!SECRET.test(secret) || !LIBRARY.test(libraryId)) {
    throw new Error(
      'Uploads need BUNNY_STREAM_API_KEY_SECRET (a secret name) and a numeric BUNNY_STREAM_LIBRARY_ID',
    );
  }
  const key = (await secrets.get(secret)).trim();
  if (key === '') throw new Error(`Secret ${secret} is empty`);
  logger.log(`Uploads on: Stream library ${libraryId}`);
  return new BunnyStreamApi(libraryId, key);
}

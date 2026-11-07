/**
 * Bunny Stream, read only (media-worker-final.html section 2: the worker may read Bunny's library
 * with the read-only key, nothing more). The worker never trusts Bunny's notice: it asks Bunny
 * itself for the video's state just before it answers.
 */

const API = 'https://video.bunnycdn.com';
const TIMEOUT_MS = 15_000;

/** Bunny's video ids are GUIDs; anything else never reaches a URL. */
export const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One path segment at Bunny, as the writer accepts it (apps/workflow media-jobs.ts). */
const FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Bunny's video status (https://docs.bunny.net/reference/video_getvideo): 0 created, 1 uploaded,
 * 2 processing, 3 transcoding, 4 finished, 5 error, 6 upload failed, 7 JIT segmenting, 8 JIT
 * playlists created.
 */
const ENCODING = new Set([0, 1, 2, 3, 7, 8]);
const FINISHED = 4;
const FAILED = new Set([5, 6]);

/** The worker's answer to a check job (worker.yaml `MediaAnswer`). */
export type MediaAnswer =
  | {
      outcome: 'ready';
      title: string;
      width: number;
      height: number;
      lengthSeconds: number;
      thumbnailFileName: string;
    }
  | { outcome: 'encoding' | 'failed' | 'gone' };

/** Either an answer for the writer, or a short failure code (worker.yaml `MediaFailure`). */
export type CheckResult = { answer: MediaAnswer } | { failure: string };

/** Bunny couldn't tell us, with the short code the writer records (mediaJob.lastError). */
export class BunnyFailure extends Error {
  override name = 'BunnyFailure';
  constructor(readonly code: string) {
    super(code);
  }
}

export interface BunnyVideo {
  status?: unknown;
  title?: unknown;
  width?: unknown;
  height?: unknown;
  length?: unknown;
  thumbnailFileName?: unknown;
}

export interface BunnyLibrary {
  /** The video as Bunny describes it, or null if Bunny has no such video (404). */
  video(id: string): Promise<BunnyVideo | null>;
}

export class BunnyStreamReader implements BunnyLibrary {
  constructor(
    private readonly libraryId: string,
    /** The library's read-only key (Secret Manager), read again once a few minutes old. */
    private readonly key: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async video(id: string): Promise<BunnyVideo | null> {
    let key: string;
    try {
      key = (await this.key()).trim();
    } catch {
      throw new BunnyFailure('key_unavailable');
    }
    if (!key) throw new BunnyFailure('key_unavailable');
    let res: Response;
    try {
      res = await this.fetcher(
        `${API}/library/${this.libraryId}/videos/${id}`,
        {
          headers: { AccessKey: key, Accept: 'application/json' },
          // The key goes to Bunny's API only, never on to wherever a redirect points.
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      throw new BunnyFailure('bunny_unreachable');
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new BunnyFailure('bunny_refused');
    }
    if (res.status === 429 || res.status >= 500) {
      throw new BunnyFailure('bunny_unreachable');
    }
    if (!res.ok) throw new BunnyFailure('bunny_error');
    try {
      const body = (await res.json()) as unknown;
      if (!body || typeof body !== 'object') throw new Error('not an object');
      return body as BunnyVideo;
    } catch {
      throw new BunnyFailure('bunny_bad_reply');
    }
  }
}

const positiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Bunny's description of a video, as the answer the writer expects. */
export function toAnswer(video: BunnyVideo | null): CheckResult {
  if (video === null) return { answer: { outcome: 'gone' } };
  const { status } = video;
  if (typeof status === 'number' && ENCODING.has(status)) {
    return { answer: { outcome: 'encoding' } };
  }
  if (typeof status === 'number' && FAILED.has(status)) {
    return { answer: { outcome: 'failed' } };
  }
  if (status !== FINISHED) return { failure: 'bunny_unknown_status' };
  const { title, width, height, length, thumbnailFileName } = video;
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    !positiveInt(width) ||
    !positiveInt(height) ||
    !positiveInt(length) ||
    typeof thumbnailFileName !== 'string' ||
    !FILE_NAME.test(thumbnailFileName) ||
    thumbnailFileName === '.' ||
    thumbnailFileName === '..'
  ) {
    // Finished, but without the facts a ready answer needs: try again later (it counts as a
    // failure, so it gives up after 5).
    return { failure: 'bunny_facts_missing' };
  }
  return {
    answer: {
      outcome: 'ready',
      title,
      width,
      height,
      lengthSeconds: length,
      thumbnailFileName,
    },
  };
}

/** Asks Bunny about the video now, and turns what it says into the writer's answer. */
export async function checkAnswer(
  bunny: BunnyLibrary,
  videoId: string,
): Promise<CheckResult> {
  try {
    return toAnswer(await bunny.video(videoId));
  } catch (err) {
    if (err instanceof BunnyFailure) return { failure: err.code };
    throw err;
  }
}

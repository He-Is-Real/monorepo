import { retryOnConflict, runQuery } from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
import { BunnyCallFailed, callWithin, type WriterBunny } from './bunny';
import type { QueuedJob } from './media-queue';

/**
 * The media worker's answer to one check job (media-worker-final.html, sections 1 and 3;
 * libs/contracts/openapi/worker.yaml, `MediaAnswer`). The worker never trusts Bunny's notice: it
 * asks Bunny itself, with the read-only key, just before it calls the writer, and answers with
 * what it found.
 * - `ready`: encoded, with its real facts; `title` is the video's title at Bunny, which is the
 *   story's id (D69), a second check that the video is that story's.
 * - `failed`: Bunny couldn't encode it.
 * - `encoding`: Bunny is still working on it (a re-encode, or a notice that came early).
 * - `gone`: Bunny has no such video (deleted).
 */
export type MediaAnswer =
  | {
      outcome: 'ready';
      title: string;
      width: number;
      height: number;
      lengthSeconds: number;
      thumbnailFileName: string;
    }
  | { outcome: 'failed' }
  | { outcome: 'encoding' | 'gone' };

/**
 * How the job ended (mediaJob.outcome): the answer was saved (`applied`), a newer answer was
 * already in (`stale`), or its file is no longer one a story shows (`gone`).
 */
export type AnswerOutcome = 'applied' | 'stale' | 'gone';

/** What the writer tells the worker after a failure: try again later, or stop (the job gave up). */
export interface FailureReply {
  retry: boolean;
  /** The job's outcome once it has ended (gave_up, or how an earlier answer ended it). */
  outcome?: AnswerOutcome | 'gave_up';
}

export class InvalidMediaJobCall extends Error {
  override name = 'InvalidMediaJobCall';
}
/**
 * The call names another video than the job's (Joel, 2026-11-08, B): nothing is written, and the
 * worker counts it as a failure, so a mixed-up job gives up after 5 instead of looping.
 */
export class MediaJobWrongVideo extends Error {
  override name = 'MediaJobWrongVideo';
}
/** No such job: never made, or gone with its file (erasure, tidy-up). The worker drops it. */
export class MediaJobNotFound extends Error {
  override name = 'MediaJobNotFound';
}

/** After this many failures a job gives up (J4: the table replaces dead letters). */
export const MAX_FAILURES = 5;

/**
 * Why a job gave up (mediaJob.errorType; Part 1a, P1a-4 A: a fixed list). `file_unusable` is the
 * writer's own finding ({@link answerFailed}), never a worker's code.
 */
export type ErrorType =
  'file_unusable' | 'bunny_unavailable' | 'worker_error' | 'other';

/** The worker's (and the writer's own) codes for its own faults: a bug, a missing tool, a crash. */
const WORKER_CODES = new Set([
  'worker_error',
  'key_unavailable',
  'answer_rejected',
  'pass_rejected',
  'pass_malformed',
  'sound_rejected',
  'sound_malformed',
  'render_failed',
  'ffmpeg_missing',
  'too_large',
  'webp_pipe',
  'jpeg_pipe',
  'picture_unreachable',
  'picture_not_webp',
  'picture_too_big',
  'picture_unsafe',
  'source_gone',
  'source_not_ready',
  'source_unreachable',
  'source_missing',
  'upload_refused',
  'upload_unreachable',
]);

/**
 * The errorType of a job that gave up on the failure `code`: Bunny's (`bunny_*`: it didn't
 * answer, refused or had an outage), the worker's own, or anything else. Never file_unusable:
 * the worker can't blame the file (Part 1a).
 */
export function errorTypeOf(code: string): Exclude<ErrorType, 'file_unusable'> {
  if (code.startsWith('bunny_')) return 'bunny_unavailable';
  if (WORKER_CODES.has(code)) return 'worker_error';
  return 'other';
}

/**
 * The marker a check job leaves (its lastError) when the writer has asked Bunny to encode its
 * file again after Bunny's first "failed to process" (Part 1a: one automatic re-encode). Done
 * jobs keep it until the 30-day tidy-up.
 */
export const REENCODED = 'bunny_encode_failed';

/** mediaJob:<ulid> (fn::media::queue_job). */
export const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A Bunny video id (a GUID): the job's file is storyFile:<video id>. */
const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A failure's short code (mediaJob.lastError), e.g. bunny_unreachable. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** One path segment at Bunny (fn::media::safe_segment), e.g. `thumbnail_1a2b3c4d.jpg`. */
const FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const OUTCOMES = ['ready', 'failed', 'encoding', 'gone'] as const;

const positiveInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;

export function parseJobId(input: unknown): string {
  if (typeof input !== 'string' || !JOB_ID.test(input)) {
    throw new InvalidMediaJobCall('not a media job id');
  }
  return input;
}

/**
 * The Bunny video id every answer and failure carries (`videoId`; Joel, 2026-11-08, B): the
 * writer refuses a call whose video isn't the job's. Throws {@link InvalidMediaJobCall} if
 * malformed.
 */
export function parseVideoId(input: unknown): string {
  const video =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)['videoId']
      : undefined;
  if (typeof video !== 'string' || !VIDEO_ID.test(video)) {
    throw new InvalidMediaJobCall('a call needs the job’s video id');
  }
  return video;
}

/** The answer, checked field by field; throws {@link InvalidMediaJobCall} otherwise. */
export function parseMediaAnswer(input: unknown): MediaAnswer {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidMediaJobCall('not an object');
  }
  const m = input as Record<string, unknown>;
  const outcome = m['outcome'];
  if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    throw new InvalidMediaJobCall('unknown outcome');
  }
  if (outcome !== 'ready') {
    return outcome === 'failed'
      ? { outcome }
      : { outcome: outcome as 'encoding' | 'gone' };
  }
  const { title, width, height, lengthSeconds, thumbnailFileName } = m;
  if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
    throw new InvalidMediaJobCall('a ready answer needs the video’s title');
  }
  if (!positiveInt(width, 16_384) || !positiveInt(height, 16_384)) {
    throw new InvalidMediaJobCall('a ready answer needs a width and height');
  }
  if (!positiveInt(lengthSeconds, 7 * 24 * 3600)) {
    throw new InvalidMediaJobCall('a ready answer needs a length over 0');
  }
  if (
    typeof thumbnailFileName !== 'string' ||
    !FILE_NAME.test(thumbnailFileName) ||
    thumbnailFileName === '.' ||
    thumbnailFileName === '..'
  ) {
    throw new InvalidMediaJobCall(
      'a ready answer needs its thumbnail’s file name',
    );
  }
  return {
    outcome: 'ready',
    title,
    width,
    height,
    lengthSeconds,
    thumbnailFileName,
  };
}

/** The failure's short code; throws {@link InvalidMediaJobCall} otherwise. */
export function parseFailure(input: unknown): string {
  const code =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)['code']
      : undefined;
  if (typeof code !== 'string' || !ERROR_CODE.test(code)) {
    throw new InvalidMediaJobCall('a failure needs a short code');
  }
  return code;
}

/**
 * The answer's whole write, as one transaction's body (no BEGIN/COMMIT, so a test can hold it
 * open): read the job and its file, decide, write the file's facts and end the job, together
 * (Joel, 2026-11-07: F1, J5 and the round 3 fix; nothing is computed from an earlier read).
 * - gone: the file isn't one its story shows now (replaced, removed, the story deleted), it isn't
 *   a video or audio file, or a `ready` answer's title isn't the story's id (D69);
 * - stale: an answer that reached the writer at or after this one's `$at` is already in
 *   (storyFile.checkedAt);
 * - applied: every fact written, with checkedAt = `$at`, even when they were already so, so an
 *   older answer arriving later still loses. The file's events then hide or show the story
 *   again (fn::story::check_files) and step its version only if something it shows changed.
 * What a ready answer writes (the render decision, audio-picture-video.html decision 1B):
 * - a video: its facts;
 * - a person's own audio upload (no renderOf): its length only, still `processing`: it is ready
 *   only once its picture video is (approval needs that), so a render job of it opens;
 * - a picture video (renderOf): its facts as a video's; if the story's picture is no longer the
 *   one it was made with (thumbnailOf), a render job of it opens (reason picture_changed).
 * A video its story shows, ready, with Bunny on (`$bunny`), then gets the story's picture at Bunny
 * (video-bundle-rethink part A; Joel, 2026-11-08, T3), whatever this answer's outcome: the job
 * stays OPEN, so approval waits (fn::story::approval_wait), and the writer closes it once Bunny
 * shows the picture ({@link applyThumbnail}). If the job had already ended (the queue delivered it
 * again), a check job of the file is opened first (fn::media::queue_job, with this job's reasons;
 * Codex r4 finding 2), so a failure at Bunny leaves an open job for the redelivery, the 18:00
 * resend or the nightly sweep to finish. Any other answer ends the job if it is still open; a job
 * already ended keeps its outcome.
 * Part 1a (Joel, 2026-11-10; P1a-4 A): what a not-ready answer writes (`$failure`, set by
 * {@link answerVars}):
 * - `reencoding`: Bunny's first "failed to process", which the writer confirmed and answered by
 *   asking Bunny to encode the file again ({@link answerFailed}): the file is `processing` (a
 *   published story leaves the site until it is ready, then comes back by itself), and the job
 *   ends applied, marked {@link REENCODED};
 * - `unusable`: Bunny's final failure, after that one re-encode: the file is `failed` and the job
 *   gives up with errorType file_unusable, together. The database then sends a story waiting
 *   for review, published or off the site back to its owner (fn::story::check_files);
 * - `gone`: Bunny has no such video (never the person's fault): the file is `processing` and the
 *   job gives up with errorType other, for the housekeeping to try again and the moderators to see.
 * A failure is recorded only on a job still open (else `stale`).
 * Answers the outcome, the render job opened, if any (the writer sends it after the commit), and
 * the job the picture step closes, if any.
 */
export const ANSWER_SQL = `
  LET $j = (SELECT kind, file, doneAt, reasons FROM ONLY type::record('mediaJob', $job));
  IF $j = NONE { THROW 'media_job_not_found' };
  IF <string> record::id($j.file) != $videoId { THROW 'media_job_wrong_video' };
  IF $j.kind != 'check' { THROW 'media_job_not_a_check' };
  LET $f = (SELECT id, format, story, checkedAt, detachedAt, removedAt, renderOf, thumbnailOf
    FROM ONLY $j.file);
  LET $shown = $f != NONE AND $f.format IN ['video', 'audio'] AND $f.detachedAt = NONE
    AND $f.removedAt = NONE AND record::exists($f.story) AND $f.story.mediaFile = $f.id
    AND ($title = NONE OR $title = <string> record::id($f.story));
  LET $outcome = IF !$shown { 'gone' }
    ELSE IF $f.checkedAt != NONE AND $f.checkedAt >= <datetime> $at { 'stale' }
    -- Part 1a: a failure is recorded only on a job still open (a redelivery of an ended job
    -- leaves it to the job Bunny's own notice opens), so its end says why.
    ELSE IF $failure != NONE AND $j.doneAt != NONE { 'stale' }
    ELSE { 'applied' };
  LET $source = $f.format = 'audio' AND $f.renderOf = NONE;
  -- Read from the story itself: f.story.image.file (a link through an empty image) fails on
  -- 3.2.4 with "Specify a database to use".
  LET $picture = IF $shown { (SELECT VALUE image.file FROM ONLY $f.story) };
  LET $render = IF $outcome = 'applied' AND $ready AND $f.format = 'audio'
    AND ($source OR $f.thumbnailOf != $picture) {
    LET $reasons = IF $source { $j.reasons } ELSE { ['picture_changed'] };
    LET $queued = $reasons.map(|$r| fn::media::queue_job($f.id, 'render', $r));
    $queued[array::len($queued) - 1]
  };
  IF $outcome = 'applied' {
    LET $facts = IF !$ready { $notReady }
      ELSE IF $source { { processing: 'processing', lengthSeconds: $video.lengthSeconds } }
      ELSE { object::extend($video, { thumbnailPath: <string> record::id($f.id) + '/' + $thumb }) };
    UPDATE $f.id MERGE object::extend($facts, { checkedAt: <datetime> $at }) RETURN NONE;
  };
  -- Part A, T3: the story's picture goes to Bunny with the job open.
  LET $thumbnail = $bunny AND $shown AND $f.format = 'video'
    AND (SELECT VALUE processing FROM ONLY $f.id) = 'ready';
  LET $hold = IF !$thumbnail { NONE } ELSE IF $j.doneAt = NONE { $job } ELSE {
    LET $queued = $j.reasons.map(|$r| fn::media::queue_job($f.id, 'check', $r));
    $queued[array::len($queued) - 1].job
  };
  LET $end = IF $outcome = 'applied' AND $failure IN ['unusable', 'gone'] { 'gave_up' }
    ELSE { $outcome };
  IF $j.doneAt = NONE AND !$thumbnail {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = $end,
      errorType = IF $end != 'gave_up' { NONE } ELSE IF $failure = 'unusable' { 'file_unusable' }
        ELSE { 'other' },
      lastError = IF $outcome != 'applied' OR $failure = NONE { lastError }
        ELSE IF $failure = 'gone' { 'bunny_video_gone' } ELSE { $reencoded } RETURN NONE;
  };
  { outcome: $end, render: $render, thumbnail: $hold };`;

/** What a not-ready answer records (ANSWER_SQL's `$failure`). */
type Failure = 'reencoding' | 'unusable' | 'gone';

/**
 * An answer as the writer applies it: the worker's, with a `failed` one confirmed by the writer
 * and marked `final` once Bunny has already encoded the file again once ({@link answerFailed}).
 */
export type WriterAnswer =
  | Extract<MediaAnswer, { outcome: 'ready' }>
  | { outcome: 'encoding' | 'gone' }
  | { outcome: 'failed'; final: boolean };

/**
 * The query's variables: whether the answer is ready, the facts for a file that isn't
 * (`notReady`) and for a ready one (`video`; an audio upload keeps only its length), its
 * thumbnail's file name, which the write puts under the video's own folder at Bunny (its file's
 * id, R12), and whether the writer sets a ready video's picture at Bunny (`bunny`).
 */
export function answerVars(
  job: string,
  video: string,
  answer: WriterAnswer,
  arrivedAt: string,
  bunny = false,
): Record<string, unknown> {
  const vars = {
    job,
    videoId: video,
    at: arrivedAt,
    bunny,
    reencoded: REENCODED,
    failure: undefined as Failure | undefined,
  };
  if (answer.outcome !== 'ready') {
    // Part 1a: only Bunny's final failure, confirmed by the writer, makes the file failed. A
    // first failure (re-encoding) or a video Bunny no longer has leaves it processing.
    const failure: Failure | undefined =
      answer.outcome === 'gone'
        ? 'gone'
        : answer.outcome === 'failed'
          ? answer.final
            ? 'unusable'
            : 'reencoding'
          : undefined;
    const processing = failure === 'unusable' ? 'failed' : 'processing';
    return { ...vars, failure, ready: false, notReady: { processing } };
  }
  return {
    ...vars,
    ready: true,
    title: answer.title,
    thumb: answer.thumbnailFileName,
    video: {
      processing: 'ready',
      width: answer.width,
      height: answer.height,
      lengthSeconds: answer.lengthSeconds,
    },
  };
}

/** What an answer did: its outcome, and the render job it opened (to send after the commit). */
export interface AnswerResult {
  outcome: AnswerOutcome | 'gave_up';
  render: QueuedJob | null;
  /**
   * Set for a ready video with Bunny on: the open check job (this one, or one just opened) that
   * {@link applyThumbnail} closes once Bunny shows the story's picture.
   */
  thumbnail: { job: string } | null;
}

/**
 * Applies the worker's answer about `video` to the job's file (refused with
 * {@link MediaJobWrongVideo} if that isn't the job's video), signed in as service:workflow (the
 * only login that may set a file's processing, A2), and ends the job, in one transaction; for a
 * ready video with `bunny`, it leaves a check job open instead ({@link applyThumbnail} finishes).
 * `arrivedAt` is when the worker's call reached the writer (F1): an answer applies only if no
 * answer that arrived at or after it is in. A transaction conflict (another answer, a moderator's
 * step or an erasure on the same person) re-runs it from scratch.
 */
export async function answerJob(
  db: SurrealQueryable,
  job: string,
  video: string,
  answer: WriterAnswer,
  arrivedAt: string,
  bunny = false,
): Promise<AnswerResult> {
  const vars = answerVars(job, video, answer, arrivedAt, bunny);
  return retryOnConflict(async () => {
    const results = await runQuery(
      db,
      `BEGIN TRANSACTION;${ANSWER_SQL}\nCOMMIT TRANSACTION;`,
      vars,
    ).catch(notFound);
    const r = results[results.length - 2] as {
      outcome: AnswerOutcome | 'gave_up';
      render?: Omit<QueuedJob, 'kind'> | null;
      thumbnail?: string | null;
    };
    return {
      outcome: r.outcome,
      render: r.render ? { ...r.render, kind: 'render' } : null,
      thumbnail: r.thumbnail ? { job: r.thumbnail } : null,
    };
  });
}

/** Whether a check of the video has already ended with Bunny's first failure ({@link REENCODED}). */
const REENCODED_SQL = `SELECT VALUE id FROM mediaJob
  WHERE file = type::record('storyFile', $videoId) AND kind = 'check'
    AND doneAt != NONE AND lastError = $reencoded LIMIT 1`;

/**
 * What the writer does with a worker's "failed" answer (Part 1a; Joel, 2026-11-10): it doesn't
 * take the worker's word for it (a home PC can never make a file unusable). It asks Bunny itself;
 * unless Bunny says failed too, the answer is set aside (`retry`: the worker leaves the job in the
 * queue, and the next delivery asks again), counting nothing. A confirmed failure:
 * - the first for this file: the writer asks Bunny to encode it again (the one automatic
 *   re-encode), then records it ({@link ANSWER_SQL}, `reencoding`). Bunny's notice when that
 *   ends opens the next check;
 * - after that re-encode: the file can't be used (`unusable`): failed, the job given up with
 *   errorType file_unusable, and the story sent back by the database.
 * A Bunny call that fails is the job's failure, as on the render routes ({@link failJob}).
 */
export async function answerFailed(
  db: SurrealQueryable,
  bunny: Pick<WriterBunny, 'videoStatus' | 'reencode'>,
  job: string,
  video: string,
  arrivedAt: string,
): Promise<AnswerResult | FailureReply> {
  try {
    if ((await bunny.videoStatus(video)) !== 'failed') return { retry: true };
    const [found] = (await runQuery(db, REENCODED_SQL, {
      videoId: video,
      reencoded: REENCODED,
    })) as [unknown[]];
    const final = (found ?? []).length > 0;
    if (!final) await bunny.reencode(video);
    return await answerJob(
      db,
      job,
      video,
      { outcome: 'failed', final },
      arrivedAt,
    );
  } catch (err) {
    if (!(err instanceof BunnyCallFailed)) throw err;
    return failJob(db, job, video, err.code);
  }
}

/**
 * T3's two timings (Joel, 2026-11-08, org-setup-and-picture-video.html): how long a writer holds
 * a video's lock (`lockMs`, default 2 minutes), and how long all its calls to Bunny under it may
 * take together (`callMs`, default 20 seconds: each call is cut off when that runs out). The rest
 * of the lock (at least 100 seconds) is the margin for a call Bunny might still apply after we
 * gave up on it. The database's clock judges the lock (Codex r5): the writer never sends a time
 * of its own. `now` is a monotonic clock in milliseconds, used only for the calls' budget (tests
 * may replace it).
 */
export interface ThumbnailLock {
  lockMs: number;
  callMs: number;
  now: () => number;
}
export const THUMBNAIL_LOCK = Symbol('THUMBNAIL_LOCK');

/** The least margin between the calls' end and the lock's (T4; Joel, 2026-11-09). */
export const LOCK_MARGIN_MS = 100_000;

/**
 * The lock's timings from THUMBNAIL_LOCK_SECONDS and THUMBNAIL_CALL_SECONDS (whole seconds), or
 * the defaults (120 and 20). Fails start-up unless the lock outlasts the calls by at least
 * {@link LOCK_MARGIN_MS}, so settings can't shrink the safety margin.
 */
export function thumbnailLockFromEnv(
  env: Record<string, string | undefined> = process.env,
): ThumbnailLock {
  const seconds = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new Error(`Malformed ${name}`);
    return Number(raw);
  };
  const lockMs = seconds('THUMBNAIL_LOCK_SECONDS', 120) * 1000;
  const callMs = seconds('THUMBNAIL_CALL_SECONDS', 20) * 1000;
  if (lockMs - callMs < LOCK_MARGIN_MS) {
    throw new Error(
      'THUMBNAIL_LOCK_SECONDS must be at least 100 more than THUMBNAIL_CALL_SECONDS',
    );
  }
  return { lockMs, callMs, now: () => performance.now() };
}

/**
 * T3 step a and b, in one transaction: take the video's lock only if it is empty or already past
 * the database's clock (T4: a past one is an unfinished write, which any writer may take over),
 * setting it to the database's now + `$lockFor`, and read the story's picture while holding it.
 * The value the database set, read back as text (to the nanosecond), is this holder's mark. A
 * file its story no longer shows needs no picture: the open job ends as gone.
 */
const LOCK_SQL = `BEGIN TRANSACTION;
  LET $now = time::now();
  LET $f = (SELECT id, format, story, detachedAt, removedAt, thumbnailLockedUntil
    FROM ONLY type::record('storyFile', $videoId));
  LET $shown = $f != NONE AND $f.format = 'video' AND $f.detachedAt = NONE
    AND $f.removedAt = NONE AND record::exists($f.story) AND $f.story.mediaFile = $f.id;
  LET $held = $shown AND $f.thumbnailLockedUntil != NONE AND $f.thumbnailLockedUntil > $now;
  LET $until = IF $shown AND !$held {
    (UPDATE ONLY $f.id SET thumbnailLockedUntil = $now + <duration> $lockFor
      RETURN VALUE thumbnailLockedUntil)
  };
  IF !$shown {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = 'gone'
      WHERE doneAt = NONE RETURN NONE;
  };
  LET $picture = IF $shown AND !$held { (SELECT VALUE image.file FROM ONLY $f.story) };
  IF !$shown { { state: 'gone' } } ELSE IF $held { { state: 'held' } }
    ELSE { { state: 'locked', until: <string> $until,
      picture: IF $picture != NONE { <string> record::id($picture) } } };
  COMMIT TRANSACTION;`;

/**
 * T3 step d, in one transaction, after Bunny took `$mine` (NONE for its own frame; `$thumb`,
 * Bunny's thumbnail file afterwards): only if the lock is still this writer's (still exactly
 * `$until`, and the database's clock before it). Then, if the story's picture is still `$mine`:
 * record it as thumbnailOf, empty the lock (T4: the only write that empties it for a video its
 * story shows) and close the job as applied; if it changed meanwhile, answer the new one (the
 * lock kept) for the writer to send. A file its story no longer shows: empty the lock, the job
 * ends as gone. A lock lost (run out, or taken by another writer since) records nothing.
 */
const SETTLE_SQL = `BEGIN TRANSACTION;
  LET $f = (SELECT id, format, story, detachedAt, removedAt, processing, thumbnailLockedUntil
    FROM ONLY type::record('storyFile', $videoId));
  LET $ours = $f != NONE AND $f.thumbnailLockedUntil = <datetime> $until
    AND time::now() < <datetime> $until;
  LET $shown = $ours AND $f.format = 'video' AND $f.detachedAt = NONE
    AND $f.removedAt = NONE AND record::exists($f.story) AND $f.story.mediaFile = $f.id;
  LET $picture = IF $shown { (SELECT VALUE image.file FROM ONLY $f.story) };
  LET $mineRec = IF $mine = NONE { NONE } ELSE { type::record('storyFile', $mine) };
  LET $kept = $shown AND $picture = $mineRec;
  IF $kept {
    UPDATE $f.id SET thumbnailOf = $mineRec, thumbnailLockedUntil = NONE,
      thumbnailPath = IF processing = 'ready' { <string> record::id(id) + '/' + $thumb }
        ELSE { thumbnailPath } RETURN NONE;
  };
  IF $ours AND !$shown {
    UPDATE $f.id SET thumbnailLockedUntil = NONE RETURN NONE;
  };
  IF $kept OR ($ours AND !$shown) {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(),
      outcome = IF $shown { 'applied' } ELSE { 'gone' } WHERE doneAt = NONE RETURN NONE;
  };
  IF !$ours { { state: 'lost' } } ELSE IF $kept OR !$shown { { state: 'closed' } }
    ELSE { { state: 'changed', picture: IF $picture != NONE { <string> record::id($picture) } } };
  COMMIT TRANSACTION;`;

/**
 * How {@link applyThumbnail} ended: `closed` (Bunny shows the story's picture, recorded, and the
 * job closed), or `retry` (the job stays open, approval keeps waiting, and the worker leaves it in
 * the queue: another writer holds the lock, or this one's ran out before it could record).
 */
export type ThumbnailOutcome = 'closed' | 'retry';

/**
 * Sets a ready video's picture at Bunny under its lock (T3; Joel, 2026-11-08), then closes the
 * job `job` that {@link answerJob} left open:
 * a. takes the lock for `lock.lockMs` by the database's clock, or answers `retry` if another
 *    writer holds it;
 * b. reads the story's picture (in the same transaction);
 * c. sets it at Bunny, every call cut off once `lock.callMs` has passed on the writer's monotonic
 *    clock, counted from before the lock was taken (so the calls end before the lock's margin);
 * d. records it and empties the lock, only if the picture is still that one and the lock still
 *    this writer's; if the picture changed, sends the new one first, still under the lock.
 * e. A Bunny error from `setThumbnail` (or the cut-off) is thrown as it comes, with the job open
 *    and the lock left to run out: a call that failed or was cut off might still be applied at
 *    Bunny. Once past, the lock means "unfinished: Bunny may be wrong" (T4; Joel, 2026-11-09):
 *    approval keeps waiting until a later writer takes it over and finishes. It never counts as
 *    the worker's failure; a redelivery, the 18:00 resend or the nightly re-check finishes it.
 */
export async function applyThumbnail(
  db: SurrealQueryable,
  setThumbnail: (
    video: string,
    picture: string | null,
    signal: AbortSignal,
  ) => Promise<string>,
  job: string,
  video: string,
  lock: ThumbnailLock,
): Promise<ThumbnailOutcome> {
  const callsEnd = lock.now() + lock.callMs;
  const taken = await retryOnConflict(async () => {
    const results = await runQuery(db, LOCK_SQL, {
      job,
      videoId: video,
      lockFor: `${lock.lockMs}ms`,
    });
    return results[results.length - 2] as {
      state: 'gone' | 'held' | 'locked';
      until?: string;
      picture?: string | null;
    };
  });
  if (taken.state === 'gone') return 'closed';
  if (taken.state === 'held') return 'retry';
  const until = taken.until as string;
  let picture = taken.picture ?? null;
  for (;;) {
    const thumb = await callWithin(callsEnd - lock.now(), (signal) =>
      setThumbnail(video, picture, signal),
    );
    const r = await retryOnConflict(async () => {
      const results = await runQuery(db, SETTLE_SQL, {
        job,
        videoId: video,
        until,
        mine: picture ?? undefined,
        thumb,
      });
      return results[results.length - 2] as {
        state: 'lost' | 'closed' | 'changed';
        picture?: string | null;
      };
    });
    if (r.state === 'lost') return 'retry';
    if (r.state === 'closed') return 'closed';
    picture = r.picture ?? null;
  }
}

const FAILURE_SQL = `BEGIN TRANSACTION;
  LET $j = (SELECT file, failures, doneAt, outcome FROM ONLY type::record('mediaJob', $job));
  IF $j = NONE { THROW 'media_job_not_found' };
  IF <string> record::id($j.file) != $videoId { THROW 'media_job_wrong_video' };
  LET $n = $j.failures + 1;
  LET $end = $n >= $max;
  IF $j.doneAt = NONE {
    UPDATE type::record('mediaJob', $job) SET failures = $n, lastError = $code,
      doneAt = IF $end { time::now() } ELSE { NONE },
      outcome = IF $end { 'gave_up' } ELSE { NONE },
      errorType = IF $end { $errorType } ELSE { NONE } RETURN NONE;
  };
  IF $j.doneAt != NONE { { retry: false, outcome: $j.outcome } }
    ELSE IF $end { { retry: false, outcome: 'gave_up' } }
    ELSE { { retry: true } };
  COMMIT TRANSACTION;`;

/**
 * Counts the worker's failure on the job, with its short code (J4). Under {@link MAX_FAILURES}:
 * try again later (the worker doesn't mark it taken, and the queue redelivers it). At the fifth:
 * the job ends as gave_up, with why ({@link errorTypeOf}: always ours, never the file's; Part 1a),
 * and the worker marks it taken so the story's later jobs carry on. A
 * job that has already ended counts nothing more and is dropped. Refused with
 * {@link MediaJobWrongVideo} if `video` isn't the job's.
 */
export async function failJob(
  db: SurrealQueryable,
  job: string,
  video: string,
  code: string,
): Promise<FailureReply> {
  return retryOnConflict(async () => {
    const results = await runQuery(db, FAILURE_SQL, {
      job,
      videoId: video,
      code,
      errorType: errorTypeOf(code),
      max: MAX_FAILURES,
    }).catch(notFound);
    const reply = results[results.length - 2] as FailureReply;
    return reply.outcome === undefined ? { retry: reply.retry } : reply;
  });
}

function notFound(err: unknown): never {
  if (err instanceof Error && err.message.includes('media_job_not_found')) {
    throw new MediaJobNotFound();
  }
  if (err instanceof Error && err.message.includes('media_job_wrong_video')) {
    throw new MediaJobWrongVideo();
  }
  if (err instanceof Error && err.message.includes('media_job_not_a_check')) {
    throw new InvalidMediaJobCall('not a check job');
  }
  throw err;
}

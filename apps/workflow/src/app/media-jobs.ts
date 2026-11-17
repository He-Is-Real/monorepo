import { retryOnConflict, runQuery } from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
import { BunnyCallFailed, type WriterBunny } from './bunny';
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

/**
 * The failure the writer counts on a check that saw Bunny's failure after the re-encode was asked
 * for, but before Bunny's own notice that the re-encode failed ({@link answerFailed}).
 */
export const REENCODE_PENDING = 'bunny_reencode_pending';

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
  // The writer's own marker of a re-encode ({@link REENCODED}) is never a worker's code.
  if (code === REENCODED) {
    throw new InvalidMediaJobCall('that code is the writer’s own');
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
 * A video's picture is never touched here: api-user sets it at Bunny when the story is sent
 * (Joel, 2026-11-17, P1-13 A). Every answer ends the job if it is still open; a job already ended
 * keeps its outcome. A render doesn't open for a waiting or system-hidden story whose file has
 * used its nightly retries (Part 1a, P1-9; Codex r6): the database's mediaJob_rules refuses every
 * new job then, so `render` comes back empty and "a problem on our side" stays.
 * Part 1a (Joel, 2026-11-10; P1a-4 A): what a not-ready answer writes (`$failure`, set by
 * {@link answerVars}):
 * - `reencoding`: Bunny's first "failed to process", which the writer confirmed and is about to
 *   answer by asking Bunny to encode the file again ({@link answerFailed}): the file is
 *   `processing` (a published story leaves the site until it is ready, then comes back by
 *   itself), the job ends applied, marked {@link REENCODED}, and a follow-up check job opens
 *   (`followUp`; reason resent) for the re-encode's result;
 * - `unusable`: Bunny's final failure, after that one re-encode: the file is `failed` and the job
 *   gives up with errorType file_unusable, together. The database then sends a story waiting
 *   for review, published or off the site back to its owner (fn::story::check_files);
 * - `gone`: Bunny has no such video (never the person's fault): the file is `processing` and the
 *   job gives up with errorType other, for the housekeeping to try again and the moderators to see.
 * A failure is recorded only on a job still open (else `stale`).
 * Answers the outcome, and the render job opened, if any (the writer sends it after the commit).
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
  LET $end = IF $outcome = 'applied' AND $failure IN ['unusable', 'gone'] { 'gave_up' }
    ELSE { $outcome };
  IF $j.doneAt = NONE {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = $end,
      errorType = IF $end != 'gave_up' { NONE } ELSE IF $failure = 'unusable' { 'file_unusable' }
        ELSE { 'other' },
      lastError = IF $outcome != 'applied' OR $failure = NONE { lastError }
        ELSE IF $failure = 'gone' { 'bunny_video_gone' } ELSE { $reencoded } RETURN NONE;
  };
  -- Part 1a (Codex review r1, findings 1 and 2): the re-encode's follow-up check, opened with the
  -- marker and before Bunny is asked, so Bunny's notice when the re-encode ends always finds (or
  -- opens) a job after the marker. Bunny is asked for the re-encode only once per file.
  LET $followUp = IF $outcome = 'applied' AND $failure = 'reencoding' {
    fn::media::queue_job($f.id, 'check', 'resent').job
  };
  { outcome: $end, render: $render, followUp: $followUp };`;

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
 * id, R12).
 */
export function answerVars(
  job: string,
  video: string,
  answer: WriterAnswer,
  arrivedAt: string,
): Record<string, unknown> {
  const vars = {
    job,
    videoId: video,
    at: arrivedAt,
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
   * Set when the answer recorded Bunny's first failure (`reencoding`): the check job opened for
   * the re-encode's result, before Bunny is asked for it ({@link answerFailed}).
   */
  followUp?: string;
}

/**
 * Applies the worker's answer about `video` to the job's file (refused with
 * {@link MediaJobWrongVideo} if that isn't the job's video), signed in as service:workflow (the
 * only login that may set a file's processing, A2), and ends the job, in one transaction.
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
): Promise<AnswerResult> {
  const vars = answerVars(job, video, answer, arrivedAt);
  return retryOnConflict(async () => {
    const results = await runQuery(
      db,
      `BEGIN TRANSACTION;${ANSWER_SQL}\nCOMMIT TRANSACTION;`,
      vars,
    ).catch(notFound);
    const r = results[results.length - 2] as {
      outcome: AnswerOutcome | 'gave_up';
      render?: Omit<QueuedJob, 'kind'> | null;
      followUp?: string | null;
    };
    return {
      outcome: r.outcome,
      render: r.render ? { ...r.render, kind: 'render' } : null,
      ...(r.followUp ? { followUp: r.followUp } : {}),
    };
  });
}

/**
 * Checked before the writer calls Bunny about a "failed" answer, so nothing reaches Bunny for a
 * job that isn't an open check of this video: the job (as {@link ANSWER_SQL} checks it), whether
 * it is still open, whether the writer has already asked Bunny for the file's re-encode (a check
 * ended applied with {@link REENCODED}: only the writer's own `reencoding` answer ends one so,
 * and it does so before Bunny is asked), and whether that re-encode has failed in turn: Bunny's
 * own "failed" notice (reason bunny_failed) reached a check job opened after the request (Codex
 * review r1, finding 2: Bunny may still show the original failure for a while after the request).
 */
const BEFORE_FAILED_SQL = `
  LET $j = (SELECT kind, file, doneAt FROM ONLY type::record('mediaJob', $job));
  IF $j = NONE { THROW 'media_job_not_found' };
  IF <string> record::id($j.file) != $videoId { THROW 'media_job_wrong_video' };
  IF $j.kind != 'check' { THROW 'media_job_not_a_check' };
  LET $asked = (SELECT VALUE doneAt FROM mediaJob WHERE file = $j.file AND kind = 'check'
    AND doneAt != NONE AND outcome = 'applied' AND lastError = $reencoded
    ORDER BY doneAt DESC LIMIT 1)[0];
  {
    open: $j.doneAt = NONE,
    reencoded: $asked != NONE,
    reencodeFailed: $asked != NONE AND (SELECT VALUE id FROM mediaJob WHERE file = $j.file
      AND kind = 'check' AND queuedAt >= $asked AND 'bunny_failed' IN reasons LIMIT 1) != []
  };`;

/**
 * What the writer does with a worker's "failed" answer (Part 1a; Joel, 2026-11-10): it doesn't
 * take the worker's word for it (a home PC can never make a file unusable). It asks Bunny itself;
 * unless Bunny says failed too, the answer is set aside (`retry`: the worker leaves the job in the
 * queue, and the next delivery asks again), counting nothing. A confirmed failure:
 * - the first for this file: the writer records it ({@link ANSWER_SQL}, `reencoding`: the job
 *   ends marked {@link REENCODED}, and a follow-up check job opens), then asks Bunny to encode it
 *   again (the one automatic re-encode). Bunny's notice when that ends joins the follow-up (or
 *   opens a check, if the follow-up has ended), so its result is always checked (Codex review r1,
 *   finding 1). If asking Bunny fails, that counts on the follow-up; it is never asked again;
 * - after that request, but before Bunny's own "failed" notice came for a check opened since: not
 *   yet known to be the re-encode's failure (Bunny may still show the first one). The writer only
 *   reads Bunny's status (never a second re-encode request: one per file, Codex review r2) and
 *   counts a failure on the job ({@link REENCODE_PENDING}; "try again later" until it gives up at
 *   {@link MAX_FAILURES} as ours, bunny_unavailable), the job open for Bunny's notice to join
 *   (G2: no timer, Bunny's real status);
 * - after Bunny's notice that the re-encode failed: the file can't be used (`unusable`): failed,
 *   the job given up with errorType file_unusable, and the story sent back by the database.
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
    const results = await runQuery(db, BEFORE_FAILED_SQL, {
      job,
      videoId: video,
      reencoded: REENCODED,
    }).catch(notFound);
    const { open, reencoded, reencodeFailed } = results[results.length - 1] as {
      open: boolean;
      reencoded: boolean;
      reencodeFailed: boolean;
    };
    const failed = (final: boolean) =>
      answerJob(db, job, video, { outcome: 'failed', final }, arrivedAt);
    // A job already ended: the answer is stale, recorded without asking Bunny anything.
    if (!open) return await failed(false);
    if ((await bunny.videoStatus(video)) !== 'failed') return { retry: true };
    if (reencodeFailed) return await failed(true);
    if (reencoded) {
      // The one automatic re-encode was already asked for: never again (Joel's rule). Only
      // Bunny's status was read; the wait counts as the job's failure, so it gives up after
      // MAX_FAILURES as ours (bunny_unavailable) if Bunny's notice never comes.
      return await failJob(db, job, video, REENCODE_PENDING);
    }
    const result = await failed(false);
    if (result.followUp) {
      try {
        await bunny.reencode(video);
      } catch (err) {
        if (!(err instanceof BunnyCallFailed)) throw err;
        await failJob(db, result.followUp, video, err.code);
      }
    }
    return result;
  } catch (err) {
    if (!(err instanceof BunnyCallFailed)) throw err;
    return failJob(db, job, video, err.code);
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

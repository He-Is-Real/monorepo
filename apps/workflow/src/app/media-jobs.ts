import { retryOnConflict, runQuery } from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
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
  | { outcome: 'failed' | 'encoding' | 'gone' };

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
    return { outcome: outcome as 'failed' | 'encoding' | 'gone' };
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
 * - a video: its facts, and (`$thumbSet`) the picture Bunny now shows for it (thumbnailOf), which
 *   the writer has just set at Bunny (video-bundle-rethink part A), if it is still the story's
 *   picture at the commit (else `thumbnailSettled` is false and the writer sets Bunny again);
 * - a person's own audio upload (no renderOf): its length only, still `processing`: it is ready
 *   only once its picture video is (approval needs that), so a render job of it opens;
 * - a picture video (renderOf): its facts as a video's; if the story's picture is no longer the
 *   one it was made with (thumbnailOf), a render job of it opens (reason picture_changed).
 * The job ends with that outcome if it is still open. A job already ended (the queue delivered
 * it twice, or a new reason was sent after an answer) keeps its outcome; the answer itself, made
 * fresh at Bunny, is still applied by the same rules. Answers the outcome, the render job
 * opened, if any (the writer sends it after the commit), and whether Bunny's picture is the
 * story's at the commit.
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
  -- The picture the writer just had Bunny show is recorded only if it is still the story's picture
  -- now, whatever the answer's outcome (it is a fact about Bunny, not about this answer). If it
  -- isn't, the writer puts Bunny right after the commit (settleThumbnail).
  LET $thumbRec = IF $thumbOf = NONE { NONE } ELSE { type::record('storyFile', $thumbOf) };
  LET $thumbKept = $thumbSet AND $shown AND $f.format = 'video' AND $thumbRec = $picture;
  IF $thumbKept {
    UPDATE $f.id SET thumbnailOf = $thumbRec RETURN NONE;
  };
  IF $j.doneAt = NONE {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = $outcome RETURN NONE;
  };
  { outcome: $outcome, render: $render, thumbnailSettled: !$thumbSet OR !$shown OR $thumbKept };`;

/**
 * Bunny's picture for a video (video-bundle-rethink part A), what the writer set at Bunny just
 * before the answer's write: the picture's path (null: Bunny's own frame again) and Bunny's
 * thumbnail file afterwards.
 */
export interface ThumbnailSet {
  picture: string | null;
  thumbnailFileName: string;
}

/**
 * The query's variables: whether the answer is ready, the facts for a file that isn't
 * (`notReady`) and for a ready one (`video`; an audio upload keeps only its length), its
 * thumbnail's file name, which the write puts under the video's own folder at Bunny (its file's
 * id, R12), and the picture the writer just had Bunny show, if it did.
 */
export function answerVars(
  job: string,
  video: string,
  answer: MediaAnswer,
  arrivedAt: string,
  thumbnail?: ThumbnailSet,
): Record<string, unknown> {
  const vars = {
    job,
    videoId: video,
    at: arrivedAt,
    thumbSet: thumbnail !== undefined,
    thumbOf: thumbnail?.picture ?? undefined,
  };
  if (answer.outcome !== 'ready') {
    // A video deleted at Bunny while its story still shows it counts as failed (the plan's
    // "When things go wrong").
    const processing = answer.outcome === 'encoding' ? 'processing' : 'failed';
    return { ...vars, ready: false, notReady: { processing } };
  }
  return {
    ...vars,
    ready: true,
    title: answer.title,
    thumb: thumbnail?.thumbnailFileName ?? answer.thumbnailFileName,
    video: {
      processing: 'ready',
      width: answer.width,
      height: answer.height,
      lengthSeconds: answer.lengthSeconds,
    },
  };
}

/** The picture a ready video's story wants Bunny to show, read before the answer's write. */
const PICTURE_SQL = `
  LET $j = (SELECT kind, file FROM ONLY type::record('mediaJob', $job));
  LET $f = IF $j != NONE AND $j.kind = 'check' AND <string> record::id($j.file) = $videoId {
    (SELECT format, story, detachedAt FROM ONLY $j.file) };
  IF $f = NONE OR $f.format != 'video' OR $f.detachedAt != NONE
    OR !record::exists($f.story) OR $f.story.mediaFile != $j.file { NONE } ELSE {
    LET $picture = (SELECT VALUE image.file FROM ONLY $f.story);
    { picture: IF $picture != NONE { <string> record::id($picture) } }
  };`;

/**
 * The picture a ready video's story wants Bunny to show: the story's own picture's path, or null
 * for Bunny's own frame (no picture). undefined when it isn't a video its story shows. The writer
 * sets it at Bunny on every ready check rather than trusting storyFile.thumbnailOf: if an earlier
 * answer set Bunny's picture but its database write then failed, the stored pointer is behind
 * Bunny, and only setting it again puts Bunny right (Codex review of PR 201, round 1).
 */
export async function wantedThumbnail(
  db: SurrealQueryable,
  job: string,
  video: string,
): Promise<string | null | undefined> {
  const results = await runQuery(db, PICTURE_SQL, { job, videoId: video });
  const found = results[results.length - 1] as {
    picture?: string | null;
  } | null;
  if (!found) return undefined;
  return found.picture ?? null;
}

/** What an answer did: its outcome, and the render job it opened (to send after the commit). */
export interface AnswerResult {
  outcome: AnswerOutcome;
  render: QueuedJob | null;
  /**
   * false: the picture the writer set at Bunny before the write is no longer the story's (it
   * changed meanwhile, or a newer check set another after it); {@link settleThumbnail} puts
   * Bunny right.
   */
  thumbnailSettled: boolean;
}

/**
 * Applies the worker's answer about `video` to the job's file (refused with
 * {@link MediaJobWrongVideo} if that isn't the job's video), signed in as service:workflow (the
 * only login that may set a file's processing, A2), and ends the job, in one transaction.
 * `arrivedAt` is when the worker's call reached the writer (F1): an answer applies only if no
 * answer that arrived at or after it is in. A transaction conflict (another answer, a moderator's
 * step or an erasure on the same person) re-runs it from scratch. `thumbnail`: the picture the
 * writer has just had Bunny show for the video, recorded with the answer.
 */
export async function answerJob(
  db: SurrealQueryable,
  job: string,
  video: string,
  answer: MediaAnswer,
  arrivedAt: string,
  thumbnail?: ThumbnailSet,
): Promise<AnswerResult> {
  const vars = answerVars(job, video, answer, arrivedAt, thumbnail);
  return retryOnConflict(async () => {
    const results = await runQuery(
      db,
      `BEGIN TRANSACTION;${ANSWER_SQL}\nCOMMIT TRANSACTION;`,
      vars,
    ).catch(notFound);
    const r = results[results.length - 2] as {
      outcome: AnswerOutcome;
      render?: Omit<QueuedJob, 'kind'> | null;
      thumbnailSettled: boolean;
    };
    return {
      outcome: r.outcome,
      render: r.render ? { ...r.render, kind: 'render' } : null,
      thumbnailSettled: r.thumbnailSettled,
    };
  });
}

/**
 * Records the picture the writer has just had Bunny show for a video (`$thumbOf`, null for
 * Bunny's frame; `$thumb`, Bunny's thumbnail file afterwards), only if it is the story's picture
 * now; otherwise nothing is written. Answers whether it was (or the file is no longer a video its
 * story shows, so nothing needs setting).
 */
const SETTLE_SQL = `BEGIN TRANSACTION;
  LET $j = (SELECT kind, file FROM ONLY type::record('mediaJob', $job));
  LET $f = IF $j != NONE AND $j.kind = 'check' AND <string> record::id($j.file) = $videoId {
    (SELECT id, format, story, detachedAt, processing FROM ONLY $j.file) };
  LET $shown = $f != NONE AND $f.format = 'video' AND $f.detachedAt = NONE
    AND record::exists($f.story) AND $f.story.mediaFile = $f.id;
  LET $picture = IF $shown { (SELECT VALUE image.file FROM ONLY $f.story) };
  LET $set = IF $thumbOf = NONE { NONE } ELSE { type::record('storyFile', $thumbOf) };
  LET $kept = $shown AND $set = $picture;
  IF $kept {
    UPDATE $f.id SET thumbnailOf = $set RETURN NONE;
    IF $f.processing = 'ready' {
      UPDATE $f.id SET thumbnailPath = <string> record::id($f.id) + '/' + $thumb RETURN NONE;
    };
  };
  { settled: !$shown OR $kept };
  COMMIT TRANSACTION;`;

/** How often {@link settleThumbnail} sets Bunny's picture before leaving it to a redelivery. */
const SETTLE_TRIES = 3;

/**
 * Puts Bunny's picture for a video right after an answer whose picture is no longer the story's
 * (Codex review of PR 201, round 2): two checks of the same video can overlap, and the one that
 * read the older picture may reach Bunny last. Each try reads the picture the story wants now,
 * sets it at Bunny, and records it only if it is still the story's picture; whoever sets Bunny
 * last checks the database after it, so Bunny ends on the picture the database records. Answers
 * false if the picture kept changing for {@link SETTLE_TRIES} tries; a Bunny error from
 * `setThumbnail` is thrown as it comes.
 */
export async function settleThumbnail(
  db: SurrealQueryable,
  setThumbnail: (video: string, picture: string | null) => Promise<string>,
  job: string,
  video: string,
): Promise<boolean> {
  for (let i = 0; i < SETTLE_TRIES; i++) {
    const wanted = await wantedThumbnail(db, job, video);
    if (wanted === undefined) return true;
    const thumb = await setThumbnail(video, wanted);
    const settled = await retryOnConflict(async () => {
      const results = await runQuery(db, SETTLE_SQL, {
        job,
        videoId: video,
        thumbOf: wanted ?? undefined,
        thumb,
      });
      return (results[results.length - 2] as { settled: boolean }).settled;
    });
    if (settled) return true;
  }
  return false;
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
      outcome = IF $end { 'gave_up' } ELSE { NONE } RETURN NONE;
  };
  IF $j.doneAt != NONE { { retry: false, outcome: $j.outcome } }
    ELSE IF $end { { retry: false, outcome: 'gave_up' } }
    ELSE { { retry: true } };
  COMMIT TRANSACTION;`;

/**
 * Counts the worker's failure on the job, with its short code (J4). Under {@link MAX_FAILURES}:
 * try again later (the worker doesn't mark it taken, and the queue redelivers it). At the fifth:
 * the job ends as gave_up, and the worker marks it taken so the story's later jobs carry on. A
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

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
 * - a video, with Bunny on (`$bunny`): its facts, and the story's picture now as thumbnailOf, the
 *   picture the writer is about to give Bunny (video-bundle-rethink part A). The job stays OPEN:
 *   it is the "not ready" flag that keeps approval waiting (fn::story::approval_wait) until the
 *   writer has set Bunny and closed it (CLOSE_SQL; Joel, 2026-11-08, T1 option C). `contested`:
 *   the job is open, thumbnailOf is another picture, and an answer reached the writer after the
 *   job was queued (checkedAt, the writer's clock, against queuedAt, the database's; both keep
 *   Google's time), so an earlier delivery of the job (or a late one of an ended job) may still be
 *   setting that picture at Bunny. This delivery then never closes the job: the earlier one does
 *   when it finds the picture changed, or a redelivery once nobody else is mid-way;
 * - a person's own audio upload (no renderOf): its length only, still `processing`: it is ready
 *   only once its picture video is (approval needs that), so a render job of it opens;
 * - a picture video (renderOf): its facts as a video's; if the story's picture is no longer the
 *   one it was made with (thumbnailOf), a render job of it opens (reason picture_changed).
 * Any other outcome ends the job if it is still open, except a stale answer about a video with
 * Bunny on: the newer answer that made it stale owns the open job and closes it once Bunny is
 * set. A job already ended (the queue delivered it twice, or a new reason was sent after an
 * answer) keeps its outcome; the answer itself, made fresh at Bunny, is still applied by the same
 * rules, so a redelivery of an ended job still sets Bunny's picture before it is acknowledged.
 * Answers the outcome, the render job opened, if any (the writer sends it after the commit), and
 * the picture to give Bunny, if any.
 */
export const ANSWER_SQL = `
  LET $j = (SELECT kind, file, doneAt, reasons, queuedAt FROM ONLY type::record('mediaJob', $job));
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
  -- T1 option C: a ready video's picture is recorded before Bunny is told, with the job left open.
  LET $thumbnail = $bunny AND $outcome = 'applied' AND $ready AND $f.format = 'video';
  IF $outcome = 'applied' {
    LET $facts = IF !$ready { $notReady }
      ELSE IF $source { { processing: 'processing', lengthSeconds: $video.lengthSeconds } }
      ELSE { object::extend($video, { thumbnailPath: <string> record::id($f.id) + '/' + $thumb }) };
    UPDATE $f.id MERGE object::extend($facts, { checkedAt: <datetime> $at }) RETURN NONE;
  };
  IF $thumbnail {
    UPDATE $f.id SET thumbnailOf = $picture RETURN NONE;
  };
  LET $keepOpen = $thumbnail OR ($bunny AND $outcome = 'stale' AND $f.format = 'video');
  IF $j.doneAt = NONE AND !$keepOpen {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = $outcome RETURN NONE;
  };
  { outcome: $outcome, render: $render,
    thumbnail: IF $thumbnail { {
      picture: IF $picture != NONE { <string> record::id($picture) },
      contested: $j.doneAt = NONE AND $f.thumbnailOf != $picture AND $f.checkedAt != NONE
        AND $f.checkedAt > $j.queuedAt
    } } };`;

/**
 * The query's variables: whether the answer is ready, the facts for a file that isn't
 * (`notReady`) and for a ready one (`video`; an audio upload keeps only its length), its
 * thumbnail's file name, which the write puts under the video's own folder at Bunny (its file's
 * id, R12), and whether the writer sets a ready video's picture at Bunny (`bunny`).
 */
export function answerVars(
  job: string,
  video: string,
  answer: MediaAnswer,
  arrivedAt: string,
  bunny = false,
): Record<string, unknown> {
  const vars = { job, videoId: video, at: arrivedAt, bunny };
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
    thumb: answer.thumbnailFileName,
    video: {
      processing: 'ready',
      width: answer.width,
      height: answer.height,
      lengthSeconds: answer.lengthSeconds,
    },
  };
}

/**
 * The picture to give Bunny for a ready video (T1 option C): a story picture's path, or null for
 * Bunny's own frame, already recorded as the file's thumbnailOf with the job left open.
 */
export interface WantedThumbnail {
  picture: string | null;
  /** An earlier delivery of the job may still be setting another picture: never close the job. */
  contested: boolean;
}

/** What an answer did: its outcome, and the render job it opened (to send after the commit). */
export interface AnswerResult {
  outcome: AnswerOutcome;
  render: QueuedJob | null;
  /** Set for a ready video with Bunny on: the writer now sets this at Bunny, then closes the job. */
  thumbnail: WantedThumbnail | null;
}

/**
 * Applies the worker's answer about `video` to the job's file (refused with
 * {@link MediaJobWrongVideo} if that isn't the job's video), signed in as service:workflow (the
 * only login that may set a file's processing, A2), and ends the job, in one transaction; for a
 * ready video with `bunny`, it records the picture and leaves the job open instead
 * ({@link applyThumbnail} finishes). `arrivedAt` is when the worker's call reached the writer
 * (F1): an answer applies only if no answer that arrived at or after it is in. A transaction
 * conflict (another answer, a moderator's step or an erasure on the same person) re-runs it from
 * scratch.
 */
export async function answerJob(
  db: SurrealQueryable,
  job: string,
  video: string,
  answer: MediaAnswer,
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
      outcome: AnswerOutcome;
      render?: Omit<QueuedJob, 'kind'> | null;
      thumbnail?: { picture?: string | null; contested: boolean } | null;
    };
    return {
      outcome: r.outcome,
      render: r.render ? { ...r.render, kind: 'render' } : null,
      thumbnail: r.thumbnail
        ? {
            picture: r.thumbnail.picture ?? null,
            contested: r.thumbnail.contested,
          }
        : null,
    };
  });
}

/**
 * After Bunny took a video's picture (`$mine`, NONE for its own frame; `$thumb`, Bunny's thumbnail
 * file afterwards), in one transaction: if the story's picture is still that one, record it and
 * close the job as applied (unless `$contested`, or it already ended; `open` says whether it is
 * still open); if it changed meanwhile,
 * record the story's picture now and answer it, for the writer to set at Bunny before trying
 * again. A file its story no longer shows needs no picture: its open job ends as gone.
 */
const CLOSE_SQL = `BEGIN TRANSACTION;
  LET $j = (SELECT kind, file, doneAt FROM ONLY type::record('mediaJob', $job));
  IF $j = NONE { THROW 'media_job_not_found' };
  IF <string> record::id($j.file) != $videoId { THROW 'media_job_wrong_video' };
  LET $f = (SELECT id, format, story, detachedAt, removedAt, processing FROM ONLY $j.file);
  LET $shown = $f != NONE AND $f.format = 'video' AND $f.detachedAt = NONE
    AND $f.removedAt = NONE AND record::exists($f.story) AND $f.story.mediaFile = $f.id;
  LET $picture = IF $shown { (SELECT VALUE image.file FROM ONLY $f.story) };
  LET $mineRec = IF $mine = NONE { NONE } ELSE { type::record('storyFile', $mine) };
  LET $kept = $shown AND $picture = $mineRec;
  IF $kept {
    UPDATE $f.id SET thumbnailOf = $mineRec RETURN NONE;
    IF $f.processing = 'ready' {
      UPDATE $f.id SET thumbnailPath = <string> record::id($f.id) + '/' + $thumb RETURN NONE;
    };
  };
  IF $shown AND !$kept {
    UPDATE $f.id SET thumbnailOf = $picture RETURN NONE;
  };
  LET $close = $j.doneAt = NONE AND (!$shown OR ($kept AND !$contested));
  IF $close {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(),
      outcome = IF $shown { 'applied' } ELSE { 'gone' } RETURN NONE;
  };
  IF !$shown OR $kept { { settled: true, open: $j.doneAt = NONE AND !$close } }
    ELSE { { settled: false, picture: IF $picture != NONE { <string> record::id($picture) } } };
  COMMIT TRANSACTION;`;

/** How often {@link applyThumbnail} sets Bunny's picture before leaving it to a redelivery. */
const THUMBNAIL_TRIES = 3;

/**
 * How {@link applyThumbnail} ended: `closed` (Bunny shows the story's picture, and the job is
 * closed, or had ended already), or `pending` (the job stays open, approval keeps waiting, and the
 * worker leaves it in the queue: the picture kept changing, or another delivery may be mid-way).
 */
export type ThumbnailOutcome = 'closed' | 'pending';

/**
 * Sets a ready video's picture at Bunny after {@link answerJob} recorded it (T1 option C, steps b
 * and c), then closes the job only if the story's picture is still the one Bunny now shows; if
 * it changed meanwhile, the story's picture now is recorded, set at Bunny and checked again. A
 * Bunny error from `setThumbnail` is thrown as it comes, with the job still open: it never counts
 * as the worker's failure, and a redelivery, the 18:00 resend or the next check finishes it.
 */
export async function applyThumbnail(
  db: SurrealQueryable,
  setThumbnail: (video: string, picture: string | null) => Promise<string>,
  job: string,
  video: string,
  wanted: WantedThumbnail,
): Promise<ThumbnailOutcome> {
  let picture = wanted.picture;
  for (let i = 0; i < THUMBNAIL_TRIES; i++) {
    const thumb = await setThumbnail(video, picture);
    const r = await retryOnConflict(async () => {
      const results = await runQuery(db, CLOSE_SQL, {
        job,
        videoId: video,
        mine: picture ?? undefined,
        thumb,
        contested: wanted.contested,
      }).catch(notFound);
      return results[results.length - 2] as {
        settled: boolean;
        open?: boolean;
        picture?: string | null;
      };
    });
    if (r.settled) return r.open ? 'pending' : 'closed';
    picture = r.picture ?? null;
  }
  return 'pending';
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

import { retryOnConflict, runQuery } from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
import { BunnyCallFailed, type UploadPass, type WriterBunny } from './bunny';
import {
  type AnswerOutcome,
  InvalidMediaJobCall,
  MediaJobNotFound,
  MediaJobWrongVideo,
} from './media-jobs';
import type { QueuedJob } from './media-queue';

/**
 * An audio story's picture video (Joel, 2026-11-07: audio-picture-video.html decisions 1B and
 * 2 = K1, 4 = own shape). A render job names the audio file whose sound the worker takes (the
 * story's file when the job was written). The worker asks the writer for a pass, makes the video
 * and uploads it to a NEW Bunny video, then tells the writer it's done:
 *
 * 1. `upload-pass`: the writer decides whether a picture video is still needed (below). If so, it
 *    makes the new Bunny video (titled with the story's id, D69), or reuses the one an earlier try
 *    made (mediaJob.madeFile), and answers a one-hour TUS pass for that one video only, the
 *    picture's path and a 10-minute link to it (none: the site's default background). The full
 *    library key never leaves Google Cloud.
 * 2. `rendered`: in one transaction, the writer adds the new video's storyFile row (renderOf: the
 *    audio file; thumbnailOf: the picture it was made with), moves the story to it only while
 *    the story still points at the audio file (no new version; the audio file is detached and the
 *    nightly clean-up deletes it at Bunny), opens a check of the new video and ends the job.
 *    Then the media-ready check treats the new video like any other.
 *
 * The decision, read and written in one transaction (a job already ended answers its outcome):
 * - gone: the file isn't the story's audio file any more (a new recording, removed, the story
 *   deleted): nothing to make;
 * - stale: its sound isn't ready at Bunny yet (no length: the check that finds it ready opens a
 *   render then) or it failed, or it is already a picture video made with the story's picture;
 * - render: anything else: a person's audio upload, or a picture video whose picture changed.
 */

/** A new picture video's file id at Bunny, and its size as the worker uploaded it. */
const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A story's own picture (fn::media::own_image). */
const PICTURE = /^stories\/[A-Za-z0-9_]{1,64}\/[0-9a-f]{32}\.webp$/;
/** Bunny takes uploads of a few GB; a picture video of our longest story is far smaller. */
const MAX_RENDER_BYTES = 4 * 1024 ** 3;

/** What the worker does next (the contract's `UploadPassReply`). */
export type PassReply =
  | { outcome: AnswerOutcome | 'gave_up' }
  | {
      outcome: 'render';
      renderVideoId: string;
      upload: UploadPass;
      /** The picture's path in the images zone, or null: the site's default background. */
      picture: string | null;
      /** A 10-minute link to it, or null. */
      pictureUrl: string | null;
    };

/** The worker's "done": the new video it uploaded, the picture it used and the file's size. */
export interface Rendered {
  renderVideoId: string;
  picture: string | null;
  sizeBytes: number;
}

export function parseRendered(input: unknown): Rendered {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidMediaJobCall('not an object');
  }
  const { renderVideoId, picture, sizeBytes } = input as Record<
    string,
    unknown
  >;
  if (typeof renderVideoId !== 'string' || !VIDEO_ID.test(renderVideoId)) {
    throw new InvalidMediaJobCall('a rendered call needs the new video’s id');
  }
  if (
    picture !== null &&
    (typeof picture !== 'string' || !PICTURE.test(picture))
  ) {
    throw new InvalidMediaJobCall(
      'a rendered call needs its picture’s path, or null',
    );
  }
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_RENDER_BYTES
  ) {
    throw new InvalidMediaJobCall('a rendered call needs the file’s size');
  }
  return { renderVideoId, picture, sizeBytes };
}

/** The job, its audio file and its story, as both steps read them. */
const READ_JOB = `
  LET $j = (SELECT kind, file, doneAt, outcome, madeFile FROM ONLY type::record('mediaJob', $job));
  IF $j = NONE { THROW 'media_job_not_found' };
  IF <string> record::id($j.file) != $videoId { THROW 'media_job_wrong_video' };
  IF $j.kind != 'render' { THROW 'media_job_not_a_render' };
  LET $f = (SELECT id, format, story, person, detachedAt, removedAt, renderOf, thumbnailOf,
    lengthSeconds, processing FROM ONLY $j.file);
  LET $shown = $f != NONE AND $f.format = 'audio' AND $f.detachedAt = NONE
    AND $f.removedAt = NONE AND record::exists($f.story) AND $f.story.mediaFile = $f.id;`;

const PASS_SQL = `BEGIN TRANSACTION;${READ_JOB}
  -- Not f.story.image.file: through an empty image, 3.2.4 fails ("Specify a database to use").
  LET $picture = IF $shown { (SELECT VALUE image.file FROM ONLY $f.story) };
  LET $decision = IF $j.doneAt != NONE { $j.outcome }
    ELSE IF !$shown { 'gone' }
    ELSE IF $f.lengthSeconds = NONE OR $f.processing = 'failed' { 'stale' }
    ELSE IF $f.renderOf != NONE AND $f.thumbnailOf = $picture { 'stale' }
    ELSE { 'render' };
  IF $j.doneAt = NONE AND $decision != 'render' {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = $decision RETURN NONE;
  };
  { decision: $decision,
    story: IF $shown { <string> record::id($f.story) },
    picture: IF $picture != NONE { <string> record::id($picture) },
    madeFile: IF $j.madeFile != NONE { <string> record::id($j.madeFile) } };
  COMMIT TRANSACTION;`;

/**
 * The worker's upload pass for a render job (step 1 above), or the job's outcome if no picture
 * video is needed. Bunny refusing or unreachable throws {@link BunnyCallFailed}: the worker
 * counts it as the job's failure.
 */
export async function uploadPassFor(
  db: SurrealQueryable,
  bunny: WriterBunny,
  job: string,
  video: string,
): Promise<PassReply> {
  const read = await retryOnConflict(async () => {
    const results = await runQuery(db, PASS_SQL, { job, videoId: video }).catch(
      renderError,
    );
    return results[results.length - 2] as {
      decision: AnswerOutcome | 'gave_up' | 'render';
      story?: string | null;
      picture?: string | null;
      madeFile?: string | null;
    };
  });
  if (read.decision !== 'render') return { outcome: read.decision };
  if (!read.story) throw new Error('A render job without its story');

  // An earlier try's video is reused while Bunny still has it, so a retry leaves no stray video.
  let made = read.madeFile ?? null;
  if (!made || !(await bunny.exists(made))) {
    made = await bunny.createVideo(read.story);
    await retryOnConflict(() =>
      runQuery(
        db,
        `UPDATE type::record('mediaJob', $job) SET madeFile = type::record('storyFile', $made)
           WHERE doneAt = NONE RETURN NONE`,
        { job, made },
      ),
    );
  }
  const picture = read.picture ?? null;
  const pictureUrl = picture ? await bunny.pictureUrl(picture) : null;
  if (picture && !pictureUrl) throw new BunnyCallFailed('picture_unsafe');
  return {
    outcome: 'render',
    renderVideoId: made,
    upload: await bunny.uploadPass(made),
    picture,
    pictureUrl,
  };
}

const RENDERED_SQL = `BEGIN TRANSACTION;${READ_JOB}
  IF $j.madeFile = NONE OR <string> record::id($j.madeFile) != $renderId {
    THROW 'media_job_not_its_render';
  };
  LET $outcome = IF $j.doneAt != NONE { $j.outcome } ELSE IF !$shown { 'gone' } ELSE { 'applied' };
  LET $render = type::record('storyFile', $renderId);
  LET $check = IF $j.doneAt = NONE AND $shown {
    CREATE $render CONTENT {
      story: $f.story, person: $f.person, format: 'audio', contentType: 'video/mp4',
      sizeBytes: $sizeBytes, storyVersion: $f.story.version, renderOf: $f.id,
      thumbnailOf: IF $picture != NONE { type::record('storyFile', $picture) }
    } RETURN NONE;
    UPDATE $f.story SET mediaFile = $render RETURN NONE;
    IF $f.story.mediaFile != $render { THROW 'media_render_not_moved' };
    fn::media::queue_job($render, 'check', 'rendered')
  };
  IF $j.doneAt = NONE {
    UPDATE type::record('mediaJob', $job) SET doneAt = time::now(), outcome = $outcome RETURN NONE;
  };
  { outcome: $outcome, check: $check };
  COMMIT TRANSACTION;`;

/**
 * The worker's "done" for a render job (step 2 above). Answers the job's outcome and the check job
 * it opened for the new video (sent after the commit). A job already ended answers its outcome and
 * writes nothing; a picture that isn't the story's own is refused.
 */
export async function renderedJob(
  db: SurrealQueryable,
  job: string,
  video: string,
  done: Rendered,
): Promise<{ outcome: AnswerOutcome | 'gave_up'; check: QueuedJob | null }> {
  return retryOnConflict(async () => {
    const results = await runQuery(db, RENDERED_SQL, {
      job,
      videoId: video,
      renderId: done.renderVideoId,
      picture: done.picture ?? undefined,
      sizeBytes: done.sizeBytes,
      // The pointer move isn't the person's edit: the story keeps its version (1B).
      renderMove: true,
    }).catch(renderError);
    const r = results[results.length - 2] as {
      outcome: AnswerOutcome | 'gave_up';
      check?: Omit<QueuedJob, 'kind'> | null;
    };
    return {
      outcome: r.outcome,
      check: r.check ? { ...r.check, kind: 'check' } : null,
    };
  });
}

function renderError(err: unknown): never {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('media_job_not_found')) throw new MediaJobNotFound();
  if (message.includes('media_job_wrong_video')) throw new MediaJobWrongVideo();
  if (message.includes('media_job_not_a_render')) {
    throw new InvalidMediaJobCall('not a render job');
  }
  if (message.includes('media_job_not_its_render')) {
    throw new InvalidMediaJobCall('not the job’s picture video');
  }
  if (message.includes('a picture of its own story')) {
    throw new InvalidMediaJobCall('not a picture of the job’s story');
  }
  throw err;
}

import { PubSub } from '@google-cloud/pubsub';
import { traceAttributes } from '@heisreal/logging/event';
import { retryOnConflict, runQuery } from '@heisreal/database';
import { withTimeout } from '@heisreal/secrets';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * The media job table's chores (Joel, 2026-11-07: media-job-table.html J1/J2,
 * media-worker-final.html section 1 step 7). A job lives in the mediaJob table until the result
 * writer ends it; Google's queue (media-jobs) is only the delivery route, which can drop a job
 * (31 days' retention, a failed send). So:
 * - the media resend, at 18:00 London time when Joel's machine is on (Joel, 2026-11-07: "do the
 *   resend at 18:00 UK local time, as that is when my pc is on and will have a worker
 *   available"), its own run (modules/gcp/housekeeping.tf): every job not ended whose last send
 *   (or, if it was never sent, its writing) is over 12 hours old goes to the queue again, so a job
 *   sent the same evening isn't doubled;
 * - the tidy-up, in the nightly run: ended jobs go 30 days after they ended (J2), except while
 *   their story waits for review (P1-3: then they go once it is decided or deleted). The database
 *   lets housekeeping delete only those (docs/db-permissions.md), so the query only picks;
 * - the nightly new check of a waiting story whose newest job gave up on our side (Part 1a).
 * Job ids are ULIDs: no personal data, so the logs carry them.
 */

/**
 * A message on `media-jobs` (libs/contracts worker.yaml, `MediaJob`), as api-user sends it
 * (apps/api-user bunny-webhook.ts): the job's id, which the worker answers on, its kind and its
 * Bunny video.
 */
export interface MediaJobMessage {
  jobId: string;
  kind: string;
  videoId: string;
}

/**
 * Puts a job on `media-jobs`; resolves once Pub/Sub has it. `orderingKey`: the story's id, so a
 * story's jobs reach the worker in order (as api-user sends them). A fake stands in for it in
 * tests.
 */
export interface MediaJobs {
  publish(job: MediaJobMessage, orderingKey: string): Promise<void>;
}

const PUBLISH_TIMEOUT_MS = 10_000;

/** `topic` on Pub/Sub's London endpoint (UK data: the message never leaves London). */
export function pubsubMediaJobs(project: string, topic: string): MediaJobs {
  const publisher = new PubSub({
    projectId: project,
    apiEndpoint: 'europe-west2-pubsub.googleapis.com',
  }).topic(topic, { batching: { maxMessages: 1 }, messageOrdering: true });
  return {
    async publish(job, orderingKey) {
      try {
        await withTimeout(
          publisher.publishMessage({
            json: job,
            orderingKey,
            // The request's trace id, so the job can be followed (LG-4 A).
            attributes: traceAttributes(),
          }),
          PUBLISH_TIMEOUT_MS,
          'Publishing to Pub/Sub',
        );
      } catch (err) {
        // A failed publish pauses its key in the client; the next evening sends it again.
        publisher.resumePublishing(orderingKey);
        throw err;
      }
    },
  };
}

/** How long after its last send a job not yet ended is sent again. */
export const RESEND_AFTER = '12h';
/** How long an ended job is kept (J2); the table's delete permission says the same. */
const KEEP_ENDED = '30d';
/** Ended jobs are tiny rows: a run deletes up to this many times maxDeletions of them. */
const JOBS_PER_DELETION = 20;

interface DueJob {
  job: string;
  kind: string;
  video: string;
  story: string;
}

/** The longest-waiting jobs to send again, oldest first (so a story's stay in order). */
const DUE = `SELECT record::id(id) AS job, kind, record::id(file) AS video,
    record::id(file.story) AS story, queuedAt
  FROM mediaJob WHERE doneAt = NONE
    AND (sentAt ?? queuedAt) < time::now() - ${RESEND_AFTER}
  ORDER BY queuedAt ASC LIMIT $limit`;

/** Records a resend, only if the job is still open. */
const RESENT = `UPDATE type::record('mediaJob', $job)
  SET sentAt = time::now(), sends += 1, reasons = array::union(reasons, ['resent'])
  WHERE doneAt = NONE RETURN NONE`;

export const mediaResendTask: Task = {
  name: 'media-resend',
  async run(ctx): Promise<TaskResult> {
    if (!ctx.mediaJobs) throw new Error('The media-jobs topic is not set');
    const [found] = (await runQuery(ctx.db, DUE, {
      limit: ctx.maxDeletions + 1,
    })) as [DueJob[]];
    const due = (found ?? []).slice(0, ctx.maxDeletions);
    const result: TaskResult = {
      selected: due.map((j) => j.job),
      deleted: [],
      failed: [],
      more: (found ?? []).length > ctx.maxDeletions,
    };
    if (ctx.dryRun) return result;
    for (const j of due) {
      try {
        await ctx.mediaJobs.publish(
          { jobId: j.job, kind: j.kind, videoId: j.video },
          j.story,
        );
        await retryOnConflict(() => runQuery(ctx.db, RESENT, { job: j.job }));
        result.deleted.push(j.job);
      } catch {
        // Not sent, or sent but not recorded: either way the next evening sends it (again).
        result.failed.push(j.job);
      }
    }
    return result;
  },
};

/**
 * Part 1a (Joel, 2026-11-10): the video or audio files of stories waiting for review, or taken off
 * the site by the system (P1-5, P1-8, Joel, 2026-11-14; fn::story::keeps_media_jobs), whose
 * newest job gave up for a reason of ours (never Bunny's final failure: that file is failed and
 * its story went back to its owner), with no job open, that have given up at most
 * fn::media::nightly_retries() (3) times: the database's fn::media::our_problem decides. Found
 * from the jobs that gave up (few, and kept while they count), the longest-stuck first; the file
 * must still be its story's video or audio. Housekeeping never reads a waiting story's status
 * entry (block list), so fn::story::waiting tells it. A story a moderator hid isn't re-checked.
 */
const OUR_GIVE_UPS = `LET $files = array::distinct((SELECT file, doneAt FROM mediaJob
    WHERE outcome = 'gave_up' ORDER BY doneAt ASC).file);
  RETURN $files.filter(|$f| $f.story.mediaFile = $f
      AND fn::story::keeps_media_jobs($f.story)
      AND fn::media::our_problem($f).retry)
    .slice(0, $limit).map(|$f| record::id($f));`;

/**
 * Our own give-ups on a waiting story (Part 1a; Joel, 2026-11-10): "the nightly housekeeping opens
 * a new check for a waiting story whose newest check gave up, for up to 3 nights"; and the same
 * for a published story the site took off itself (P1-5, 2026-11-14), which stays off the site
 * after the third night while its owner keeps seeing "We're fixing your video". It opens a
 * check of the story's file (reason `resent`, the only job housekeeping may open) and sends
 * nothing: the 18:00 resend sends it that evening. For an audio file still without its picture
 * video, the check's ready answer opens the render again. After the third night the moderation
 * queue shows "Can't be reviewed yet: a problem on our side"; the person keeps seeing "Waiting for
 * review".
 */
export const ourGiveUpsTask: Task = {
  name: 'media-retry',
  async run(ctx): Promise<TaskResult> {
    const found = (
      await runQuery(ctx.db, OUR_GIVE_UPS, { limit: ctx.maxDeletions + 1 })
    ).at(-1) as string[] | undefined;
    const selected = (found ?? []).slice(0, ctx.maxDeletions);
    const result: TaskResult = {
      selected,
      deleted: [],
      failed: [],
      more: (found ?? []).length > ctx.maxDeletions,
    };
    if (ctx.dryRun) return result;
    for (const video of selected) {
      try {
        await retryOnConflict(() =>
          runQuery(
            ctx.db,
            `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', 'resent')`,
            { video },
          ),
        );
        result.deleted.push(video);
      } catch {
        result.failed.push(video);
      }
    }
    return result;
  },
};

/**
 * The longest-ended jobs' ids, at most `limit`, skipping those fn::media::job_kept keeps (Part 1a:
 * a story's jobs while it waits for review or is off the site because the site took it off, P1-3
 * and P1-9; the table's delete permission says the same).
 */
async function endedJobs(
  ctx: Pick<TaskContext, 'db'>,
  limit: number,
): Promise<string[]> {
  const [ids] = (await runQuery(
    ctx.db,
    `SELECT VALUE record::id(id) FROM mediaJob
       WHERE doneAt != NONE AND doneAt <= time::now() - ${KEEP_ENDED}
         AND !fn::media::job_kept(file)
       ORDER BY doneAt ASC LIMIT $limit`,
    { limit },
  )) as [string[]];
  return ids ?? [];
}

export const oldMediaJobsTask: Task = {
  name: 'old-media-jobs',
  async run(ctx): Promise<TaskResult> {
    const max = ctx.maxDeletions * JOBS_PER_DELETION;
    const found = await endedJobs(ctx, max + 1);
    const selected = found.slice(0, max);
    const result: TaskResult = {
      selected,
      deleted: [],
      failed: [],
      more: found.length > max,
    };
    if (ctx.dryRun) return result;
    for (let i = 0; i < selected.length; i += ctx.maxDeletions) {
      const batch = selected.slice(i, i + ctx.maxDeletions);
      try {
        const results = await runQuery(
          ctx.db,
          `DELETE $ids.map(|$id| type::record('mediaJob', $id))
             WHERE doneAt != NONE AND doneAt <= time::now() - ${KEEP_ENDED}
               AND !fn::media::job_kept(file) RETURN BEFORE`,
          { ids: batch },
        );
        result.deleted.push(
          ...((results.at(-1) as { id: unknown }[]) ?? []).map((r) =>
            String(r.id).replace(/^mediaJob:/, ''),
          ),
        );
      } catch {
        result.failed.push(...batch);
      }
    }
    return result;
  },
};

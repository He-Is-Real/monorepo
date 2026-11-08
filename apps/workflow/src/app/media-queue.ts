import { PubSub } from '@google-cloud/pubsub';
import { Logger } from '@nestjs/common';
import { retryOnConflict, runQuery } from '@heisreal/database';
import { withTimeout } from '@heisreal/secrets';
import type { SurrealQueryable } from 'surrealdb';

/**
 * The jobs the result writer opens itself (Joel, 2026-11-07: media-job-table.html J1 check e,
 * "the writer gets permission to send to the job queue"): an audio file's picture video once a
 * check finds it ready, again when the story's picture changed, and the check of a picture video
 * it just made. Like api-user, it writes each job first (in the answer's own transaction) and then
 * sends it on `media-jobs`, in order per story; a send that fails is logged, and the 18:00 resend
 * sends the job from the table (apps/housekeeping).
 */
export const MEDIA_QUEUE = Symbol('MEDIA_QUEUE');

/** A message on `media-jobs` (libs/contracts worker.yaml, `MediaJob`). */
export interface MediaJobMessage {
  jobId: string;
  kind: 'check' | 'render';
  videoId: string;
}

/** fn::media::queue_job's answer, with the job's kind. */
export interface QueuedJob {
  job: string;
  story: string;
  video: string;
  kind: 'check' | 'render';
}

/** Puts a job on `media-jobs`; resolves once Pub/Sub has it. A fake stands in for it in tests. */
export interface MediaQueue {
  publish(job: MediaJobMessage, orderingKey: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9_-]{1,255}$/;
const PUBLISH_TIMEOUT_MS = 10_000;

/** `media-jobs` on Pub/Sub's London endpoint, or null without MEDIA_JOBS_TOPIC (sending off). */
export function mediaQueueFromEnv(
  env: Record<string, string | undefined> = process.env,
): MediaQueue | null {
  const topic = env['MEDIA_JOBS_TOPIC'];
  const project = env['GCP_PROJECT'];
  if (!topic || !project) return null;
  if (!NAME.test(topic)) throw new Error('MEDIA_JOBS_TOPIC is malformed');
  // UK data: the London endpoint, so the message never leaves London.
  const publisher = new PubSub({
    projectId: project,
    apiEndpoint: 'europe-west2-pubsub.googleapis.com',
  }).topic(topic, { batching: { maxMessages: 1 }, messageOrdering: true });
  return {
    async publish(job, orderingKey) {
      try {
        await withTimeout(
          publisher.publishMessage({ json: job, orderingKey }),
          PUBLISH_TIMEOUT_MS,
          'Publishing to Pub/Sub',
        );
      } catch (err) {
        // A failed publish pauses its key in the client; the 18:00 resend sends the job.
        publisher.resumePublishing(orderingKey);
        throw err;
      }
    },
  };
}

const logger = new Logger('MediaQueue');

/**
 * Sends jobs the writer has already written down, and records each send (sentAt, sends). Never
 * throws: a job that couldn't be sent stays in the table for the 18:00 resend.
 */
export async function sendJobs(
  db: SurrealQueryable,
  queue: MediaQueue | null,
  jobs: readonly QueuedJob[],
): Promise<void> {
  for (const q of jobs) {
    if (!queue) {
      logger.warn(`Media queue off: job ${q.job} waits for the 18:00 resend`);
      continue;
    }
    try {
      await queue.publish(
        { jobId: q.job, kind: q.kind, videoId: q.video },
        q.story,
      );
      await retryOnConflict(() =>
        runQuery(
          db,
          `UPDATE type::record('mediaJob', $job) SET sentAt = time::now(), sends += 1 RETURN NONE`,
          { job: q.job },
        ),
      );
    } catch (err) {
      logger.warn(
        `Couldn't send media job ${q.job} (${err instanceof Error ? err.name : 'error'}); the 18:00 resend sends it`,
      );
    }
  }
}

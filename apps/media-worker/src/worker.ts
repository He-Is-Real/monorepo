import { VIDEO_ID, type CheckResult } from './bunny';
import type { Writer, WriterReply } from './writer';

/**
 * One job from `media-jobs` (worker.yaml `MediaJob`, as api-user and housekeeping send it), and
 * what Dapr should do with its message once the worker is done (media-worker-final.html section
 * 1; worker.yaml "Media ready"):
 * - SUCCESS: mark it taken (Pub/Sub acks it): the writer saved the answer or ended the job.
 * - RETRY: leave it in the queue (Pub/Sub nacks it and redelivers it later, 10 seconds up to 10
 *   minutes apart): the writer couldn't be reached, or it says "try again later".
 * - DROP: mark it taken without doing anything: the job is gone (404, it went with its file), or
 *   the message isn't a job we can read.
 */
export type Delivery = 'SUCCESS' | 'RETRY' | 'DROP';

/** mediaJob:<ulid>, the job's id the writer answers on (fn::media::queue_job). */
const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/** One line of the worker's log: ids and short codes only, never personal data or keys. */
export interface LogEntry {
  job?: string;
  kind?: string;
  video?: string;
  event?: string;
  step: string;
  code?: string;
  status?: number | string;
  delivery: Delivery;
}

export interface JobDeps {
  /** Asks Bunny about the video now (bunny.ts checkAnswer). */
  check(videoId: string): Promise<CheckResult>;
  writer: Writer;
  log(entry: LogEntry): void;
}

export async function handleJob(
  message: unknown,
  deps: JobDeps,
): Promise<Delivery> {
  const m =
    message && typeof message === 'object' && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : {};
  const jobId = typeof m['jobId'] === 'string' ? m['jobId'] : '';
  const kind = typeof m['kind'] === 'string' ? m['kind'] : '';
  const ids = {
    ...(JOB_ID.test(jobId) ? { job: jobId } : {}),
    ...(kind === 'check' || kind === 'render' ? { kind } : {}),
    ...(typeof m['videoId'] === 'string' && VIDEO_ID.test(m['videoId'])
      ? { video: m['videoId'] }
      : {}),
    ...(typeof m['eventId'] === 'string' && EVENT_ID.test(m['eventId'])
      ? { event: m['eventId'] }
      : {}),
  };
  const done = (entry: Omit<LogEntry, keyof typeof ids>): Delivery => {
    deps.log({ ...ids, ...entry });
    return entry.delivery;
  };

  // Not a job we can answer on: acknowledged and logged (the table still has any real job, and
  // the 18:00 resend sends it again).
  if (!ids.job || !ids.kind) {
    return done({ step: 'unreadable', delivery: 'DROP' });
  }
  const fail = (code: string) => failed(jobId, code, deps, done);
  // Audio picture videos come with the next pull request.
  if (ids.kind === 'render') return fail('not_supported');
  if (!ids.video) return fail('bad_message');

  const result = await deps.check(ids.video);
  if ('failure' in result) return fail(result.failure);

  const reply = await deps.writer({
    route: 'answer',
    jobId,
    body: result.answer,
  });
  if (isStatus(reply, 200)) {
    const outcome = (reply.body as { outcome?: unknown } | null)?.outcome;
    return done({
      step: 'answered',
      code: `${result.answer.outcome}:${typeof outcome === 'string' ? outcome : '?'}`,
      delivery: 'SUCCESS',
    });
  }
  if (isStatus(reply, 404)) {
    return done({ step: 'answered', status: 404, delivery: 'DROP' });
  }
  // The writer refused the answer itself: counted as a failure, so the job gives up after 5
  // instead of holding up the story's later jobs for good.
  if (isStatus(reply, 400)) return fail('answer_refused');
  return done({ step: 'answered', status: statusOf(reply), delivery: 'RETRY' });
}

/** Tells the writer the job failed; its reply decides: give up (ack) or try again (nack). */
async function failed(
  jobId: string,
  code: string,
  deps: JobDeps,
  done: (entry: LogEntry) => Delivery,
): Promise<Delivery> {
  const reply = await deps.writer({ route: 'failed', jobId, body: { code } });
  if (isStatus(reply, 200)) {
    const retry = (reply.body as { retry?: unknown } | null)?.retry;
    return done({
      step: 'failed',
      code,
      delivery: retry === false ? 'SUCCESS' : 'RETRY',
    });
  }
  if (isStatus(reply, 404)) {
    return done({ step: 'failed', code, status: 404, delivery: 'DROP' });
  }
  return done({
    step: 'failed',
    code,
    status: statusOf(reply),
    delivery: 'RETRY',
  });
}

function isStatus(
  reply: WriterReply,
  status: number,
): reply is { status: number; body: unknown } {
  return typeof reply === 'object' && reply.status === status;
}

const statusOf = (reply: WriterReply) =>
  typeof reply === 'object' ? reply.status : reply;

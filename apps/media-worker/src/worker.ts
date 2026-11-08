import { VIDEO_ID, type CheckResult } from './bunny';
import type { RenderPass, Renderer } from './render';
import type { Writer, WriterReply } from './writer';

/**
 * One job from `media-jobs` (worker.yaml `MediaJob`, as api-user and housekeeping send it), and
 * what Dapr should do with its message once the worker is done (media-worker-final.html section
 * 1; worker.yaml "Media ready"):
 * - SUCCESS: mark it taken (Pub/Sub acks it): the writer saved the answer or ended the job.
 * - RETRY: leave it in the queue (Pub/Sub nacks it and redelivers it later, 10 seconds up to 10
 *   minutes apart): the writer couldn't be reached, or it says "try again later".
 * - DROP: mark it taken without doing anything: the job is gone (404, it went with its file), the
 *   writer refused to count a failure (400), or the message isn't a job we can read.
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

/**
 * The worker's one render at a time (Codex review of PR 201, round 2): each render holds a story's
 * sound and picture and an ffmpeg, and Joel's machine is shared. A render job that finds it taken
 * isn't queued here: it goes back to Pub/Sub (RETRY), which redelivers it 10 seconds to 10
 * minutes later. So no render waits on the machine holding a pass that is getting older, and no
 * waiting render holds one of the delivery slots check jobs need.
 */
export class RenderSlot {
  private taken = false;

  /** The slot and how to give it back, or null if a render is running. */
  take(): (() => void) | null {
    if (this.taken) return null;
    this.taken = true;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.taken = false;
    };
  }
}

export interface JobDeps {
  /** Asks Bunny about the video now (bunny.ts checkAnswer). */
  check(videoId: string): Promise<CheckResult>;
  /** Makes and uploads a picture video (render.ts). */
  renderer: Renderer;
  /** Taken before a render asks for its pass, given back when it ends. */
  renderSlot: RenderSlot;
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

  // Not a job we can answer on (every call to the writer names the job's video, Joel,
  // 2026-11-08): acknowledged and logged (the table still has any real job, and the 18:00 resend
  // sends it again).
  if (!ids.job || !ids.kind || !ids.video) {
    return done({ step: 'unreadable', delivery: 'DROP' });
  }
  const job = { jobId, videoId: ids.video };
  const fail = (code: string) => failed(job, code, deps, done);
  if (ids.kind === 'render') return render(job, deps, done, fail);

  let result: CheckResult;
  try {
    result = await deps.check(ids.video);
  } catch {
    // Our own bug: counted like any other failure, so the job gives up after 5 instead of coming
    // back for good (Joel, 2026-11-08).
    return fail('worker_error');
  }
  if ('failure' in result) return fail(result.failure);

  const reply = await deps.writer({
    route: 'answer',
    jobId,
    body: { videoId: ids.video, ...result.answer },
  });
  if (isStatus(reply, 200)) {
    const body = reply.body as { outcome?: unknown; retry?: unknown } | null;
    // Bunny wouldn't take a video's picture: the writer counted it as the job's failure.
    if (typeof body?.retry === 'boolean') {
      return done({
        step: 'answered',
        code: 'failed',
        delivery: body.retry ? 'RETRY' : 'SUCCESS',
      });
    }
    const outcome = body?.outcome;
    return done({
      step: 'answered',
      code: `${result.answer.outcome}:${typeof outcome === 'string' ? outcome : '?'}`,
      delivery: 'SUCCESS',
    });
  }
  if (isStatus(reply, 404)) {
    return done({ step: 'answered', status: 404, delivery: 'DROP' });
  }
  // The writer refused the answer itself (malformed, or not the job's video): counted as a
  // failure, so the job gives up after 5 instead of looping (Joel, 2026-11-08).
  if (isStatus(reply, 400)) return fail('answer_rejected');
  return done({ step: 'answered', status: statusOf(reply), delivery: 'RETRY' });
}

const BUNNY_TUS = 'https://video.bunnycdn.com/tusupload';
const PICTURE = /^stories\/[A-Za-z0-9_]{1,64}\/[0-9a-f]{32}\.webp$/;
const STORY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The writer's pass, checked: only Bunny's upload address and one video. */
function readPass(body: unknown): RenderPass | null {
  const b = body as Record<string, unknown> | null;
  const upload = b?.['upload'] as Record<string, unknown> | undefined;
  const headers = upload?.['headers'] as Record<string, unknown> | undefined;
  const picture = b?.['picture'];
  const pictureUrl = b?.['pictureUrl'];
  if (
    !b ||
    typeof b['renderVideoId'] !== 'string' ||
    !VIDEO_ID.test(b['renderVideoId']) ||
    typeof b['title'] !== 'string' ||
    !STORY_ID.test(b['title']) ||
    upload?.['uploadUrl'] !== BUNNY_TUS ||
    typeof upload?.['expiresAt'] !== 'string' ||
    !headers ||
    headers['VideoId'] !== b['renderVideoId'] ||
    !Object.values(headers).every((v) => typeof v === 'string') ||
    !(
      picture === null ||
      (typeof picture === 'string' && PICTURE.test(picture))
    ) ||
    !(picture === null
      ? pictureUrl === null
      : typeof pictureUrl === 'string' && pictureUrl.startsWith('https://'))
  ) {
    return null;
  }
  return {
    renderVideoId: b['renderVideoId'],
    title: b['title'],
    upload: {
      uploadUrl: BUNNY_TUS,
      headers: headers as Record<string, string>,
      expiresAt: upload['expiresAt'] as string,
    },
    picture: picture as string | null,
    pictureUrl: pictureUrl as string | null,
  };
}

/**
 * A render job (audio-picture-video.html decisions 1B and 2 = K1): take the render slot, ask the
 * writer for the pass, make and upload the picture video, tell the writer it's done. With the slot
 * taken by another render, the job goes back to the queue before anything is asked (its pass and
 * picture link are fresh when its render starts). The writer may answer that no picture video is
 * needed (the job's outcome): the job is then taken. A step that fails counts as the job's
 * failure, and a retry gets a pass for the same new video (the writer's madeFile).
 */
async function render(
  job: { jobId: string; videoId: string },
  deps: JobDeps,
  done: (entry: LogEntry) => Delivery,
  fail: (code: string) => Promise<Delivery>,
): Promise<Delivery> {
  const giveBack = deps.renderSlot.take();
  if (!giveBack) return done({ step: 'busy', delivery: 'RETRY' });
  try {
    return await renderInSlot(job, deps, done, fail);
  } finally {
    giveBack();
  }
}

async function renderInSlot(
  job: { jobId: string; videoId: string },
  deps: JobDeps,
  done: (entry: LogEntry) => Delivery,
  fail: (code: string) => Promise<Delivery>,
): Promise<Delivery> {
  const passReply = await deps.writer({
    route: 'upload-pass',
    jobId: job.jobId,
    body: { videoId: job.videoId },
  });
  if (isStatus(passReply, 404)) {
    return done({ step: 'pass', status: 404, delivery: 'DROP' });
  }
  if (isStatus(passReply, 400)) return fail('pass_rejected');
  if (!isStatus(passReply, 200)) {
    return done({
      step: 'pass',
      status: statusOf(passReply),
      delivery: 'RETRY',
    });
  }
  const body = passReply.body as { outcome?: unknown; retry?: unknown } | null;
  // Bunny wouldn't make the video: the writer counted it as the job's failure.
  if (typeof body?.retry === 'boolean') {
    return done({
      step: 'pass',
      code: 'failed',
      delivery: body.retry ? 'RETRY' : 'SUCCESS',
    });
  }
  if (body?.outcome !== 'render') {
    return done({
      step: 'pass',
      code: typeof body?.outcome === 'string' ? body.outcome : '?',
      delivery: 'SUCCESS',
    });
  }
  const pass = readPass(passReply.body);
  if (!pass) return fail('pass_malformed');

  let result;
  try {
    result = await deps.renderer.render(job.videoId, pass);
  } catch {
    return fail('worker_error');
  }
  if ('failure' in result) return fail(result.failure);

  const reply = await deps.writer({
    route: 'rendered',
    jobId: job.jobId,
    body: {
      videoId: job.videoId,
      renderVideoId: pass.renderVideoId,
      picture: pass.picture,
      sizeBytes: result.sizeBytes,
    },
  });
  if (isStatus(reply, 200)) {
    const outcome = (reply.body as { outcome?: unknown } | null)?.outcome;
    return done({
      step: 'rendered',
      code: typeof outcome === 'string' ? outcome : '?',
      delivery: 'SUCCESS',
    });
  }
  if (isStatus(reply, 404)) {
    return done({ step: 'rendered', status: 404, delivery: 'DROP' });
  }
  if (isStatus(reply, 400)) return fail('answer_rejected');
  return done({ step: 'rendered', status: statusOf(reply), delivery: 'RETRY' });
}

/**
 * Tells the writer the job failed; its reply decides: give up (ack) or try again (nack). A refusal
 * (400) can't be counted, so the job is marked taken and logged rather than sent round for good.
 */
async function failed(
  job: { jobId: string; videoId: string },
  code: string,
  deps: JobDeps,
  done: (entry: LogEntry) => Delivery,
): Promise<Delivery> {
  const reply = await deps.writer({
    route: 'failed',
    jobId: job.jobId,
    body: { videoId: job.videoId, code },
  });
  if (isStatus(reply, 200)) {
    const retry = (reply.body as { retry?: unknown } | null)?.retry;
    return done({
      step: 'failed',
      code,
      delivery: retry === false ? 'SUCCESS' : 'RETRY',
    });
  }
  if (isStatus(reply, 404) || isStatus(reply, 400)) {
    return done({
      step: 'failed',
      code,
      status: statusOf(reply),
      delivery: 'DROP',
    });
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

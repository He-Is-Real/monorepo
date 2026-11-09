import { createHmac, timingSafeEqual } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { retryOnConflict, runQuery, SURREAL } from '@heisreal/database';
import { NoRoleRequired } from '@heisreal/roles';
import { SecretsService, withTimeout } from '@heisreal/secrets';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { VIDEO_ID } from '../stories/bunny-stream';

/**
 * Bunny Stream's webhook (`POST /v1/webhooks/bunny`, M2 plan item 13, D78; media-worker-final.html):
 * Bunny tells us a video finished encoding, failed or was deleted; we check the message really is
 * Bunny's, for our library, write a check job for its file to the mediaJob table first (a new
 * reason for an open job is added to it, J1), then send the job on `media-jobs` for the media
 * worker, which asks Bunny itself (the notice only says "go and look"), and then record the send
 * (sentAt, sends). The answer comes back through the result writer (apps/workflow).
 *
 * Bunny signs each call (https://bunny.net/docs/stream-webhook): `X-BunnyStream-Signature` is the
 * lowercase hex HMAC-SHA256 of the exact body, keyed with the library's read-only API key, with
 * `X-BunnyStream-Signature-Version: v1` and `X-BunnyStream-Signature-Algorithm: hmac-sha256`. A bad
 * signature answers 401, which Bunny doesn't retry. We answer 200 only once Pub/Sub has the job;
 * if it can't take it, 503, and Bunny tries again (about 30 seconds up to 2 hours apart, for about
 * 4 hours); the job is in the table either way, so the nightly resend sends it too. Redeliveries
 * and duplicates are harmless: each message means "look at Bunny now", and the writer applies an
 * answer only if no newer one is in.
 */
export class BunnyWebhookVerificationError extends Error {
  override name = 'BunnyWebhookVerificationError';
}

export interface BunnySignatureHeaders {
  signature: string | undefined;
  version: string | undefined;
  algorithm: string | undefined;
}

const SIGNATURE = /^[0-9a-f]{64}$/;

/** Throws {@link BunnyWebhookVerificationError} unless `body` is signed with `key` as Bunny signs. */
export function verifyBunnySignature(
  key: string,
  headers: BunnySignatureHeaders,
  body: Buffer,
): void {
  // An empty key would let anyone sign: never accept one (a secret version added empty).
  if (key.length < 16) {
    throw new BunnyWebhookVerificationError('no usable key');
  }
  if (headers.version !== 'v1' || headers.algorithm !== 'hmac-sha256') {
    throw new BunnyWebhookVerificationError('not a v1 hmac-sha256 signature');
  }
  if (!headers.signature || !SIGNATURE.test(headers.signature)) {
    throw new BunnyWebhookVerificationError('missing or malformed signature');
  }
  const expected = createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(body)
    .digest();
  const given = Buffer.from(headers.signature, 'hex');
  if (!timingSafeEqual(given, expected)) {
    throw new BunnyWebhookVerificationError('signature mismatch');
  }
}

/**
 * Bunny's video statuses we act on, as the job's reason (https://bunny.net/docs/stream-webhook):
 * 3 finished, 5 failed and 32 deleted (Joel, 2026-11-07: "bunny_deleted as a reason is ok too",
 * so a video deleted at Bunny by mistake hides its story at once).
 */
const REASONS: ReadonlyMap<unknown, string> = new Map([
  [3, 'bunny_finished'],
  [5, 'bunny_failed'],
  [32, 'bunny_deleted'],
]);
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * A message on `media-jobs` (libs/contracts worker.yaml, `MediaJob`): the job's id (mediaJob:<id>,
 * which the worker answers on), its kind and Bunny video, and Bunny's event id.
 */
export interface MediaJob {
  jobId: string;
  kind: 'check' | 'render';
  videoId: string;
  /** Bunny's event id, the same on every redelivery; for the logs. */
  eventId?: string;
}

/** fn::media::queue_job's answer: the job's id, and its story's (the ordering key). */
interface QueuedJob {
  job: string;
  story: string;
  video: string;
}

/**
 * Puts a job on `media-jobs`; resolves once Pub/Sub has it. `orderingKey`: the story's id, so a
 * story's jobs reach the worker in the order they were queued (the later "publish" jobs share the
 * key; Joel, 2026-11-06, video-bundle-rethink part A). A fake stands in for it in tests.
 */
export interface MediaJobs {
  publish(job: MediaJob, orderingKey: string): Promise<void>;
}
export const MEDIA_JOBS = Symbol('MEDIA_JOBS');

const sendLogger = new Logger('MediaJobs');

/**
 * Sends a story's open jobs that haven't been sent yet. The database writes them itself when a
 * person submits a video or audio story (the check before it can be approved) or changes an
 * audio story's picture (a new picture video): Joel, 2026-11-07, audio-picture-video.html and
 * media-job-table.html J1. Runs on api-user's own login after the person's write; never throws,
 * as a job that couldn't be sent stays in the table for the 18:00 resend.
 */
export async function sendStoryJobs(
  db: Surreal,
  jobs: MediaJobs | null,
  story: string,
): Promise<void> {
  if (!jobs) return;
  try {
    const open = (
      (await runQuery(
        db,
        `SELECT <string> record::id(id) AS job, kind, <string> record::id(file) AS video
           FROM mediaJob
          WHERE doneAt = NONE AND sentAt = NONE
            AND file IN (SELECT VALUE id FROM storyFile WHERE story = type::record('story', $story))
          ORDER BY queuedAt`,
        { story },
      )) as [{ job: string; kind: 'check' | 'render'; video: string }[]]
    )[0];
    for (const j of open) {
      await jobs.publish(
        { jobId: j.job, kind: j.kind, videoId: j.video },
        story,
      );
      await retryOnConflict(() =>
        runQuery(
          db,
          `UPDATE type::record('mediaJob', $job) SET sentAt = time::now(), sends += 1 RETURN NONE`,
          { job: j.job },
        ),
      );
    }
  } catch (err) {
    sendLogger.warn(
      `Couldn't send story ${story}'s media jobs (${err instanceof Error ? err.name : 'error'}); the 18:00 resend sends them`,
    );
  }
}

/** What the webhook needs, or null with it off (it then answers 503 and Bunny retries). */
export interface BunnyWebhookConfig {
  libraryId: number;
  readonlyKey: () => Promise<string>;
}
export const BUNNY_WEBHOOK_CONFIG = Symbol('BUNNY_WEBHOOK_CONFIG');

/** How long the read-only key read from Secret Manager is used before it is read again. */
const SECRET_MAX_AGE_MS = 5 * 60_000;
const PUBLISH_TIMEOUT_MS = 10_000;

@NoRoleRequired(
  'Bunny’s webhooks are signed with the library’s read-only key, not a person’s token',
)
@Controller('v1/webhooks/bunny')
export class BunnyWebhookController {
  private readonly logger = new Logger(BunnyWebhookController.name);

  constructor(
    @Inject(BUNNY_WEBHOOK_CONFIG)
    private readonly config: BunnyWebhookConfig | null,
    @Inject(MEDIA_JOBS) private readonly jobs: MediaJobs | null,
    @Inject(SURREAL) private readonly db: Surreal,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async bunnyWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-bunnystream-signature') signature?: string,
    @Headers('x-bunnystream-signature-version') version?: string,
    @Headers('x-bunnystream-signature-algorithm') algorithm?: string,
  ): Promise<void> {
    if (!this.config || !this.jobs) {
      throw new ServiceUnavailableException('Bunny webhooks are off');
    }
    if (!req.rawBody)
      throw new Error('The raw body is missing (rawBody: true)');
    let key: string;
    try {
      key = (await this.config.readonlyKey()).trim();
      if (key.length < 16) throw new Error('EmptyKey');
    } catch (err) {
      // No version yet, or Secret Manager unreachable: Bunny retries for about 4 hours.
      this.logger.warn(
        `Bunny webhooks are off: the read-only key isn't readable (${err instanceof Error && err.message === 'EmptyKey' ? 'empty' : err instanceof Error ? err.name : 'error'})`,
      );
      throw new ServiceUnavailableException('Bunny webhooks are off');
    }
    try {
      verifyBunnySignature(key, { signature, version, algorithm }, req.rawBody);
    } catch (err) {
      if (!(err instanceof BunnyWebhookVerificationError)) throw err;
      this.logger.warn(`Refused a Bunny webhook: ${err.message}`);
      throw new UnauthorizedException({
        code: 'invalid_signature',
        message: 'The webhook signature was refused',
      });
    }
    const event = req.body as Record<string, unknown> | null;
    // Signed by our library's key, so it is our library's; checked anyway, and anything we don't
    // act on (other statuses, live streams, a body we can't read) is acknowledged and dropped.
    const reason = event ? REASONS.get(event['Status']) : undefined;
    if (
      !event ||
      !reason ||
      event['IsLiveStreamWebhook'] === true ||
      event['VideoLibraryId'] !== this.config.libraryId ||
      typeof event['VideoGuid'] !== 'string' ||
      !VIDEO_ID.test(event['VideoGuid'])
    ) {
      return;
    }
    const videoId = event['VideoGuid'];
    const eventId = event['EventId'];
    try {
      // Written down first (J1), on api-user's own login: the check job for the file this video
      // is (R12: storyFile:<video id>), or the reason added to its open one.
      const queued = await retryOnConflict(
        async () =>
          (
            (await runQuery(
              this.db,
              `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', $reason)`,
              { video: videoId, reason },
            )) as [QueuedJob | undefined]
          )[0],
      );
      if (!queued) {
        // No file row names this video (another upload, or one long gone): nothing to check.
        this.logger.log(`Bunny video ${videoId} is no story's file: dropped`);
        return;
      }
      const job: MediaJob = {
        jobId: queued.job,
        kind: 'check',
        videoId,
        ...(typeof eventId === 'string' && EVENT_ID.test(eventId)
          ? { eventId }
          : {}),
      };
      // In order per story: the story's id is the ordering key.
      await this.jobs.publish(job, queued.story);
      await retryOnConflict(() =>
        runQuery(
          this.db,
          `UPDATE type::record('mediaJob', $job) SET sentAt = time::now(), sends += 1 RETURN NONE`,
          { job: queued.job },
        ),
      );
    } catch (err) {
      this.logger.error(
        `Couldn't queue a media job for video ${videoId} (${err instanceof Error ? err.message : 'error'}); Bunny retries`,
      );
      throw new ServiceUnavailableException('The media queue is unavailable');
    }
  }
}

type Env = Record<string, string | undefined>;
const LIBRARY = /^[0-9]{1,12}$/;
const NAME = /^[A-Za-z0-9_-]{1,255}$/;

/** The webhook's settings from the environment, or null if any is missing (webhook off). */
export function bunnyWebhookConfig(
  secrets: Pick<SecretsService, 'get'>,
  env: Env = process.env,
): BunnyWebhookConfig | null {
  const library = env['BUNNY_STREAM_LIBRARY_ID'];
  const secret = env['BUNNY_STREAM_READONLY_KEY_SECRET'];
  if (!library || !secret) return null;
  if (!LIBRARY.test(library) || !NAME.test(secret)) {
    throw new Error(
      'BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_READONLY_KEY_SECRET are malformed',
    );
  }
  return {
    libraryId: Number(library),
    // Read when a webhook comes, and again once five minutes old, so a key added or rotated at
    // Bunny reaches every instance without a redeploy. Never logged.
    readonlyKey: () =>
      secrets.get(secret, 'latest', { maxAgeMs: SECRET_MAX_AGE_MS }),
  };
}

/** `media-jobs` on Pub/Sub's London endpoint, or null without MEDIA_JOBS_TOPIC (webhook off). */
export function mediaJobsFromEnv(env: Env = process.env): MediaJobs | null {
  const topic = env['MEDIA_JOBS_TOPIC'];
  const project = env['GCP_PROJECT'];
  if (!topic || !project) return null;
  if (!NAME.test(topic)) throw new Error('MEDIA_JOBS_TOPIC is malformed');
  // UK data: the London endpoint, so the message never leaves London (the topic's storage
  // policy enforces it in transit too).
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
        // A failed publish pauses its key in the client; Bunny's retry publishes it again.
        publisher.resumePublishing(orderingKey);
        throw err;
      }
    },
  };
}

@Module({
  controllers: [BunnyWebhookController],
  providers: [
    {
      provide: BUNNY_WEBHOOK_CONFIG,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => bunnyWebhookConfig(secrets),
    },
    { provide: MEDIA_JOBS, useFactory: () => mediaJobsFromEnv() },
  ],
  // The stories routes send the jobs a person's submit or picture change wrote.
  exports: [MEDIA_JOBS],
})
export class BunnyWebhookModule {}

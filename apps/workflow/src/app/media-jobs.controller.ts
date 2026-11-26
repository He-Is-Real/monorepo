import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SURREAL } from '@heisreal/database';
import { currentEvent, note } from '@heisreal/logging/event';
import type { Surreal } from 'surrealdb';
import { BunnyCallFailed, WRITER_BUNNY, type WriterBunny } from './bunny';
import {
  answerFailed,
  answerJob,
  type AnswerOutcome,
  type AnswerResult,
  failJob,
  type FailureReply,
  InvalidMediaJobCall,
  MediaJobNotFound,
  MediaJobWrongVideo,
  parseFailure,
  parseJobId,
  parseMediaAnswer,
  parseVideoId,
} from './media-jobs';
import { MEDIA_QUEUE, type MediaQueue, sendJobs } from './media-queue';
import {
  type PassReply,
  parseRendered,
  parseSoundHeight,
  renderedJob,
  type SoundLinkReply,
  soundLinkFor,
  uploadPassFor,
} from './render';

/**
 * The result writer's routes (media-worker-final.html, sections 1 and 2; J5; audio-picture-video
 * decision 2 = K1 for the render's two): the media worker on Joel's machine calls them directly,
 * for each job it pulled from `media-jobs`. Cloud Run is
 * the gate: only the media-worker Google account holds run.invoker
 * (infra/terraform/modules/gcp/media.tf), so anyone else is refused before this code runs.
 *
 * The worker marks the job taken (acks it) after a 2xx, except when the failed route answers
 * `retry: true`; after anything else (the writer or database unreachable, a 5xx) it doesn't, and
 * the queue redelivers the job later: nothing is lost (docs/runbooks/media.md).
 */
@Controller('v1/media-jobs')
export class MediaJobsController {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(WRITER_BUNNY) private readonly bunny: WriterBunny | null,
    @Inject(MEDIA_QUEUE) private readonly queue: MediaQueue | null,
  ) {}

  /**
   * The answer to a check job: the file's facts and the job's end, in one transaction. A ready
   * video's picture is left alone: api-user set it at Bunny when the story was sent (Joel,
   * 2026-11-17, P1-13 A).
   * Part 1a: a "failed" answer is believed only once Bunny tells the writer the same
   * ({@link answerFailed}); the writer then records the file as unusable at once (RE-1 A: no
   * automatic re-encode). 503 with Bunny off: the worker tries again later.
   */
  @Post(':job/answer')
  @HttpCode(HttpStatus.OK)
  async answer(
    @Param('job') jobParam: string,
    @Body() body: unknown,
  ): Promise<{ outcome: AnswerOutcome | 'gave_up' } | FailureReply> {
    // When the answer reached the writer (F1): taken first, before anything can wait.
    const arrivedAt = new Date().toISOString();
    const [job, video, answer] = this.parse(jobParam, body, parseMediaAnswer);
    // The time stale answers are ordered by (F1), so a late or out-of-order answer is explained.
    jobFields({ arrived_at: arrivedAt });
    const bunny = this.bunny;
    let result: AnswerResult;
    if (answer.outcome === 'failed') {
      if (!bunny) throw new ServiceUnavailableException('Bunny is off');
      const reply = await answerFailed(
        this.db,
        bunny,
        job,
        video,
        arrivedAt,
      ).catch((err: unknown) => this.refuse(err));
      if (!('render' in reply)) {
        // Bunny doesn't say failed (yet), or the writer's call to it failed (counted).
        jobFields({ answer: 'failed', ...failure(reply) });
        return reply;
      }
      result = reply;
    } else {
      result = await answerJob(this.db, job, video, answer, arrivedAt).catch(
        (err: unknown) => this.refuse(err),
      );
    }
    const { outcome, render } = result;
    // Ids and outcomes only: no personal data is in an answer.
    jobFields({
      answer: answer.outcome,
      result: outcome,
      next_job_id: render?.job,
    });
    if (render) await sendJobs(this.db, this.queue, [render]);
    return { outcome };
  }

  /**
   * A render job's pass (K1): whether a picture video is still needed and, if so, a one-hour
   * upload pass for its new Bunny video only and a 10-minute link to the story's picture. 503 with
   * Bunny off; Bunny refusing counts as the job's failure (reply as the failed route's).
   */
  @Post(':job/upload-pass')
  @HttpCode(HttpStatus.OK)
  async uploadPass(
    @Param('job') jobParam: string,
    @Body() body: unknown,
  ): Promise<PassReply | FailureReply> {
    const [job, video] = this.parse(jobParam, body, () => undefined);
    const bunny = this.bunny;
    if (!bunny) throw new ServiceUnavailableException('Bunny is off');
    try {
      const reply = await uploadPassFor(this.db, bunny, job, video);
      // Never the pass or the link themselves: they are keys for an hour.
      jobFields({
        result: reply.outcome,
        ...(reply.outcome === 'render'
          ? {
              render_video_id: reply.renderVideoId,
              has_picture: reply.picture !== null,
            }
          : {}),
      });
      return reply;
    } catch (err) {
      if (!(err instanceof BunnyCallFailed)) return this.refuse(err);
      const reply = await failJob(this.db, job, video, err.code).catch(
        (e: unknown) => this.refuse(e),
      );
      jobFields({ failure_code: err.code, ...failure(reply) });
      return reply;
    }
  }

  /**
   * A render job's link to one MP4 copy of its audio file's sound (R3), asked for when the worker
   * is about to download it: valid 2 minutes, for that one file. 503 with Bunny off; 400 before
   * the job's pass or for a height Bunny doesn't make.
   */
  @Post(':job/sound-link')
  @HttpCode(HttpStatus.OK)
  async soundLink(
    @Param('job') jobParam: string,
    @Body() body: unknown,
  ): Promise<SoundLinkReply | FailureReply> {
    const [job, video, height] = this.parse(jobParam, body, parseSoundHeight);
    const bunny = this.bunny;
    if (!bunny) throw new ServiceUnavailableException('Bunny is off');
    try {
      const reply = await soundLinkFor(this.db, bunny, job, video, height);
      // Never the link itself.
      jobFields({ result: reply.outcome, sound_height: height });
      return reply;
    } catch (err) {
      if (!(err instanceof BunnyCallFailed)) return this.refuse(err);
      const reply = await failJob(this.db, job, video, err.code).catch(
        (e: unknown) => this.refuse(e),
      );
      jobFields({ failure_code: err.code, ...failure(reply) });
      return reply;
    }
  }

  /**
   * A render job is done: the worker uploaded the picture video. The new file's row, the story's
   * move to it (only while it still points at the audio file) and the job's end, in one
   * transaction; then the new video's check is sent.
   */
  @Post(':job/rendered')
  @HttpCode(HttpStatus.OK)
  async rendered(
    @Param('job') jobParam: string,
    @Body() body: unknown,
  ): Promise<{ outcome: AnswerOutcome | 'gave_up' }> {
    const [job, video, done] = this.parse(jobParam, body, parseRendered);
    const { outcome, check } = await renderedJob(
      this.db,
      job,
      video,
      done,
    ).catch((err: unknown) => this.refuse(err));
    jobFields({
      render_video_id: done.renderVideoId,
      output_bytes: done.sizeBytes,
      result: outcome,
      next_job_id: check?.job,
    });
    if (check) await sendJobs(this.db, this.queue, [check]);
    return { outcome };
  }

  /** The worker couldn't do the job: count it, then "try again later" or "give up". */
  @Post(':job/failed')
  @HttpCode(HttpStatus.OK)
  async failed(
    @Param('job') jobParam: string,
    @Body() body: unknown,
  ): Promise<FailureReply> {
    const [job, video, code] = this.parse(jobParam, body, parseFailure);
    const reply = await failJob(this.db, job, video, code).catch(
      (err: unknown) => this.refuse(err),
    );
    jobFields({ failure_code: code, ...failure(reply) });
    return reply;
  }

  private parse<T>(
    jobParam: string,
    body: unknown,
    parseBody: (body: unknown) => T,
  ): [string, string, T] {
    try {
      const job = parseJobId(jobParam);
      jobFields({ id: job });
      const video = parseVideoId(body);
      jobFields({ video_id: video });
      return [job, video, parseBody(body)];
    } catch (err) {
      if (!(err instanceof InvalidMediaJobCall)) throw err;
      // Our own words (media-jobs.ts), never what the worker sent.
      jobFields({ refused: err.message });
      throw new BadRequestException({ code: 'validation_failed' });
    }
  }

  /**
   * 404 for a job that doesn't exist (gone with its file: the worker drops it), 400 for a call
   * that doesn't fit the job: `video_mismatch` when it names another video than the job's
   * (Joel, 2026-11-08, B), `validation_failed` otherwise. A database error is a 500: the worker leaves the job in the queue.
   */
  private refuse(err: unknown): never {
    if (err instanceof MediaJobNotFound) {
      throw new NotFoundException({ code: 'not_found' });
    }
    if (err instanceof MediaJobWrongVideo) {
      jobFields({ refused: 'not the job’s video' });
      throw new BadRequestException({ code: 'video_mismatch' });
    }
    if (err instanceof InvalidMediaJobCall) {
      jobFields({ refused: err.message });
      throw new BadRequestException({ code: 'validation_failed' });
    }
    throw err;
  }
}

/**
 * Facts about the job on this call's event (`event: "job"`, wideEvents in main.ts; the writer's
 * own lines folded in, LG-2 C): ids, outcomes and codes only, never a pass, a link or a key.
 * If the worker hung up while the database was still busy, the event is already written: the
 * facts then go on their own line with the same `ref` and the job's ids, so the failure code,
 * the retry decision and the result are never lost.
 */
function jobFields(fields: Record<string, unknown>): void {
  const event = currentEvent();
  if (!event) return;
  note(
    {
      job: {
        name: 'media',
        id: event.get('job.id'),
        video_id: event.get('job.video_id'),
        ...fields,
      },
    },
    {
      severity: 'INFO',
      message: 'Media job call finished after the worker hung up',
    },
  );
}

/** A counted failure's answer: try again or give up, and how the job ended. */
const failure = (reply: FailureReply) => ({
  retry: reply.retry,
  result: reply.outcome,
});

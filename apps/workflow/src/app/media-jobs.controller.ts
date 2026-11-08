import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { SURREAL } from '@heisreal/database';
import type { Surreal } from 'surrealdb';
import {
  answerJob,
  type AnswerOutcome,
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

/**
 * The result writer's two routes (media-worker-final.html, sections 1 and 2; J5): the media worker
 * on Joel's machine calls them directly, once per job it pulled from `media-jobs`. Cloud Run is
 * the gate: only the media-worker Google account holds run.invoker
 * (infra/terraform/modules/gcp/media.tf), so anyone else is refused before this code runs.
 *
 * The worker marks the job taken (acks it) after a 2xx, except when the failed route answers
 * `retry: true`; after anything else (the writer or database unreachable, a 5xx) it doesn't, and
 * the queue redelivers the job later: nothing is lost (docs/media-runbook.md).
 */
@Controller('v1/media-jobs')
export class MediaJobsController {
  private readonly logger = new Logger(MediaJobsController.name);

  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  /** The answer to a check job: the file's facts and the job's end, in one transaction. */
  @Post(':job/answer')
  @HttpCode(HttpStatus.OK)
  async answer(
    @Param('job') jobParam: string,
    @Body() body: unknown,
  ): Promise<{ outcome: AnswerOutcome }> {
    // When the answer reached the writer (F1): taken first, before anything can wait.
    const arrivedAt = new Date().toISOString();
    const [job, video, answer] = this.parse(jobParam, body, parseMediaAnswer);
    const outcome = await answerJob(
      this.db,
      job,
      video,
      answer,
      arrivedAt,
    ).catch((err: unknown) => this.refuse(job, err));
    // Ids and outcomes only: no personal data is in an answer.
    this.logger.log(
      JSON.stringify({ job, answer: answer.outcome, arrivedAt, outcome }),
    );
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
      (err: unknown) => this.refuse(job, err),
    );
    this.logger.warn(JSON.stringify({ job, failed: code, ...reply }));
    return reply;
  }

  private parse<T>(
    jobParam: string,
    body: unknown,
    parseBody: (body: unknown) => T,
  ): [string, string, T] {
    try {
      return [parseJobId(jobParam), parseVideoId(body), parseBody(body)];
    } catch (err) {
      if (!(err instanceof InvalidMediaJobCall)) throw err;
      this.logger.warn(`Refused a media worker call: ${err.message}`);
      throw new BadRequestException({ code: 'validation_failed' });
    }
  }

  /**
   * 404 for a job that doesn't exist (gone with its file: the worker drops it), 400 for a call
   * that doesn't fit the job: `video_mismatch` when it names another video than the job's
   * (Joel, 2026-11-08, B), `validation_failed` otherwise. A database error is a 500: the worker leaves the job in the queue.
   */
  private refuse(job: string, err: unknown): never {
    if (err instanceof MediaJobNotFound) {
      this.logger.warn(`No media job ${job}`);
      throw new NotFoundException({ code: 'not_found' });
    }
    if (err instanceof MediaJobWrongVideo) {
      this.logger.warn(`Refused a media worker call for ${job}: not its video`);
      throw new BadRequestException({ code: 'video_mismatch' });
    }
    if (err instanceof InvalidMediaJobCall) {
      this.logger.warn(
        `Refused a media worker call for ${job}: ${err.message}`,
      );
      throw new BadRequestException({ code: 'validation_failed' });
    }
    throw err;
  }
}

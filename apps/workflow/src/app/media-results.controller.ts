import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { SURREAL } from '@heisreal/database';
import type { Surreal } from 'surrealdb';
import {
  applyMediaResult,
  InvalidMediaResult,
  parseMediaResult,
} from './media-results';

/** Pub/Sub's publishTime: RFC 3339 in UTC, up to nanoseconds. */
const PUBLISH_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;

/** Pub/Sub's push body (https://cloud.google.com/pubsub/docs/push). */
interface PushEnvelope {
  message?: { data?: unknown; messageId?: unknown; publishTime?: unknown };
  subscription?: unknown;
}

/**
 * The result writer's one route (M2 plan item 13, D78): Pub/Sub pushes each answer on
 * `media-results` here (subscription `media-results-writer`, in order per story). Cloud Run is
 * the gate: internal traffic only, and only Pub/Sub's push identity holds run.invoker
 * (infra/terraform/modules/gcp/media.tf). Any 2xx acknowledges the message; anything else makes
 * Pub/Sub try again (10 seconds up to 10 minutes) and, after 5 tries, moves it to
 * `media-dead-letters` (docs/media-runbook.md). So a malformed answer is refused (400) and ends
 * there, and a database that's down or busy (503) is simply retried.
 */
@Controller('v1/media-results')
export class MediaResultsController {
  private readonly logger = new Logger(MediaResultsController.name);

  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async push(@Body() envelope: PushEnvelope): Promise<void> {
    const data = envelope?.message?.data;
    // When Google's queue took the answer (Google's clock, not the worker's): an answer no newer
    // than the last one applied is dropped (Joel, 2026-11-07, F1).
    const publishTime = envelope?.message?.publishTime;
    let result;
    try {
      if (typeof data !== 'string') throw new InvalidMediaResult('no data');
      if (typeof publishTime !== 'string' || !PUBLISH_TIME.test(publishTime)) {
        throw new InvalidMediaResult('no publishTime');
      }
      result = parseMediaResult(
        JSON.parse(Buffer.from(data, 'base64').toString('utf8')),
      );
    } catch (err) {
      const reason =
        err instanceof InvalidMediaResult ? err.message : 'not JSON';
      this.logger.warn(
        `Refused a media result (message ${String(envelope?.message?.messageId)}): ${reason}`,
      );
      throw new BadRequestException({ code: 'validation_failed' });
    }
    // A database error (down, or a conflict with a moderator's step on the same story) is a
    // 500: Pub/Sub tries again, and the retry reads the row afresh.
    const outcome = await applyMediaResult(
      this.db,
      result,
      publishTime as string,
    );
    // Ids and outcomes only: no personal data is in an answer.
    this.logger.log(
      JSON.stringify({
        videoId: result.videoId,
        eventId: result.eventId,
        answer: result.outcome,
        publishTime,
        outcome: outcome === 'stale' ? 'ignored: stale' : outcome,
      }),
    );
  }
}

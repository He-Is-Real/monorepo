import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { DatabaseAvailability } from '@heisreal/database';
import type { Request, Response } from 'express';
import { catchError, map, type Observable, of, throwError } from 'rxjs';
import {
  ifNoneMatchHits,
  PUBLIC_MAX_AGE_SECONDS,
  publicCacheControl,
} from './caching';

const ANSWER_LIFETIME_MS = PUBLIC_MAX_AGE_SECONDS * 1000;

/**
 * How long an answer is kept for when the database is restarting (SurrealDB on Spot; Joel,
 * 2026-11-07, "cache B"): past its minute it's never served normally, only instead of a
 * `503 service_restarting`.
 */
export const FALLBACK_LIFETIME_MS = 30 * 60 * 1000;

/**
 * How many answers one running copy keeps. The largest is a 50-card page or a legal text, tens
 * of kilobytes; most are a few. 500 of them stay well under 100 MB of the 512 MiB the service
 * has (infra/terraform/modules/gcp/cloudrun.tf), and hold every page people ask for often.
 */
export const ANSWER_CAPACITY = 500;

interface Answer {
  body: unknown;
  etag: string;
  storedAt: number;
}

/**
 * Recent public answers, in memory, per running copy (R13): served for a minute, and kept for
 * 30 minutes as the fallback while the database restarts. No timers: an answer's age is
 * checked only when a request asks for it, so an idle copy costs nothing and its cache dies
 * with it (Cloud Run bills per request and scales to zero). A `Map` keeps insertion order, so
 * moving an answer to the end on use makes the first one the least recently used.
 */
export class PublicAnswerCache {
  private readonly answers = new Map<string, Answer>();

  constructor(
    readonly now: () => number = Date.now,
    private readonly capacity = ANSWER_CAPACITY,
  ) {}

  /** The answer for `key` while it is younger than a minute. */
  get(key: string): Answer | undefined {
    const answer = this.kept(key);
    if (!answer || this.now() - answer.storedAt >= ANSWER_LIFETIME_MS)
      return undefined;
    this.answers.delete(key);
    this.answers.set(key, answer);
    return answer;
  }

  /** The answer for `key` while it is younger than 30 minutes: only when the database is away. */
  fallback(key: string): Answer | undefined {
    return this.kept(key);
  }

  /** The kept answer for `key`, dropping it once it's 30 minutes old. */
  private kept(key: string): Answer | undefined {
    const answer = this.answers.get(key);
    if (answer && this.now() - answer.storedAt >= FALLBACK_LIFETIME_MS) {
      this.answers.delete(key);
      return undefined;
    }
    return answer;
  }

  /**
   * Keeps the answer a read that started at `storedAt` gave, and returns it. Its minute counts
   * from that start, not from when the read finished, so a slow read can't stretch it. An answer
   * whose minute is already over, or that started before the one kept for `key` (overlapping
   * reads finishing out of order), is returned but not kept.
   */
  set(key: string, body: unknown, etag: string, storedAt: number): Answer {
    const answer = { body, etag, storedAt };
    const kept = this.answers.get(key);
    if (this.secondsLeft(answer) === 0 || (kept && kept.storedAt > storedAt))
      return answer;
    this.answers.delete(key);
    this.answers.set(key, answer);
    while (this.answers.size > this.capacity) {
      this.answers.delete(this.answers.keys().next().value as string);
    }
    return answer;
  }

  /** Whole seconds the answer may still be kept, so the total never passes a minute. */
  secondsLeft(answer: Answer): number {
    const ms = answer.storedAt + ANSWER_LIFETIME_MS - this.now();
    return Math.max(0, Math.floor(ms / 1000));
  }
}

/**
 * The request as the answer depends on it: the path, and the query exactly as the handlers read
 * it (`req.query`, Express's parser), with the parameter names in a fixed order (a repeated
 * parameter keeps its own order). Not a re-parse of the URL: a URL that Express reads one way and
 * another parser reads another (e.g. past Express's 1,000-parameter limit) would otherwise store
 * one request's answer under another's key. Nothing else in a request changes a public answer:
 * this service reads no cookies, no auth and no Accept-Language.
 */
export function answerKey(req: Request): string {
  const query = Object.entries(req.query as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `${req.path}?${JSON.stringify(query)}`;
}

/**
 * R13: answers a GET from memory when it was answered in the last minute, otherwise asks the
 * handler. If the handler can't reach the database (it's restarting), the newest copy kept in the
 * last 30 minutes is served instead, with `Cache-Control: no-store` so no browser or CDN keeps
 * it; with no copy, the error stands (`503 service_restarting`). Only `200` answers whose handler set an `ETag` (`withETag`: every public query) are
 * kept; errors, redirects and `/health` always reach the handler. This interceptor owns
 * `If-None-Match` (`304`) and `Cache-Control` for those answers, so both are right whether the
 * answer came from memory or not: with shared caching on, browsers and CDNs may keep it only for
 * the time it has left here, never longer, and a `304` says the same.
 */
@Injectable()
export class PublicCacheInterceptor implements NestInterceptor {
  constructor(
    @Inject(PublicAnswerCache) private readonly cache: PublicAnswerCache,
    private readonly database: DatabaseAvailability,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next.handle();
    const key = answerKey(req);
    const hit = this.cache.get(key);
    if (hit) return of(this.send(req, res, hit));
    const startedAt = this.cache.now();
    return next.handle().pipe(
      map((body) => {
        const etag = res.getHeader('ETag');
        if (
          res.statusCode !== HttpStatus.OK ||
          typeof etag !== 'string' ||
          body === undefined
        )
          return body;
        return this.send(req, res, this.cache.set(key, body, etag, startedAt));
      }),
      catchError((err: unknown) => {
        const copy = this.database.noticeFailure(err)
          ? this.cache.fallback(key)
          : undefined;
        if (!copy) return throwError(() => err);
        res
          .status(HttpStatus.OK)
          .setHeader('ETag', copy.etag)
          .setHeader('Cache-Control', 'no-store');
        return of(copy.body);
      }),
    );
  }

  private send(req: Request, res: Response, answer: Answer): unknown {
    res
      .setHeader('ETag', answer.etag)
      .setHeader(
        'Cache-Control',
        publicCacheControl(this.cache.secondsLeft(answer)),
      );
    if (ifNoneMatchHits(req.headers['if-none-match'], answer.etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return answer.body;
  }
}

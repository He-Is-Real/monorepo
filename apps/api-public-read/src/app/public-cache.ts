import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable, of } from 'rxjs';
import {
  ifNoneMatchHits,
  PUBLIC_MAX_AGE_SECONDS,
  publicCacheControl,
} from './caching';

const ANSWER_LIFETIME_MS = PUBLIC_MAX_AGE_SECONDS * 1000;

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
 * Recent public answers, in memory, per running copy (R13). No timers: an answer's age is
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
    const answer = this.answers.get(key);
    if (!answer) return undefined;
    this.answers.delete(key);
    if (this.now() - answer.storedAt >= ANSWER_LIFETIME_MS) return undefined;
    this.answers.set(key, answer);
    return answer;
  }

  set(key: string, body: unknown, etag: string): Answer {
    const answer = { body, etag, storedAt: this.now() };
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
 * The request as the answer depends on it: the path, and the query with its parameters in a
 * fixed order (a repeated parameter keeps its own order). Nothing else in a request changes a
 * public answer: this service reads no cookies, no auth and no Accept-Language.
 */
export function answerKey(req: Request): string {
  const url = req.originalUrl;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const query = new URLSearchParams(url.slice(q + 1));
  query.sort();
  return `${url.slice(0, q)}?${query}`;
}

/**
 * R13: answers a GET from memory when it was answered in the last minute, otherwise asks the
 * handler. Only `200` answers whose handler set an `ETag` (`withETag`: every public query) are
 * kept; errors, redirects and `/health` always reach the handler. This interceptor owns
 * `If-None-Match` (`304`) and `Cache-Control` for those answers, so both are right whether the
 * answer came from memory or not: with shared caching on, browsers and CDNs may keep it only for
 * the time it has left here, never longer, and a `304` says the same.
 */
@Injectable()
export class PublicCacheInterceptor implements NestInterceptor {
  constructor(
    @Inject(PublicAnswerCache) private readonly cache: PublicAnswerCache,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next.handle();
    const key = answerKey(req);
    const hit = this.cache.get(key);
    if (hit) return of(this.send(req, res, hit));
    return next.handle().pipe(
      map((body) => {
        const etag = res.getHeader('ETag');
        if (
          res.statusCode !== HttpStatus.OK ||
          typeof etag !== 'string' ||
          body === undefined
        )
          return body;
        return this.send(req, res, this.cache.set(key, body, etag));
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

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
  Optional,
  RequestMethod,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { writeLog } from '@heisreal/logging';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  type ClientRateLimitInfo,
  rateLimit,
  type Options,
  type Store,
} from 'express-rate-limit';
import { sendServerError } from '../server-error';
import { RATE_LIMITS, type RateLimitGroup } from './limits';
import {
  callerKey,
  rateLimitsActive,
  SlidingWindowCounter,
} from './sliding-window';

/** The clock the counters read (tests give their own, so nothing waits on real time). */
export const RATE_LIMIT_CLOCK = Symbol('RATE_LIMIT_CLOCK');

/**
 * Whether limits are on: by default where Cloud Run runs the service ({@link rateLimitsActive}).
 * Only the rate-limit tests provide `true`; nothing a caller sends can change it.
 */
export const RATE_LIMITS_ACTIVE = Symbol('RATE_LIMITS_ACTIVE');

/**
 * The website key (RL-8 A): a function giving the key web's server sends to api-public-read, or
 * undefined when there is none (then every caller is counted per address). Only api-public-read
 * provides it (`websiteKeyFromSecret`).
 */
export const WEBSITE_KEY = Symbol('WEBSITE_KEY');
export type WebsiteKey = () => Promise<string | undefined>;

/** The header web's server sends the website key in, to api-public-read only. */
export const WEBSITE_KEY_HEADER = 'x-website-key';

/**
 * express-rate-limit's `store`, counting in a {@link SlidingWindowCounter} (its own MemoryStore
 * counts fixed windows). One per limiter, as the library requires.
 */
export class SlidingWindowStore implements Store {
  readonly localKeys = true;
  private readonly counter: SlidingWindowCounter;

  constructor(windowMs: number, now: () => number) {
    this.counter = new SlidingWindowCounter({ windowMs, now });
  }

  increment(key: string): ClientRateLimitInfo {
    // The library takes whole hits; the weighted count is rounded up, never down.
    const totalHits = Math.ceil(this.counter.hit(key));
    return { totalHits, resetTime: new Date(this.counter.windowEnd(key)) };
  }

  get(key: string): ClientRateLimitInfo {
    return {
      totalHits: Math.ceil(this.counter.peek(key)),
      resetTime: new Date(this.counter.windowEnd(key)),
    };
  }

  decrement(key: string): void {
    this.counter.undo(key);
  }

  resetKey(key: string): void {
    this.counter.reset(key);
  }

  resetAll(): void {
    this.counter.clear();
  }
}

/** HTTP methods that read: they take a controller's `read` group. */
const READS = new Set(['GET', 'HEAD']);

/** Which group a controller's requests count in: by method, reads and the rest. */
export interface MethodGroups {
  read?: RateLimitGroup;
  write?: RateLimitGroup;
  /** DELETE, when it has its own group (deletion: a busy account can still delete). */
  delete?: RateLimitGroup;
}

/**
 * The rate limiters (RL-7 B, RL-9 A; Joel 2026-11-21): express-rate-limit, set up once here for
 * the three APIs. Each API's module attaches groups to its controllers with Nest's own
 * middleware wiring (`consumer.apply(rateLimits.byMethod({ … })).forRoutes(SomeController)`).
 *
 * A limited caller gets exactly our generic server error (`sendServerError`: the same status,
 * headers and body as any unexpected failure), with no 429, no rate-limit or Retry-After
 * header and no wording of its own (RL-5, Joel 2026-11-21: "we dont want people experimenting
 * with breaking or bypassing the rate limiter and being shown their progress"). Only our logs
 * say it was a limit: one line when a caller first goes over, naming the group, never the
 * address or the path (a path can hold an email address).
 */
@Injectable()
export class RateLimits implements OnModuleInit {
  private readonly limiters = new Map<RateLimitGroup, RequestHandler>();
  private readonly now: () => number;
  private readonly active: boolean;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Optional() @Inject(RATE_LIMIT_CLOCK) now?: () => number,
    @Optional() @Inject(WEBSITE_KEY) private readonly websiteKey?: WebsiteKey,
    @Optional() @Inject(RATE_LIMITS_ACTIVE) active?: boolean,
  ) {
    this.now = now ?? Date.now;
    this.active = active ?? rateLimitsActive();
  }

  /**
   * The caller's address comes from Google's front end, the one proxy in front of Cloud Run: it
   * appends the address it saw to `X-Forwarded-For`, so Express trusts exactly one hop
   * (`req.ip` = the header's last entry; anything before it is whatever the caller sent).
   * Without it every request would look like Google's, and everyone would share one count.
   */
  onModuleInit(): void {
    const app = this.adapterHost.httpAdapter?.getInstance() as
      { set?: (name: string, value: unknown) => void } | undefined;
    app?.set?.('trust proxy', 1);
  }

  /** The limiter for one group, created once (each with its own counters). */
  for(group: RateLimitGroup): RequestHandler {
    let limiter = this.limiters.get(group);
    if (!limiter) {
      limiter = this.create(group);
      this.limiters.set(group, limiter);
    }
    return limiter;
  }

  /** One middleware for a controller whose reads and writes count in different groups. */
  byMethod(groups: MethodGroups): RequestHandler {
    const pick = (method: string): RateLimitGroup | undefined =>
      READS.has(method)
        ? groups.read
        : method === 'DELETE' && groups.delete
          ? groups.delete
          : groups.write;
    // Created now, at start-up, not on the first request.
    for (const group of [groups.read, groups.write, groups.delete]) {
      if (group) this.for(group);
    }
    return (req: Request, res: Response, next: NextFunction) => {
      const group = pick(req.method);
      if (!group) return next();
      return this.for(group)(req, res, next);
    };
  }

  /**
   * api-public-read's reads (RL-8 A): web's own server, carrying the website key, shares the
   * `website` allowance; everyone else is counted per address in `publicReads`. A missing or
   * wrong key is simply an ordinary caller.
   */
  publicReads(): RequestHandler {
    const website = this.for('website');
    const others = this.for('publicReads');
    return (req: Request, res: Response, next: NextFunction) => {
      this.isWebsite(req)
        .catch(() => false)
        .then((yes) => (yes ? website : others)(req, res, next));
    };
  }

  private async isWebsite(req: Request): Promise<boolean> {
    const sent = req.headers[WEBSITE_KEY_HEADER];
    if (typeof sent !== 'string' || !sent || !this.websiteKey) return false;
    const key = await this.websiteKey();
    return !!key && sameKey(sent, key);
  }

  private create(group: RateLimitGroup): RequestHandler {
    if (!this.active) return (_req, _res, next) => next();
    const { limit, windowMs } = RATE_LIMITS[group];
    const options: Partial<Options> = {
      windowMs,
      limit,
      store: new SlidingWindowStore(windowMs, this.now),
      // Nothing that reveals the limit (RL-5).
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: (req) =>
        group === 'website' ? 'website' : callerKey(req.ip ?? 'unknown'),
      handler: (req, res) => {
        const info = (req as Request & { rateLimit?: { used: number } })
          .rateLimit;
        // One line per caller as they first go over, not one per refused request.
        if (info?.used === limit + 1) {
          writeLog('WARNING', 'Rate limit reached', {
            event: 'rate_limited',
            group,
          });
        }
        sendServerError(res);
      },
    };
    return rateLimit(options);
  }
}

/** Constant-time comparison of two keys of any length (their SHA-256 digests). */
function sameKey(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Rate limiting for an API: import `RateLimitModule.forRoot()` once in the app module; then
 * attach groups in the app module's `configure` (see {@link RateLimits}). api-public-read gives
 * `websiteKey`, how to read the website key (RL-8 A).
 */
@Global()
@Module({})
export class RateLimitModule {
  static forRoot({
    websiteKey,
  }: {
    websiteKey?: {
      inject?: FactoryProvider['inject'];
      useFactory: (...deps: never[]) => WebsiteKey;
    };
  } = {}): DynamicModule {
    return {
      module: RateLimitModule,
      providers: [
        RateLimits,
        // Defaults the rate-limit tests replace (overrideProvider): limits on where Cloud Run
        // runs the service, the real clock, and no website key.
        { provide: RATE_LIMITS_ACTIVE, useFactory: () => rateLimitsActive() },
        { provide: RATE_LIMIT_CLOCK, useValue: () => Date.now() },
        websiteKey
          ? {
              provide: WEBSITE_KEY,
              inject: websiteKey.inject ?? [],
              useFactory: websiteKey.useFactory,
            }
          : { provide: WEBSITE_KEY, useValue: async () => undefined },
      ],
      exports: [RateLimits],
    };
  }
}

/** For `forRoutes`: one route of a controller, when it needs a group of its own on top. */
export const route = (
  path: string,
  method: RequestMethod,
): { path: string; method: RequestMethod } => ({ path, method });

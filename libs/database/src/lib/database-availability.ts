import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, race } from 'rxjs';
import {
  CallTerminatedError,
  ConnectionUnavailableError,
  ReconnectExhaustionError,
  ReconnectIterationError,
  type Surreal,
  UnexpectedConnectionError,
} from 'surrealdb';
import { SURREAL } from './database.constants';

// SurrealDB runs on Spot capacity (Joel, 2026-11-07): Google may take its machine back, and the
// database is away for a few minutes while it restarts elsewhere. Every service notices, answers
// `503 service_restarting` with an estimate of when to try again, and logs when the outage began
// and ended (docs/how-the-app-works.md, "Database restarts").

/** The database can't be reached: it's restarting, not refusing a query. */
export class DatabaseUnavailableError extends Error {
  constructor(message = 'The database is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
  }
}

/** Socket and DNS failures Node reports while a server is away. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** connectDatabase's own timeout (`withTimeout(…, 'Connecting to <url>')`). */
const CONNECT_TIMEOUT = /^Connecting to \S+ timed out after \d+ms$/;

/**
 * Whether an error means "can't reach the database" (connection refused or reset, DNS failure,
 * connect timeout, socket closed mid-request), as opposed to a query the database refused or
 * failed (`DatabaseQueryError`, the SDK's `ServerError`s), which stay ordinary errors.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if (
      e instanceof DatabaseUnavailableError ||
      e instanceof ConnectionUnavailableError ||
      e instanceof CallTerminatedError ||
      e instanceof ReconnectExhaustionError ||
      e instanceof ReconnectIterationError ||
      e instanceof UnexpectedConnectionError
    ) {
      return true;
    }
    if (typeof e !== 'object') return false;
    const { code, message, cause } = e as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    if (typeof message === 'string' && CONNECT_TIMEOUT.test(message))
      return true;
    e = cause;
  }
  return false;
}

/** How long a database restart usually takes, unless `DATABASE_RESTART_ESTIMATE_SECONDS` says. */
export const DEFAULT_RESTART_ESTIMATE_SECONDS = 120;
/** The shortest wait we ever suggest: past the estimate, "about 1 minute" until it's back. */
export const MIN_RETRY_AFTER_SECONDS = 60;

export function restartEstimateSecondsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['DATABASE_RESTART_ESTIMATE_SECONDS'];
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_RESTART_ESTIMATE_SECONDS;
}

/** max(60, estimate − seconds since the restart began), in whole seconds. */
export function retryAfterSeconds(
  restartingSince: Date,
  now: Date,
  estimateSeconds = DEFAULT_RESTART_ESTIMATE_SECONDS,
): number {
  const elapsed = Math.max(
    0,
    (now.getTime() - restartingSince.getTime()) / 1000,
  );
  return Math.max(
    MIN_RETRY_AFTER_SECONDS,
    Math.ceil(estimateSeconds - elapsed),
  );
}

/** The `503 service_restarting` problem's extra fields (components.yaml, `ServiceRestarting`). */
export interface ServiceRestarting {
  restartingSince: string;
  retryAfterSeconds: number;
}

/**
 * This running copy's view of the database: when it first saw it unavailable, cleared when it's
 * reachable again. Fed by the SDK's connection events and by errors {@link isDatabaseUnavailable}
 * recognises. Logs one structured line when an outage starts and one when it ends.
 */
@Injectable()
export class DatabaseAvailability implements OnModuleInit, OnModuleDestroy {
  private since: Date | undefined;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void)[] = [];
  readonly estimateSeconds = restartEstimateSecondsFromEnv();

  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  onModuleInit(): void {
    this.unsubscribe = [
      this.db.subscribe('reconnecting', () => this.markUnavailable()),
      this.db.subscribe('disconnected', () => this.markUnavailable()),
      this.db.subscribe('connected', () => this.markAvailable()),
    ];
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  /** When this copy first saw the database unavailable, or undefined while it's reachable. */
  restartingSince(): Date | undefined {
    // A failed call can arrive just before the SDK reconnects; once it's connected, it's back.
    if (this.since && this.db.status === 'connected') this.markAvailable();
    return this.since;
  }

  /** The problem fields for an outage that began at `since` (now, if not yet recorded). */
  restarting(now = new Date()): ServiceRestarting {
    const since = this.since ?? now;
    return {
      restartingSince: since.toISOString(),
      retryAfterSeconds: retryAfterSeconds(since, now, this.estimateSeconds),
    };
  }

  /**
   * Whether `err` means this service can't reach the database right now, and if so records the
   * outage. A socket error while the client is connected came from somewhere else (Bunny, Clerk,
   * Secret Manager), so it stays an ordinary error.
   */
  noticeFailure(err: unknown): boolean {
    if (!isDatabaseUnavailable(err)) return false;
    if (
      !(err instanceof DatabaseUnavailableError) &&
      this.db.status === 'connected'
    )
      return false;
    this.markUnavailable();
    return true;
  }

  markUnavailable(now = new Date()): void {
    if (this.since) return;
    this.since = now;
    log('WARNING', 'The database became unavailable', {
      event: 'database_unavailable',
      since: now.toISOString(),
    });
    for (const listener of this.listeners) listener();
  }

  markAvailable(now = new Date()): void {
    if (!this.since) return;
    const seconds = Math.round((now.getTime() - this.since.getTime()) / 1000);
    log('NOTICE', `The database is available again after ${seconds} s`, {
      event: 'database_available',
      since: this.since.toISOString(),
      unavailableSeconds: seconds,
    });
    this.since = undefined;
  }

  /** Calls `listener` whenever an outage starts; returns the unsubscribe. */
  onUnavailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** One Cloud Logging structured line (a JSON object on stdout); never personal data. */
function log(
  severity: 'WARNING' | 'NOTICE',
  message: string,
  fields: Record<string, unknown>,
): void {
  process.stdout.write(`${JSON.stringify({ severity, message, ...fields })}\n`);
}

const AVAILABLE_WITHOUT_DATABASE = 'heisreal:availableWithoutDatabase';

/** A route that answers on its own while the database is away (the health probe reports it). */
export const AvailableWithoutDatabase = () =>
  SetMetadata(AVAILABLE_WITHOUT_DATABASE, true);

/**
 * While the database is away a query waits until it's back (the SDK holds it through the
 * reconnect), so a request would hang for minutes. This answers at once instead: a request that
 * arrives during an outage, or is still waiting when one starts, fails with
 * {@link DatabaseUnavailableError} (ProblemFilter's `503 service_restarting`). A write already
 * sent may still be applied once the database is back; clients retry with the same
 * `Idempotency-Key` or `If-Match`, as for any answer that never arrived.
 */
@Injectable()
export class DatabaseAvailabilityInterceptor implements NestInterceptor {
  constructor(
    private readonly availability: DatabaseAvailability,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      this.reflector.getAllAndOverride<boolean>(AVAILABLE_WITHOUT_DATABASE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }
    if (this.availability.restartingSince()) {
      throw new DatabaseUnavailableError();
    }
    const outage = new Observable<never>((subscriber) =>
      this.availability.onUnavailable(() =>
        subscriber.error(new DatabaseUnavailableError()),
      ),
    );
    return race(next.handle(), outage);
  }
}

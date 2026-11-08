import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SecretsService, withTimeout } from '@heisreal/secrets';
import { type ProvidedAuth, ServerError, Surreal } from 'surrealdb';
import { DatabaseAvailability } from './database-availability';
import { DatabaseHealthService } from './database-health.service';
import { DatabaseConfig, databaseConfigFromEnv } from './database.config';
import { SURREAL } from './database.constants';

/** {@link connectDatabase} (jobs) fails with a clear error instead of hanging while the SDK retries an unreachable database. */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Keep reconnecting for as long as the database is away (the SDK's default gives up after 5
 * tries, about a minute, and the copy would never reach the database again). SurrealDB runs on
 * Spot and a restart takes a few minutes; retries back off to one every 5 seconds.
 */
export const RECONNECT = {
  attempts: -1,
  retryDelay: 1000,
  retryDelayMax: 5000,
  retryDelayMultiplier: 1.5,
  retryDelayJitter: 0.1,
} as const;

/**
 * Record-access sign-in as `service:<username>` (D13 B). surrealdb.js 2.0.8 types
 * `authentication` for system users and tokens only, but signs in with any credentials.
 */
export async function serviceSignIn(
  config: DatabaseConfig,
  secrets: SecretsService,
): Promise<ProvidedAuth> {
  return {
    namespace: config.namespace,
    database: config.database,
    access: 'svc',
    variables: {
      name: config.username,
      secret: await secrets.get(config.passwordSecret),
    },
  } as unknown as ProvidedAuth;
}

export async function connectDatabase(
  db: Surreal,
  config: DatabaseConfig,
  secrets: SecretsService,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<Surreal> {
  const connecting = db.connect(config.url, {
    namespace: config.namespace,
    database: config.database,
    reconnect: RECONNECT,
    // A callback, so the SDK can sign in again after a reconnect or token expiry.
    authentication: async () => serviceSignIn(config, secrets),
  });
  try {
    await withTimeout(connecting, timeoutMs, `Connecting to ${config.url}`);
  } catch (err) {
    await db.close().catch(() => undefined); // stop background reconnects
    throw err;
  }
  new Logger('DatabaseModule').log(
    `Connected to ${config.url} as service:${config.username} (${config.namespace}/${config.database})`,
  );
  return db;
}

/** Clients {@link connectInBackground} keeps connected: how to stop it, for shutdown. */
const keepers = new WeakMap<Surreal, () => void>();
/** Clients {@link startConnecting} is still waiting on. */
const starting = new WeakSet<Surreal>();

/**
 * For the services (Joel, 2026-11-07, "gap a"): starts connecting and returns at once, so a
 * service starts, and passes Cloud Run's start-up check, while the database is away (it runs on
 * Spot). Until it's connected, and during any later outage, `DatabaseAvailability` answers
 * `503 service_restarting`. The SDK retries the socket on its own ({@link RECONNECT}); if it
 * gives up instead (the sign-in after a reconnect failed, e.g. Secret Manager didn't answer), this
 * connects again a few seconds later, for as long as it takes. {@link stopConnecting} ends it.
 */
export function connectInBackground(
  db: Surreal,
  config: DatabaseConfig,
  secrets: SecretsService,
): Surreal {
  const logger = new Logger('DatabaseModule');
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () =>
    db
      .connect(config.url, {
        namespace: config.namespace,
        database: config.database,
        reconnect: RECONNECT,
        // A callback, so the SDK can sign in again after a reconnect or token expiry.
        authentication: async () => serviceSignIn(config, secrets),
      })
      .then(() =>
        logger.log(
          `Connected to ${config.url} as service:${config.username} (${config.namespace}/${config.database})`,
        ),
      )
      .catch((err: unknown) => {
        const refusal = databaseRefusal(err);
        if (refusal && starting.has(db)) return; // startConnecting logs it and stops
        if (refusal) {
          // After start-up, e.g. the password was rotated: a restart until it signs in again.
          logger.error(
            `${config.url} refused service:${config.username}'s sign-in (${DATABASE_REFUSED}, ${describeRefusal(refusal)}); still trying`,
          );
        } else {
          logger.warn(
            `Can't reach ${config.url} yet; still trying: ${String(err)}`,
          );
        }
      });
  const offDisconnected = db.subscribe('disconnected', () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!stopped && db.status === 'disconnected') void connect();
    }, RECONNECT.retryDelayMax);
    retry.unref();
  });
  keepers.set(db, () => {
    stopped = true;
    clearTimeout(retry);
    offDisconnected();
  });
  void connect();
  return db;
}

/** Stops {@link connectInBackground} reconnecting `db` (before closing it). */
export function stopConnecting(db: Surreal): void {
  keepers.get(db)?.();
  keepers.delete(db);
}

/** The short code a refused sign-in is logged with (Cloud Logging: `jsonPayload.code`). */
export const DATABASE_REFUSED = 'database_refused';

/**
 * The database answered and refused this service: a wrong password or other sign-in error,
 * an unknown namespace or database, a permission error. The SDK reports every answer the server
 * gives as a `ServerError` (`kind` NotAllowed, NotFound, …); anything else (no socket, DNS, a
 * timeout, the socket closing, Secret Manager not answering) means it didn't answer.
 */
export function databaseRefusal(err: unknown): ServerError | undefined {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof ServerError) return e;
    e = (e as { cause?: unknown }).cause; // e.g. the SDK's AuthenticationError
  }
  return undefined;
}

/** `NotAllowed/Auth`: the error's kind and detail, never its text (it may name the service). */
function describeRefusal(err: ServerError): string {
  return err.details ? `${err.kind}/${err.details.kind}` : err.kind;
}

/**
 * A service doesn't start: the database refused its sign-in ({@link startConnecting}). Keeps only
 * the refusal's kind and detail, never the server's text or its cause chain (they may name the
 * service or echo what was sent); {@link failedToStart} logs it.
 */
export class DatabaseRefusedError extends Error {
  readonly code = DATABASE_REFUSED;
  /** The refusal's kind and detail kind, e.g. `NotAllowed` and `Auth`. */
  readonly kind: string;
  readonly detail: string | undefined;
  constructor(
    refusal: ServerError,
    readonly url: string,
    readonly username: string,
  ) {
    super(
      `The database refused this service's sign-in (${DATABASE_REFUSED}, ${describeRefusal(refusal)})`,
    );
    this.name = 'DatabaseRefusedError';
    this.kind = refusal.kind;
    this.detail = refusal.details?.kind;
  }
}

/**
 * The services' `NestFactory.create` options for start-up: a failure rejects (rather than Nest's
 * default `process.abort()`), and Nest's own logs wait in a buffer until `app.flushLogs()`, so
 * {@link failedToStart} decides what a failed start prints.
 */
export const START_UP_OPTIONS = {
  abortOnError: false,
  bufferLogs: true,
  autoFlushLogs: false,
} as const;

/**
 * A service's `NestFactory.create(...)` failed: exits with code 1, so Cloud Run keeps the
 * previous revision. The database refused the sign-in ({@link DatabaseRefusedError}): prints one
 * structured CRITICAL line with the code `database_refused` and drops Nest's buffered logs (they
 * would repeat it). Anything else: prints Nest's buffered logs, which end with the error.
 */
export function failedToStart(err: unknown): never {
  if (err instanceof DatabaseRefusedError) {
    process.stdout.write(
      `${JSON.stringify({
        severity: 'CRITICAL',
        message: `${err.message}; not starting`,
        event: DATABASE_REFUSED,
        code: DATABASE_REFUSED,
        kind: err.kind,
        detail: err.detail,
        url: err.url,
        username: err.username,
      })}\n`,
    );
  } else {
    Logger.flush();
  }
  process.exit(1);
}

/** How long start-up waits to learn whether the database answers ({@link startConnecting}). */
export const START_UP_WAIT_MS = 10_000;

/**
 * A service's start-up (Joel, 2026-11-08, "differentiate between restarts with no response and
 * problems caused by an error like a password error"): connects in the background
 * ({@link connectInBackground}) and waits for the first attempt's outcome. Signed in: carry on.
 * No answer (connection refused, DNS, a timeout, the socket closed; `waitMs` passing without
 * either counts too): carry on as well; the database is restarting, and routes answer
 * `503 service_restarting` until it's back. The database answered and refused the sign-in
 * ({@link databaseRefusal}): fails with {@link DatabaseRefusedError}, and the service's
 * {@link failedToStart} logs it and exits before the port opens, so Cloud Run keeps the previous
 * revision. After start-up every failure counts as a restart.
 */
export async function startConnecting(
  db: Surreal,
  config: DatabaseConfig,
  secrets: SecretsService,
  waitMs = START_UP_WAIT_MS,
): Promise<Surreal> {
  let offs: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = new Promise<ServerError | undefined>((settle) => {
    offs = [
      db.subscribe('connected', () => settle(undefined)),
      db.subscribe('reconnecting', () => settle(undefined)),
      // The SDK publishes a refused sign-in as an error before it closes the connection.
      db.subscribe('error', (err) => {
        const refusal = databaseRefusal(err);
        if (refusal) settle(refusal);
      }),
      db.subscribe('disconnected', () => settle(undefined)),
    ];
    timer = setTimeout(() => settle(undefined), waitMs);
  });
  starting.add(db);
  connectInBackground(db, config, secrets);
  const refusal = await outcome.finally(() => {
    clearTimeout(timer);
    for (const off of offs) off();
  });
  if (!refusal) {
    starting.delete(db);
    return db;
  }
  // Still marked as starting, so the background connect's own failure log stays quiet.
  stopConnecting(db);
  await db.close().catch(() => undefined);
  throw new DatabaseRefusedError(refusal, config.url, config.username);
}

/**
 * Global module providing the service's SurrealDB client (token {@link SURREAL}): starts once it
 * knows whether the database answers, then keeps connecting in the background
 * ({@link startConnecting}). Requires `SecretsModule` to be imported by the application.
 */
@Global()
@Module({
  providers: [
    {
      provide: SURREAL,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService): Promise<Surreal> =>
        startConnecting(new Surreal(), databaseConfigFromEnv(), secrets),
    },
    DatabaseHealthService,
    DatabaseAvailability,
  ],
  exports: [SURREAL, DatabaseHealthService, DatabaseAvailability],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  async onApplicationShutdown(): Promise<void> {
    stopConnecting(this.db);
    await this.db.close();
  }
}

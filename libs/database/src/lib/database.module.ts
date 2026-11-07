import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SecretsService, withTimeout } from '@heisreal/secrets';
import { type ProvidedAuth, Surreal } from 'surrealdb';
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
      .catch((err: unknown) =>
        logger.warn(
          `Can't reach ${config.url} yet; still trying: ${String(err)}`,
        ),
      );
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

/**
 * Global module providing the service's SurrealDB client (token {@link SURREAL}), connecting in
 * the background ({@link connectInBackground}). Requires `SecretsModule` to be imported by the
 * application.
 */
@Global()
@Module({
  providers: [
    {
      provide: SURREAL,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService): Surreal =>
        connectInBackground(new Surreal(), databaseConfigFromEnv(), secrets),
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

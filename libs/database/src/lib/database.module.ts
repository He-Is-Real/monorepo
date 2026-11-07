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

/** Startup fails with a clear error instead of hanging while the SDK retries an unreachable database. */
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

/**
 * Global module providing a connected SurrealDB client (token {@link SURREAL}).
 * Requires `SecretsModule` to be imported by the application.
 */
@Global()
@Module({
  providers: [
    {
      provide: SURREAL,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService): Promise<Surreal> =>
        connectDatabase(new Surreal(), databaseConfigFromEnv(), secrets),
    },
    DatabaseHealthService,
    DatabaseAvailability,
  ],
  exports: [SURREAL, DatabaseHealthService, DatabaseAvailability],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

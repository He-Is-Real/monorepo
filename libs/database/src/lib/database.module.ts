import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SecretsService, withTimeout } from '@heisreal/secrets';
import { Surreal } from 'surrealdb';
import { DatabaseHealthService } from './database-health.service';
import { DatabaseConfig, databaseConfigFromEnv } from './database.config';
import { SURREAL } from './database.constants';

/** Startup fails with a clear error instead of hanging while the SDK retries an unreachable database. */
export const CONNECT_TIMEOUT_MS = 15_000;

export async function connectDatabase(
  db: Surreal,
  config: DatabaseConfig,
  secrets: SecretsService,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<Surreal> {
  const connecting = db.connect(config.url, {
    namespace: config.namespace,
    database: config.database,
    // A callback, so the SDK can sign in again after a reconnect or token expiry.
    authentication: async () => ({
      namespace: config.namespace,
      database: config.database,
      username: config.username,
      password: await secrets.get(config.passwordSecret),
    }),
  });
  try {
    await withTimeout(connecting, timeoutMs, `Connecting to ${config.url}`);
  } catch (err) {
    await db.close().catch(() => undefined); // stop background reconnects
    throw err;
  }
  new Logger('DatabaseModule').log(
    `Connected to ${config.url} as ${config.username} (${config.namespace}/${config.database})`,
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
  ],
  exports: [SURREAL, DatabaseHealthService],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

import { requireEnv } from '@heisreal/secrets';

/**
 * Connection settings, read from the environment. The password is never in
 * the environment: `SURREAL_PASSWORD_SECRET` names the Secret Manager secret
 * holding it. Each service signs in as its own `service` record through
 * `DEFINE ACCESS svc` (D13 B), and table permissions limit what it can do.
 */
export interface DatabaseConfig {
  /** e.g. ws://localhost:8000 locally, ws://surrealdb.database.svc:8000 on GKE */
  url: string;
  namespace: string;
  database: string;
  /** The service record's name (SURREAL_USER), e.g. api_public_read for service:api_public_read */
  username: string;
  passwordSecret: string;
}

export function databaseConfigFromEnv(): DatabaseConfig {
  return {
    url: requireEnv('SURREAL_URL'),
    namespace: requireEnv('SURREAL_NAMESPACE'),
    database: requireEnv('SURREAL_DATABASE'),
    username: requireEnv('SURREAL_USER'),
    passwordSecret: requireEnv('SURREAL_PASSWORD_SECRET'),
  };
}

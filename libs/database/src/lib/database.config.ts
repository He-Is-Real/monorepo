import { requireEnv } from '@heisreal/secrets';

/**
 * Connection settings, read from the environment. The password is never in
 * the environment: `SURREAL_PASSWORD_SECRET` names the Secret Manager secret
 * holding it. Each service connects as its own least-privilege database user
 * (api-read = VIEWER; api-write, api-admin, workflow = EDITOR).
 */
export interface DatabaseConfig {
  /** e.g. ws://localhost:8000 locally, ws://surrealdb.database.svc:8000 on GKE */
  url: string;
  namespace: string;
  database: string;
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

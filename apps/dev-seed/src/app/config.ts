/**
 * The dev-seed Job's settings (OpenTofu sets them on the Cloud Run Job, modules/gcp/dev_seed.tf).
 * The password is never in the environment: SURREAL_PASSWORD_SECRET names its secret.
 */
export interface SeedConfig {
  url: string;
  namespace: string;
  database: string;
  /** The dev-only system user, `dev_seed`. */
  username: string;
  passwordSecret: string;
  project: string;
}

/** The only place this may run (D49). The database checks its own environment too. */
export const DEV_PROJECT = 'heisreal-dev';

export class RefusedError extends Error {}

/** Reads and checks the settings; refuses unless they say dev. */
export function seedConfig(env: NodeJS.ProcessEnv = process.env): SeedConfig {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value)
      throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  if (env['DEV_SEED_ENVIRONMENT'] !== 'dev') {
    throw new RefusedError(
      `dev-seed only runs in dev (DEV_SEED_ENVIRONMENT is ${JSON.stringify(env['DEV_SEED_ENVIRONMENT'] ?? null)})`,
    );
  }
  const project = need('GCP_PROJECT');
  if (project !== DEV_PROJECT) {
    throw new RefusedError(
      `dev-seed only runs in ${DEV_PROJECT}, not ${project}`,
    );
  }
  return {
    url: need('SURREAL_URL'),
    namespace: need('SURREAL_NAMESPACE'),
    database: need('SURREAL_DATABASE'),
    username: need('SURREAL_USER'),
    passwordSecret: need('SURREAL_PASSWORD_SECRET'),
    project,
  };
}

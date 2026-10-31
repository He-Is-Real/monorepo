import type { DatabaseConfig } from '@heisreal/database';

/**
 * The housekeeping Job's settings (OpenTofu sets them on the Cloud Run Job,
 * modules/gcp/housekeeping.tf). Passwords and keys are never in the environment: the
 * `*_SECRET` variables name their Secret Manager secrets.
 */
export interface HousekeepingConfig {
  project: string;
  database: DatabaseConfig;
  stream: { libraryId: string; keySecret: string };
  /** Clerk's secret key's secret (CLERK_SECRET_KEY_SECRET), or null: Clerk deletions wait. */
  clerkKeySecret: string | null;
  /**
   * The images storage zone (BUNNY_STORAGE_ZONE, its S3 host BUNNY_STORAGE_S3_HOST, and its
   * password's secret BUNNY_STORAGE_PASSWORD_SECRET), or null: picture deletions wait.
   */
  images: { zone: string; s3Host: string; passwordSecret: string } | null;
  /** Only log what would be deleted. On unless HOUSEKEEPING_DRY_RUN is exactly `false`. */
  dryRun: boolean;
  /** Each chore deletes at most this many per run. */
  maxDeletions: number;
}

export class RefusedError extends Error {}

const LIBRARY = /^[0-9]{1,12}$/;
const SECRET = /^[A-Za-z0-9_-]{1,255}$/;
const ZONE = /^[a-z0-9-]{1,64}$/;
const S3_HOST = /^[a-z0-9]+-s3\.storage\.bunnycdn\.com$/;

export function housekeepingConfig(
  env: NodeJS.ProcessEnv = process.env,
): HousekeepingConfig {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new RefusedError(`Missing environment variable ${name}`);
    return value;
  };
  const dryRun = env['HOUSEKEEPING_DRY_RUN']?.trim() ?? 'true';
  if (dryRun !== 'true' && dryRun !== 'false') {
    throw new RefusedError('HOUSEKEEPING_DRY_RUN must be true or false');
  }
  const max = Number(env['HOUSEKEEPING_MAX_DELETIONS']?.trim() ?? '50');
  if (!Number.isInteger(max) || max < 1 || max > 500) {
    throw new RefusedError(
      'HOUSEKEEPING_MAX_DELETIONS must be a whole number from 1 to 500',
    );
  }
  const libraryId = need('BUNNY_STREAM_LIBRARY_ID');
  const keySecret = need('BUNNY_STREAM_API_KEY_SECRET');
  if (!LIBRARY.test(libraryId) || !SECRET.test(keySecret)) {
    throw new RefusedError(
      'BUNNY_STREAM_LIBRARY_ID must be numeric and BUNNY_STREAM_API_KEY_SECRET a secret name',
    );
  }
  const clerkKeySecret = env['CLERK_SECRET_KEY_SECRET']?.trim() || null;
  if (clerkKeySecret !== null && !SECRET.test(clerkKeySecret)) {
    throw new RefusedError('CLERK_SECRET_KEY_SECRET must be a secret name');
  }
  const zone = env['BUNNY_STORAGE_ZONE']?.trim() || null;
  const s3Host = env['BUNNY_STORAGE_S3_HOST']?.trim() || null;
  const passwordSecret = env['BUNNY_STORAGE_PASSWORD_SECRET']?.trim() || null;
  const anyImages = zone !== null || s3Host !== null || passwordSecret !== null;
  if (
    anyImages &&
    !(
      zone !== null &&
      ZONE.test(zone) &&
      s3Host !== null &&
      S3_HOST.test(s3Host) &&
      passwordSecret !== null &&
      SECRET.test(passwordSecret)
    )
  ) {
    throw new RefusedError(
      'BUNNY_STORAGE_ZONE, BUNNY_STORAGE_S3_HOST (a Bunny S3 host) and BUNNY_STORAGE_PASSWORD_SECRET (a secret name) go together',
    );
  }
  return {
    project: need('GCP_PROJECT'),
    database: {
      url: need('SURREAL_URL'),
      namespace: need('SURREAL_NAMESPACE'),
      database: need('SURREAL_DATABASE'),
      username: need('SURREAL_USER'),
      passwordSecret: need('SURREAL_PASSWORD_SECRET'),
    },
    stream: { libraryId, keySecret },
    clerkKeySecret,
    images:
      zone && s3Host && passwordSecret
        ? { zone, s3Host, passwordSecret }
        : null,
    dryRun: dryRun === 'true',
    maxDeletions: max,
  };
}

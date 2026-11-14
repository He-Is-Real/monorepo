import type { SecretsService } from '@heisreal/secrets';
import type { StorageZone } from './upload-signing';

type Env = Record<string, string | undefined>;

const SECRET = /^[A-Za-z0-9_-]{1,255}$/;
const ZONE = /^[a-z0-9-]{1,64}$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const REGION = /^[a-z0-9-]{1,32}$/;

/**
 * The images storage zone (M2 plan PR 10; D68, D80) for api-user (picture uploads, deleted
 * stories' folders) and api-admin (an Admin's Delete removes the story's folder at once: DEL-1,
 * Joel 2026-11-14): on when `BUNNY_STORAGE_PASSWORD_SECRET` names the zone password's secret
 * (`bunny-storage-password`), with the zone in `BUNNY_STORAGE_ZONE` and its S3 endpoint in
 * `BUNNY_STORAGE_S3_HOST` / `BUNNY_STORAGE_S3_REGION` (infra/terraform/README.md, "Uploads").
 * Null (off) without the secret's name; the caller logs what that means for it. The password comes
 * from Secret Manager and is never logged.
 */
export async function loadImagesZone(
  secrets: Pick<SecretsService, 'get'>,
  env: Env = process.env,
): Promise<StorageZone | null> {
  const secret = env['BUNNY_STORAGE_PASSWORD_SECRET']?.trim() ?? '';
  if (secret === '') return null;
  const name = env['BUNNY_STORAGE_ZONE']?.trim() ?? '';
  const host = env['BUNNY_STORAGE_S3_HOST']?.trim() ?? '';
  const region = env['BUNNY_STORAGE_S3_REGION']?.trim() ?? '';
  if (
    !SECRET.test(secret) ||
    !ZONE.test(name) ||
    !HOST.test(host) ||
    !REGION.test(region)
  ) {
    throw new Error(
      'The images zone needs BUNNY_STORAGE_PASSWORD_SECRET (a secret name), BUNNY_STORAGE_ZONE, BUNNY_STORAGE_S3_HOST and BUNNY_STORAGE_S3_REGION',
    );
  }
  const password = (await secrets.get(secret)).trim();
  if (password === '') throw new Error(`Secret ${secret} is empty`);
  return { name, password, host, region };
}

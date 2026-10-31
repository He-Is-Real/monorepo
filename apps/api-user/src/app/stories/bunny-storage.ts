import { Logger } from '@nestjs/common';
import type { SecretsService } from '@heisreal/secrets';
import {
  deleteStoryFolder,
  presignStorageUrl,
  type StorageZone,
} from '@heisreal/story-cards';

/**
 * The images storage zone for uploads (M2 plan PR 10; D68, D80): api-user signs the browser's S3
 * presigned PUT for an image whose path it picked. The PUT binds the path, `Content-Type`, the
 * exact `Content-Length`, the expiry and one use (`If-None-Match: *`: a second PUT to the path
 * answers 412). The zone password (`bunny-storage-password`, which only api-user may read:
 * `upload_key_readers`, bunny root) comes from Secret Manager at startup and is never logged.
 * Without `BUNNY_STORAGE_PASSWORD_SECRET`, image uploads are off and RequestUpload answers `503`.
 * api-user never deletes a replaced or removed picture (one may still be on an approved story's
 * public copy; the clean-up sweep removes orphans, media-runbook), only the folders of stories that
 * are gone, from erasure's queue (D40).
 */
export const BUNNY_STORAGE = Symbol('BUNNY_STORAGE');

/** How long an image's PUT link lasts (D68: a few minutes; the browser has the file ready). */
export const IMAGE_LINK_SECONDS = 600;

/** What RequestUpload returns for an image: the contract's `UploadTarget` bits. */
export interface SignedImageUpload {
  uploadUrl: string;
  headers: { 'Content-Type': 'image/webp'; 'If-None-Match': '*' };
  expiresAt: string;
}

export interface ImageStore {
  /** A PUT link for that path, that type and exactly that many bytes, once. */
  sign(path: string, sizeBytes: number, now?: number): SignedImageUpload;
  /** Whether the file at that path has arrived; throws when the zone gives no clear answer. */
  exists(path: string): Promise<boolean>;
  /**
   * Erasure's queued picture (D40), always a path from the database, which keeps every story's
   * picture in its own folder (fn::media::own_image): deletes that picture's story's whole folder, which is gone
   * with the story (`deleteStoryFolder`). Throws unless it's done.
   */
  deleteImage(path: string): Promise<void>;
}

export class BunnyImageStore implements ImageStore {
  constructor(private readonly zone: StorageZone) {}

  sign(path: string, sizeBytes: number, now = Date.now()): SignedImageUpload {
    return signImageUpload(this.zone, path, sizeBytes, now);
  }

  /**
   * A presigned HEAD: no body. Checked on dev 2026-10-31: 200 when the file is there, 404 when
   * not (and 403 for a HEAD on a link signed for GET, so it's signed as a HEAD). A file only
   * arrives through its PUT (one use), so once there it's the picture the grant named.
   */
  async exists(path: string): Promise<boolean> {
    const res = await fetch(
      presignStorageUrl(this.zone, {
        method: 'HEAD',
        key: path,
        expiresIn: 60,
      }),
      { method: 'HEAD', signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`The images zone answered ${res.status} for a picture`);
  }

  deleteImage(path: string): Promise<void> {
    return deleteStoryFolder(this.zone, path);
  }
}

export function signImageUpload(
  zone: StorageZone,
  path: string,
  sizeBytes: number,
  now = Date.now(),
): SignedImageUpload {
  const headers = {
    'Content-Type': 'image/webp',
    'If-None-Match': '*',
  } as const;
  return {
    uploadUrl: presignStorageUrl(zone, {
      method: 'PUT',
      key: path,
      expiresIn: IMAGE_LINK_SECONDS,
      headers: { ...headers, 'Content-Length': sizeBytes },
      now: new Date(now),
    }),
    headers,
    expiresAt: new Date(
      Math.floor(now / 1000) * 1000 + IMAGE_LINK_SECONDS * 1000,
    ).toISOString(),
  };
}

type Env = Record<string, string | undefined>;

const SECRET = /^[A-Za-z0-9_-]{1,255}$/;
const ZONE = /^[a-z0-9-]{1,64}$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const REGION = /^[a-z0-9-]{1,32}$/;

/**
 * Image uploads on when `BUNNY_STORAGE_PASSWORD_SECRET` names the password's secret, with the zone
 * in `BUNNY_STORAGE_ZONE` and its S3 endpoint in `BUNNY_STORAGE_S3_HOST` / `BUNNY_STORAGE_S3_REGION`
 * (infra/terraform/README.md, "Uploads"). Off (null) without it.
 */
export async function createImageStore(
  secrets: Pick<SecretsService, 'get'>,
  env: Env = process.env,
): Promise<ImageStore | null> {
  const logger = new Logger('ImageStore');
  const secret = env['BUNNY_STORAGE_PASSWORD_SECRET']?.trim() ?? '';
  if (secret === '') {
    logger.warn(
      'Image uploads are off (no BUNNY_STORAGE_PASSWORD_SECRET): RequestUpload answers 503 for images',
    );
    return null;
  }
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
      'Image uploads need BUNNY_STORAGE_PASSWORD_SECRET (a secret name), BUNNY_STORAGE_ZONE, BUNNY_STORAGE_S3_HOST and BUNNY_STORAGE_S3_REGION',
    );
  }
  const password = (await secrets.get(secret)).trim();
  if (password === '') throw new Error(`Secret ${secret} is empty`);
  logger.log(`Image uploads on: storage zone ${name} at ${host}`);
  return new BunnyImageStore({ name, password, host, region });
}

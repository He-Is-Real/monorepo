import { createHash, createHmac } from 'node:crypto';

/**
 * The two upload signatures api-user makes (M2; proven on dev by dev-seed's uploads.developer.ts,
 * and used by api-user's RequestUpload). The browser uploads straight to Bunny with them, so no
 * service handles media bytes. Keys come from Secret Manager (`bunny-stream-api-key`,
 * `bunny-storage-password`) and are never logged. Imported as `@heisreal/story-cards/upload-signing`
 * (no Nest code, so Playwright's loader can read it too).
 */

/**
 * Bunny Stream's presigned TUS upload: `AuthorizationSignature = sha256(libraryId + libraryKey +
 * expires + videoId)`, hex. It binds only the library, the video and the expiry (Unix seconds),
 * not the file's size or type, and stays valid until it expires.
 */
export function tusSignature(
  libraryId: string,
  libraryKey: string,
  expires: number,
  videoId: string,
): string {
  return createHash('sha256')
    .update(`${libraryId}${libraryKey}${expires}${videoId}`)
    .digest('hex');
}

/** The images storage zone's S3 endpoint: its region's host, and SigV4's region name. */
export interface StorageZone {
  /** The zone name, which is also the S3 access key id. */
  name: string;
  /** The zone's password (`bunny-storage-password`), the S3 secret access key. */
  password: string;
  /** London: `uk-s3.storage.bunnycdn.com`. */
  host: string;
  /** SigV4 region for that host: `uk`. */
  region: string;
}

export interface Presign {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  /** Object key inside the zone; api-user picks it (D80). */
  key: string;
  /** Seconds the link is valid; Bunny refuses more than 7 days (400). */
  expiresIn: number;
  /**
   * Headers the request must carry with exactly these values (lower-case names). For an upload:
   * `content-type`, `content-length` and `if-none-match: *`. Anything else answers 403; with
   * `if-none-match: *`, a second PUT to the same key answers 412.
   */
  headers?: Record<string, string | number>;
  now?: Date;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) =>
  createHmac('sha256', key).update(s).digest();
// RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone).
const uriEncode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * An S3 SigV4 query-string presigned URL for the zone (UNSIGNED-PAYLOAD: the body isn't hashed,
 * but its length and type are bound through the signed headers).
 */
export function presignStorageUrl(zone: StorageZone, p: Presign): string {
  const amzDate = (p.now ?? new Date())
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${zone.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: zone.host };
  for (const [k, v] of Object.entries(p.headers ?? {})) {
    headers[k.toLowerCase()] = String(v).trim();
  }
  const signed = Object.keys(headers).sort();
  const path = `/${uriEncode(zone.name)}/${p.key.split('/').map(uriEncode).join('/')}`;
  const query = Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${zone.name}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(p.expiresIn),
    'X-Amz-SignedHeaders': signed.join(';'),
  })
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join('&');
  const canonical = [
    p.method,
    path,
    query,
    signed.map((k) => `${k}:${headers[k]}\n`).join(''),
    signed.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join(
    '\n',
  );
  let key = hmac(`AWS4${zone.password}`, day);
  for (const part of [zone.region, 's3', 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `https://${zone.host}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** A story's picture's path in the images zone, as api-user names it (D80). */
export const STORY_IMAGE_PATH =
  /^stories\/([A-Za-z0-9_]{1,64})\/[0-9a-f]{32}\.webp$/;

/**
 * A deleted story's folder as the queue names it (pendingDeletion `image`, story_picture_folder),
 * or the path of a picture in it (rows queued before 2026-10-31 named one).
 */
const STORY_FOLDER = /^stories\/([A-Za-z0-9_]{1,64})\/(?:[0-9a-f]{32}\.webp)?$/;

/**
 * Deletes a story's whole folder in the images zone (`stories/<story id>/`), with everything in
 * it: the story's picture and any it replaced, or one a late PUT put there. Only for a story that
 * is gone (its delete queued the folder). Through Bunny's Edge Storage API
 * (`uk.storage.bunnycdn.com` for the zone's S3 host `uk-s3.storage.bunnycdn.com`), the zone's
 * password as its `AccessKey`: S3 has no folders, and deleting a folder's last object by S3 leaves
 * the folder behind (media-runbook.md; proven on dev by dev-seed's upload spike). Done on 200, or
 * 404 (already gone); anything else throws.
 */
export async function deleteStoryFolder(
  zone: Pick<StorageZone, 'name' | 'password' | 'host'>,
  folder: string,
): Promise<void> {
  const story = STORY_FOLDER.exec(folder)?.[1];
  if (!story) throw new Error('Not a story’s folder');
  const region = /^([a-z0-9]+)-s3\.storage\.bunnycdn\.com$/.exec(
    zone.host,
  )?.[1];
  if (!region) throw new Error(`No Edge Storage host for ${zone.host}`);
  const res = await fetch(
    `https://${region}.storage.bunnycdn.com/${uriEncode(zone.name)}/stories/${story}/`,
    {
      method: 'DELETE',
      headers: { AccessKey: zone.password },
      signal: AbortSignal.timeout(10_000),
    },
  );
  await res.body?.cancel().catch(() => undefined);
  if (res.status !== 200 && res.status !== 404) {
    throw new Error(
      `The images zone answered ${res.status} to deleting a story’s folder`,
    );
  }
}

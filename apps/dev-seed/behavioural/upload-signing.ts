import { createHash, createHmac } from 'node:crypto';

/**
 * The two upload signatures api-user will make (M2; proven on dev by uploads.developer.ts). The
 * browser uploads straight to Bunny with them, so no service handles media bytes. Keys come from
 * Secret Manager (`bunny-stream-api-key`, `bunny-storage-password`) and are never logged.
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
  method: 'PUT' | 'GET' | 'DELETE';
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

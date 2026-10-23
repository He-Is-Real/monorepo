import { createHash, createHmac } from 'node:crypto';

// Bunny's token authentication (D52). Pure functions: the keys come from the caller.
//
// - Stream embed (player) tokens: sha256_hex(key + videoId + expires), on
//   https://player.mediadelivery.net/embed/<library>/<video>?token=…&expires=… (Bunny docs,
//   "Embed view token authentication"). The key is the Stream pull zone's token auth key, which
//   also signs that zone's CDN URLs (thumbnails).
// - CDN (pull zone) tokens, Advanced: "HS256-" + base64url(HMAC-SHA256(key, path + expires)),
//   with no extra parameters (BunnyWay/BunnyCDN.TokenAuthentication). Basic (MD5) tokens are
//   deprecated by Bunny, so they aren't used.

/** Links last at least this long (D52: longer than any cached response, 60 s + 300 s today). */
export const LINK_TTL_SECONDS = 6 * 60 * 60;
/** Expiries are rounded up to the hour, so a story's body and ETag change at most hourly. */
export const LINK_BUCKET_SECONDS = 60 * 60;

/** Unix seconds: now + 6 h, rounded up to the next hour (6–7 h left when issued). */
export function linkExpiry(nowMs: number): number {
  const earliest = Math.ceil(nowMs / 1000) + LINK_TTL_SECONDS;
  return Math.ceil(earliest / LINK_BUCKET_SECONDS) * LINK_BUCKET_SECONDS;
}

const LIBRARY_ID = /^[0-9]{1,12}$/;
const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only unreserved URL characters, so the signed path is exactly the requested one (no
// percent-encoding ambiguity); `.` and `..` segments are refused below.
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_PATH = 500;

function safePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH) return false;
  return path
    .split('/')
    .every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

/** A signed Bunny Stream player URL, or `null` if the ids aren't what Bunny issues. */
export function signEmbedUrl(
  libraryId: string,
  videoId: string,
  key: string,
  expires: number,
): string | null {
  if (!LIBRARY_ID.test(libraryId) || !VIDEO_ID.test(videoId)) return null;
  const token = createHash('sha256')
    .update(`${key}${videoId}${expires}`)
    .digest('hex');
  return `https://player.mediadelivery.net/embed/${libraryId}/${videoId}?token=${token}&expires=${expires}`;
}

/** A signed pull-zone URL for `path` (relative, no leading slash), or `null` if unsafe. */
export function signCdnUrl(
  host: string,
  path: string,
  key: string,
  expires: number,
): string | null {
  if (!safePath(path)) return null;
  const signed = `/${path}`;
  const token = createHmac('sha256', key)
    .update(`${signed}${expires}`)
    .digest('base64url');
  return `https://${host}${signed}?token=HS256-${token}&expires=${expires}`;
}

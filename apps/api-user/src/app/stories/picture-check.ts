/**
 * The picture check at submit (Joel, 2026-10-30: m2-remaining-decisions R3 = A, with its extra
 * suggestion; m2-media-ready-plan D128 B). api-user reads only the first bytes of the story's
 * picture from the images zone. They say whether it is the clean WebP the person's page made:
 * all of it there (the RIFF header's size and the zone's agree with the size recorded at upload),
 * really a WebP (`RIFF` … `WEBP`, then a `VP8 `, `VP8L` or `VP8X` chunk), of the width and height
 * recorded, and with no hidden metadata or animation (a `VP8X` header's EXIF, XMP or animation
 * flags). A browser's canvas never writes those, so a picture that has them wasn't cleaned on the
 * person's device, and a photo's location could identify the person who shared a testimony.
 * Allowed: transparency, and a colour profile (Chrome writes an sRGB one into every WebP it makes
 * from a canvas, checked 2026-11-09; it holds no location or camera details).
 */

/** How much of the picture api-user reads (a `VP8X` header ends at byte 30). */
export const PICTURE_START_BYTES = 40;

/** What the images zone answered for a picture's first bytes. */
export interface PictureStart {
  /** The whole file's size, from the zone. */
  size: number;
  /** Its first bytes (at most PICTURE_START_BYTES). */
  bytes: Uint8Array;
}

/** What the picture's row recorded at upload (the person's browser's figures). */
export interface RecordedPicture {
  sizeBytes: number;
  width: number;
  height: number;
}

/** Why a picture isn't the one the person's page made, for the log (never shown to them). */
export type PictureProblem =
  | 'missing'
  | 'size_mismatch'
  | 'not_webp'
  | 'dimensions_mismatch'
  | 'hidden_extras';

const EXIF = 0x08;
const XMP = 0x04;
const ANIMATION = 0x02;

const ascii = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24 = (b: Uint8Array, at: number) => u16(b, at) | (b[at + 2] << 16);
const u32 = (b: Uint8Array, at: number) =>
  (u24(b, at) | (b[at + 3] << 24)) >>> 0;

/** The picture's real pixel size from its first chunk, or a problem. */
function pixelSize(
  b: Uint8Array,
): { width: number; height: number } | PictureProblem {
  switch (ascii(b, 12)) {
    case 'VP8X':
      if (b[20] & (EXIF | XMP | ANIMATION)) return 'hidden_extras';
      return { width: u24(b, 24) + 1, height: u24(b, 27) + 1 };
    case 'VP8L': {
      // Signature 0x2f, then 14 bits width - 1, 14 bits height - 1, alpha, a 3-bit version (0).
      const bits = u32(b, 21);
      if (b[20] !== 0x2f || bits >>> 29 !== 0) return 'not_webp';
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    case 'VP8 ':
      // A key frame (bit 0 of its tag clear), its start code, then 14-bit width and height.
      if (b[20] & 1 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
        return 'not_webp';
      }
      return { width: u16(b, 26) & 0x3fff, height: u16(b, 28) & 0x3fff };
    default:
      return 'not_webp';
  }
}

/** What's wrong with the stored picture (`start`: null when the zone has no file), or null. */
export function pictureProblem(
  start: PictureStart | null,
  recorded: RecordedPicture,
): PictureProblem | null {
  if (!start || start.size === 0) return 'missing';
  if (start.size !== recorded.sizeBytes) return 'size_mismatch';
  const b = start.bytes;
  if (b.length < 30 || ascii(b, 0) !== 'RIFF' || ascii(b, 8) !== 'WEBP') {
    return 'not_webp';
  }
  if (u32(b, 4) + 8 !== start.size) return 'size_mismatch';
  const size = pixelSize(b);
  if (typeof size === 'string') return size;
  if (size.width !== recorded.width || size.height !== recorded.height) {
    return 'dimensions_mismatch';
  }
  return null;
}

/**
 * How every picture leaves the device (D53; thumbnail crop TC-7 A, Joel 2026-11-21): the chosen
 * part of a photo (or a video's frame) redrawn on a canvas as a WebP, which carries no metadata.
 *
 * - At most 2048 px on its longer side (larger pictures are scaled down, smoothly).
 * - No smallest size: a picture under about 1,000 px on its longer side is enlarged by a whole
 *   number with hard pixel edges (nearest neighbour), so pixel art stays crisp on cards and in
 *   Bunny's player, which would otherwise smooth it when stretching it.
 */
export const MAX_SIDE = 2048;
/** Small pictures are enlarged until their longer side is at least this. */
export const ENLARGE_TO = 1000;
const QUALITY = 0.85;

/** The shapes we take: no more than 3 times as wide as tall, or as tall as wide. */
export const MIN_ASPECT = 1 / 3;
export const MAX_ASPECT = 3;
export const clampAspect = (aspect: number) =>
  Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));

/**
 * The size a crop of `width` × `height` source pixels is uploaded at, and how it's drawn. A crop
 * may be in fractions of a pixel (a tiny picture cut to a video's shape): it's rounded only at
 * the size it's uploaded at, so it keeps its shape, and nudged back inside 1:3..3:1 if rounding
 * took it just outside (a 1 × 1 photo cut for a 1:3 video: 333 × 1000 becomes 334 × 1000).
 */
export function outputSize(
  width: number,
  height: number,
): { width: number; height: number; smooth: boolean } {
  const size = roundedSize(width, height);
  if (size.height > size.width * MAX_ASPECT) {
    size.width = Math.ceil(size.height / MAX_ASPECT);
  } else if (size.width > size.height * MAX_ASPECT) {
    size.height = Math.ceil(size.width / MAX_ASPECT);
  }
  return size;
}

function roundedSize(
  width: number,
  height: number,
): { width: number; height: number; smooth: boolean } {
  const longer = Math.max(width, height);
  if (longer > MAX_SIDE) {
    const scale = MAX_SIDE / longer;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      smooth: true,
    };
  }
  if (longer < ENLARGE_TO) {
    // A whole number, so every source pixel becomes the same square block.
    const k = Math.ceil(ENLARGE_TO / longer);
    return {
      width: Math.max(1, Math.round(width * k)),
      height: Math.max(1, Math.round(height * k)),
      smooth: false,
    };
  }
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    smooth: true,
  };
}

export interface Encoded {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Draws `rect` of `source` (in its own pixels, fractions allowed) as a WebP; a plain reason when this browser can't.
 * The size against the largest picture file is the caller's check.
 */
export async function encodeWebp(
  source: CanvasImageSource,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Encoded | string> {
  const out = outputSize(rect.width, rect.height);
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = out.smooth;
    if (out.smooth) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      out.width,
      out.height,
    );
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', QUALITY),
  );
  if (!ctx || !blob || blob.type !== 'image/webp') {
    return 'This browser can’t prepare pictures for upload. Please try another browser.';
  }
  return { blob, width: out.width, height: out.height };
}

/**
 * The largest part of a `width` × `height` picture at `aspect`, around its middle: a video frame
 * outside the shapes we take, or a card preview of another shape.
 */
export function centred(
  width: number,
  height: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (width / height > aspect) {
    const w = Math.max(1, Math.round(height * aspect));
    return { x: Math.round((width - w) / 2), y: 0, width: w, height };
  }
  const h = Math.max(1, Math.round(width / aspect));
  return { x: 0, y: Math.round((height - h) / 2), width, height: h };
}

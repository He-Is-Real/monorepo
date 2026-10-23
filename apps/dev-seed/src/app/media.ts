/**
 * The dummy media set (D47): ~10 synthetic clips of at most 20 s and ~5 small WebP images.
 * `src/media/generate.ts` makes the files from this list with ffmpeg; `src/media/upload.ts`
 * uploads each one once to the dev Bunny library or storage zone and records what Bunny
 * reports in `bunny-media.json`. Stories reuse clips where only the shape matters.
 *
 * Sizes are the files' real pixel sizes: small, so encoding and storage cost next to nothing
 * (Bunny's $1 monthly minimum is the actual bill).
 */
export interface ClipSpec {
  kind: 'video' | 'audio';
  /** Burned into the picture (video) and the Bunny title. */
  label: string;
  /** Video only. */
  width?: number;
  height?: number;
  durationSeconds: number;
  /** The test tone. */
  toneHz: number;
}

export interface ImageSpec {
  label: string;
  width: number;
  height: number;
  /** Fake GPS position written into the file's EXIF, so the D53 stripping check has something to catch. */
  gps: { latitude: number; longitude: number };
}

/** At most 20 seconds per clip (D47). */
export const MAX_CLIP_SECONDS = 20;

export const CLIPS = {
  'clip-01': {
    kind: 'video',
    label: 'DEV TEST · 9:16 · #1',
    width: 360,
    height: 640,
    durationSeconds: 12,
    toneHz: 440,
  },
  'clip-02': {
    kind: 'video',
    label: 'DEV TEST · 9:19.5 · #2',
    width: 360,
    height: 780,
    durationSeconds: 10,
    toneHz: 494,
  },
  'clip-03': {
    kind: 'video',
    label: 'DEV TEST · 16:9 · #3',
    width: 640,
    height: 360,
    durationSeconds: 15,
    toneHz: 523,
  },
  'clip-04': {
    kind: 'video',
    label: 'DEV TEST · 2.4:1 · #4',
    width: 768,
    height: 320,
    durationSeconds: 8,
    toneHz: 587,
  },
  'clip-05': {
    kind: 'video',
    label: 'DEV TEST · 1:1 · #5',
    width: 480,
    height: 480,
    durationSeconds: 10,
    toneHz: 659,
  },
  'clip-06': {
    kind: 'video',
    label: 'DEV TEST · 9:16 · #6',
    width: 360,
    height: 640,
    durationSeconds: 20,
    toneHz: 698,
  },
  'clip-07': {
    kind: 'video',
    label: 'DEV TEST · 16:9 · #7',
    width: 640,
    height: 360,
    durationSeconds: 6,
    toneHz: 784,
  },
  'clip-08': {
    kind: 'audio',
    label: 'DEV TEST · audio · #8',
    durationSeconds: 12,
    toneHz: 330,
  },
  'clip-09': {
    kind: 'audio',
    label: 'DEV TEST · audio · #9',
    durationSeconds: 15,
    toneHz: 392,
  },
  'clip-10': {
    kind: 'audio',
    label: 'DEV TEST · audio, long · #10',
    durationSeconds: 20,
    toneHz: 262,
  },
} as const satisfies Record<string, ClipSpec>;

export const IMAGES = {
  'image-01': {
    label: 'DEV TEST · portrait 3:4',
    width: 1200,
    height: 1600,
    gps: { latitude: 51.4769, longitude: -0.0005 },
  },
  'image-02': {
    label: 'DEV TEST · landscape 3:2',
    width: 1600,
    height: 1066,
    gps: { latitude: 55.9486, longitude: -3.1999 },
  },
  'image-03': {
    label: 'DEV TEST · square',
    width: 1200,
    height: 1200,
    gps: { latitude: 53.4084, longitude: -2.9916 },
  },
  'image-04': {
    label: 'DEV TEST · panorama 2.5:1',
    width: 1600,
    height: 640,
    gps: { latitude: 51.4545, longitude: -2.5879 },
  },
  'image-05': {
    label: 'DEV TEST · portrait 4:5',
    width: 1080,
    height: 1350,
    gps: { latitude: 52.2053, longitude: 0.1218 },
  },
} as const satisfies Record<string, ImageSpec>;

export type ClipId = keyof typeof CLIPS;
export type ImageId = keyof typeof IMAGES;

/** Where an image lives in the storage zone (and so behind the pull zone). Fixed: found again by name. */
export const imagePath = (id: ImageId) => `dev-seed/${id}.webp`;

/** What `upload.ts` recorded for a clip: Bunny's video id and its encode results. */
export interface UploadedClip {
  /** Bunny's video id (GUID), stored as the story's media[*].bunnyVideoId. */
  videoId: string;
  /** `<videoId>/<thumbnail file>` on the Stream CDN; video only. */
  thumbnailPath?: string;
  width?: number;
  height?: number;
  durationSeconds: number;
}

/** What `upload.ts` recorded for an image. */
export interface UploadedImage {
  path: string;
  width: number;
  height: number;
}

/** bunny-media.json: written by upload.ts, committed, read by the seed. Never holds a key. */
export interface BunnyMedia {
  /** The dev Stream library the clips were uploaded to. */
  libraryId?: string;
  clips: Partial<Record<ClipId, UploadedClip>>;
  images: Partial<Record<ImageId, UploadedImage>>;
}

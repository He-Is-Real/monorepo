import { Global, Logger, Module } from '@nestjs/common';
import { SecretsService } from '@heisreal/secrets';
import { linkExpiry, signCdnUrl, signEmbedUrl } from './bunny-tokens';

/**
 * Signed, expiring media links for published stories (D52). api-public-read reads only
 * `publicStory`, so whatever it signs is published. Identifiers come from the environment
 * (OpenTofu, gcp root); the two keys only from Secret Manager, read once at startup and never
 * logged. Without any `BUNNY_*` variable, signing is off and every URL is `null`.
 */
export interface MediaConfig {
  streamLibraryId: string;
  /** The Stream library's pull zone (thumbnails), e.g. `vz-….b-cdn.net`. */
  streamCdnHost: string;
  /** The `images` pull zone in front of the storage zone. */
  imagesCdnHost: string;
  /** Secret Manager ids of the keys (bunny root, `modules/bunny/secrets.tf`). */
  streamTokenKeySecret: string;
  imagesTokenKeySecret: string;
}

const VARIABLES = {
  streamLibraryId: 'BUNNY_STREAM_LIBRARY_ID',
  streamCdnHost: 'BUNNY_STREAM_CDN_HOST',
  imagesCdnHost: 'BUNNY_IMAGES_CDN_HOST',
  streamTokenKeySecret: 'BUNNY_STREAM_TOKEN_KEY_SECRET',
  imagesTokenKeySecret: 'BUNNY_IMAGES_TOKEN_KEY_SECRET',
} as const satisfies Record<keyof MediaConfig, string>;

const HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const FORMATS: Record<keyof MediaConfig, RegExp> = {
  streamLibraryId: /^[0-9]{1,12}$/,
  streamCdnHost: HOST,
  imagesCdnHost: HOST,
  streamTokenKeySecret: /^[A-Za-z0-9_-]{1,255}$/,
  imagesTokenKeySecret: /^[A-Za-z0-9_-]{1,255}$/,
};

type Env = Record<string, string | undefined>;

/** Bunny's video ids are GUIDs: only those name an original's folder. */
const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All five variables, or none (signing off). Anything in between fails startup. */
export function mediaConfigFromEnv(env: Env = process.env): MediaConfig | null {
  const keys = Object.keys(VARIABLES) as (keyof MediaConfig)[];
  const value = (k: keyof MediaConfig) => env[VARIABLES[k]]?.trim() ?? '';
  const missing = keys.filter((k) => value(k) === '');
  if (missing.length === keys.length) return null;
  if (missing.length > 0) {
    throw new Error(
      `Media signing needs every BUNNY_* variable or none; missing ${missing.map((k) => VARIABLES[k]).join(', ')}`,
    );
  }
  const malformed = keys.filter((k) => !FORMATS[k].test(value(k)));
  if (malformed.length > 0) {
    throw new Error(
      `Malformed ${malformed.map((k) => VARIABLES[k]).join(', ')}`,
    );
  }
  return Object.fromEntries(
    keys.map((k) => [k, value(k)]),
  ) as unknown as MediaConfig;
}

interface Signing {
  config: MediaConfig;
  streamKey: string;
  imagesKey: string;
}

/** Inject `MediaUrls` (from `MediaUrlsModule`) wherever a response carries media. */
export class MediaUrls {
  constructor(
    private readonly signing: Signing | null,
    private readonly now: () => number = Date.now,
    private readonly expiry: (nowMs: number) => number = linkExpiry,
  ) {}

  /**
   * The same signer, for links that all expire `seconds` from now, not rounded to the hour: for one
   * person's own copy ("Download my data": 7 days), never for cached public answers.
   */
  expiringIn(seconds: number): MediaUrls {
    const at = Math.ceil(this.now() / 1000) + seconds;
    return new MediaUrls(this.signing, this.now, () => at);
  }

  /** When a link signed now stops working, or `null` while signing is off (every URL is null). */
  linksExpireAt(): string | null {
    return this.signing
      ? new Date(this.expiry(this.now()) * 1000).toISOString()
      : null;
  }

  /** The Bunny Stream player (video and audio). */
  playbackUrl(videoId: string | null | undefined): string | null {
    const s = this.signing;
    if (!s || !videoId) return null;
    return signEmbedUrl(
      s.config.streamLibraryId,
      videoId,
      s.streamKey,
      this.expiry(this.now()),
    );
  }

  /**
   * A Stream thumbnail (`media[*].thumbnailPath`, e.g. `<videoId>/thumbnail.jpg`). Signed only
   * as a file directly in the item's own video folder, so a story can't get another video's
   * thumbnail signed by naming its path.
   */
  thumbnailUrl(
    videoId: string | null | undefined,
    path: string | null | undefined,
  ): string | null {
    const s = this.signing;
    if (!s || !videoId || !path) return null;
    const [folder, file, ...rest] = path.split('/');
    if (folder !== videoId || !file || rest.length > 0) return null;
    return signCdnUrl(
      s.config.streamCdnHost,
      path,
      s.streamKey,
      this.expiry(this.now()),
    );
  }

  /**
   * A video's or audio file's original upload, as Bunny kept it (`<videoId>/original` on the
   * Stream CDN; Bunny's "Storage structure"), signed like its other files. Only for the person's
   * own copy ("Download my data", O2 B); exists only if Bunny kept it (`hasOriginal`).
   */
  originalUrl(videoId: string | null | undefined): string | null {
    const s = this.signing;
    if (!s || !videoId || !VIDEO_ID.test(videoId)) return null;
    return signCdnUrl(
      s.config.streamCdnHost,
      `${videoId}/original`,
      s.streamKey,
      this.expiry(this.now()),
    );
  }

  /** A story image (`image.path` in the storage zone). */
  imageUrl(path: string | null | undefined): string | null {
    const s = this.signing;
    if (!s || !path) return null;
    return signCdnUrl(
      s.config.imagesCdnHost,
      path,
      s.imagesKey,
      this.expiry(this.now()),
    );
  }
}

async function readKey(
  secrets: Pick<SecretsService, 'get'>,
  id: string,
): Promise<string> {
  const key = (await secrets.get(id)).trim();
  if (key === '') throw new Error(`Secret ${id} is empty`);
  return key;
}

export async function createMediaUrls(
  secrets: Pick<SecretsService, 'get'>,
  env: Env = process.env,
  now: () => number = Date.now,
): Promise<MediaUrls> {
  const logger = new Logger('MediaUrls');
  const config = mediaConfigFromEnv(env);
  if (!config) {
    logger.warn(
      'Media signing is off (no BUNNY_* variables): media URLs are null',
    );
    return new MediaUrls(null, now);
  }
  const [streamKey, imagesKey] = await Promise.all([
    readKey(secrets, config.streamTokenKeySecret),
    readKey(secrets, config.imagesTokenKeySecret),
  ]);
  logger.log(
    `Media signing on: Stream library ${config.streamLibraryId}, ${config.streamCdnHost}, ${config.imagesCdnHost}`,
  );
  return new MediaUrls({ config, streamKey, imagesKey }, now);
}

/** Provides {@link MediaUrls}. Requires `SecretsModule` (global) in the application. */
@Global()
@Module({
  providers: [
    {
      provide: MediaUrls,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => createMediaUrls(secrets),
    },
  ],
  exports: [MediaUrls],
})
export class MediaUrlsModule {}

import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ProblemException } from '@heisreal/http';
import { MediaUrls } from '@heisreal/story-cards';
import type { Response } from 'express';
import { representationETag, sendCached } from '../caching';
import { refuseQueryParameters } from '../stories/browse.query';

/**
 * Videos that are part of the site itself, not stories: each key a page asks for, and the
 * variable OpenTofu sets with its Bunny video GUID (gcp root, `site_videos`; the video sits in the
 * library's `site-assets` collection, tools/scripts/site-asset-upload.mjs). Only these keys are
 * ever signed: a visitor can't name a video. Adding one is an entry here, in OpenTofu's
 * allowed keys (modules/gcp, `site_videos`) and in the contract's `SiteVideoKey`.
 */
export const SITE_VIDEO_KEYS = {
  'founder-intro': 'SITE_VIDEO_FOUNDER_INTRO',
  'next-steps': 'SITE_VIDEO_NEXT_STEPS',
} as const;

export type SiteVideoKey = keyof typeof SITE_VIDEO_KEYS;
/** Key → Bunny video GUID, for the keys that have one. */
export type SiteVideos = ReadonlyMap<SiteVideoKey, string>;
export const SITE_VIDEOS = Symbol('SITE_VIDEOS');

const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The configured site videos. A malformed GUID fails startup, like the media settings. */
export function siteVideosFromEnv(
  env: Record<string, string | undefined> = process.env,
): SiteVideos {
  const videos = new Map<SiteVideoKey, string>();
  for (const [key, name] of Object.entries(SITE_VIDEO_KEYS)) {
    const guid = env[name]?.trim() ?? '';
    if (guid === '') continue;
    if (!VIDEO_ID.test(guid)) throw new Error(`Malformed ${name}`);
    videos.set(key as SiteVideoKey, guid);
  }
  return videos;
}

const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    'There’s no such site video.',
  );

/**
 * api-public-read.yaml, tag Site: getSiteVideo. A signed, expiring player link for one site
 * video (D52's token auth, the same key and 6–7 hour links as stories). Public caching, when
 * turned on, keeps it at most 6 minutes, well inside the link's life.
 */
@Controller('v1/site-videos')
export class SiteVideosController {
  constructor(
    @Inject(SITE_VIDEOS) private readonly videos: SiteVideos,
    private readonly media: MediaUrls,
  ) {}

  @Get(':key')
  getSiteVideo(
    @Param('key') key: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    refuseQueryParameters(query);
    // Own keys only (`in` would also match Object.prototype's names).
    if (!Object.hasOwn(SITE_VIDEO_KEYS, key)) throw notFound();
    const playbackUrl = this.media.playbackUrl(
      this.videos.get(key as SiteVideoKey),
    );
    if (!playbackUrl) throw notFound();
    const expires = Number(new URL(playbackUrl).searchParams.get('expires'));
    const body = {
      key,
      playbackUrl,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
    return sendCached(res, ifNoneMatch, body, representationETag(body));
  }
}

@Module({
  controllers: [SiteVideosController],
  providers: [{ provide: SITE_VIDEOS, useFactory: () => siteVideosFromEnv() }],
})
export class SiteVideosModule {}

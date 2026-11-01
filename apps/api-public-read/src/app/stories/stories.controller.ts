import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Res,
} from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import {
  clipPicture,
  MediaUrls,
  type StoredImage,
  type StoredMedia,
} from '@heisreal/story-cards';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { publicCacheControl, representationETag, sendCached } from '../caching';
import { BrowseController } from './browse.controller';
import { isSlug, notFound } from './slug';

/** `components.yaml#/components/schemas/StoryPublic`. */
export interface StoryPublic {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string | null;
  bylineName: string | null;
  primaryFormat: 'video' | 'audio' | 'written';
  media: MediaPlayback[];
  image: StoryImage | null;
  themes: { id: string; name: string }[];
  publishedAt: string;
  updatedAt?: string;
  version: number;
}

export interface MediaPlayback {
  format: 'video' | 'audio';
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  captionsUrl: string | null;
  durationSeconds: number | null;
}

/** `components.yaml#/components/schemas/StoryImage` (D53). */
export interface StoryImage {
  url: string | null;
  width: number;
  height: number;
  alt: string | null;
}

// Only the read model (D26): never `story`, which this service's login can't see anyway (D13).
const BY_SLUG = `
  SELECT record::id(id) AS id, slug, title, description, body, bylineName, primaryFormat,
    media, image, durationSeconds, publishedAt, updatedAt, version,
    (SELECT record::id(id) AS id, name FROM theme
      WHERE id IN $parent.themeRefs ORDER BY name) AS themes
  FROM publicStory WHERE slug = $slug LIMIT 1;
  SELECT VALUE slug FROM publicStory WHERE slugHistory CONTAINS $slug LIMIT 1;`;

type Row = Omit<StoryPublic, 'body' | 'bylineName' | 'media' | 'image'> & {
  body?: string;
  bylineName?: string;
  media?: StoredMedia[];
  image?: StoredImage;
  durationSeconds?: number;
};

function toPublic(row: Row, urls: MediaUrls): StoryPublic {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    body: row.body ?? null,
    bylineName: row.bylineName ?? null,
    primaryFormat: row.primaryFormat,
    // D52: signed, expiring links (MediaUrls), never bare ids or storage paths. Only
    // `publicStory` is read, so only published media is signed. Captions come with M7.
    // The picture shown before playing: the person's own image wins over Bunny's thumbnail
    // (clipPicture, M2 plan PR 10). A video's box keeps the video's size; an audio file's is its
    // picture's (Joel, 2026-10-24).
    media: (row.media ?? []).map((m) => {
      const picture = clipPicture(m, row.image, urls);
      return {
        format: m.format,
        playbackUrl: urls.playbackUrl(m.bunnyVideoId),
        thumbnailUrl: picture.url,
        width: (m.format === 'audio' ? picture.width : m.width) ?? null,
        height: (m.format === 'audio' ? picture.height : m.height) ?? null,
        captionsUrl: null,
        // One clip per story (D53); the read model computes its duration from the story.
        durationSeconds: row.durationSeconds ?? null,
      };
    }),
    image: row.image
      ? {
          url: urls.imageUrl(row.image.path),
          width: row.image.width,
          height: row.image.height,
          alt: row.image.alt ?? null,
        }
      : null,
    themes: row.themes ?? [],
    publishedAt: row.publishedAt,
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    version: row.version,
  };
}

/** api-public-read.yaml, tag Stories: `GET /v1/stories/{slug}` (M0 task 0.9). */
@Controller('v1/stories')
export class StoriesController {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(MediaUrls) private readonly urls: MediaUrls,
  ) {}

  @Get(':slug')
  async getStoryBySlug(
    @Param('slug') slug: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StoryPublic | undefined> {
    if (!isSlug(slug)) throw notFound();
    const [current, previous] = (await runQuery(this.db, BY_SLUG, {
      slug,
    })) as [Row[], string[]];
    const row = current[0];
    if (!row) {
      const moved = previous[0];
      if (!moved) throw notFound();
      // D30: an old slug answers 301 to the current one.
      res
        .status(HttpStatus.MOVED_PERMANENTLY)
        .setHeader('Location', `/v1/stories/${moved}`)
        .setHeader('Cache-Control', publicCacheControl());
      return undefined;
    }
    const story = toPublic(row, this.urls);
    return sendCached(res, ifNoneMatch, story, representationETag(story));
  }
}

// BrowseController first: `GET /v1/stories` and `…/{slug}/related` before `…/{slug}`.
@Module({ controllers: [BrowseController, StoriesController] })
export class StoriesModule {}

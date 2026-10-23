import { createHash } from 'node:crypto';
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
import { ProblemException } from '@heisreal/http';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { MediaUrls } from '../media/media-urls';

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
  tags: { slug: string; name: string; category: string; version: number }[];
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

/** Public queries (D30): shared caches may keep a story for a minute. */
export const CACHE_PUBLIC = 'public, max-age=60, stale-while-revalidate=300';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Only the read model (D26): never `story`, which this service's login can't see anyway (D13).
const BY_SLUG = `
  SELECT record::id(id) AS id, slug, title, description, body, bylineName, primaryFormat,
    media, image, publishedAt, updatedAt, version,
    (SELECT record::id(id) AS slug, name, category, version FROM tag
      WHERE id IN $parent.tagRefs ORDER BY slug) AS tags
  FROM publicStory WHERE slug = $slug LIMIT 1;
  SELECT VALUE slug FROM publicStory WHERE slugHistory CONTAINS $slug LIMIT 1;`;

type Row = Omit<StoryPublic, 'body' | 'bylineName' | 'media' | 'image'> & {
  body?: string;
  bylineName?: string;
  media?: {
    format: 'video' | 'audio';
    bunnyVideoId?: string;
    thumbnailPath?: string;
    width?: number;
    height?: number;
  }[];
  image?: { path: string; width: number; height: number; alt?: string };
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
    media: (row.media ?? []).map((m) => ({
      format: m.format,
      playbackUrl: urls.playbackUrl(m.bunnyVideoId),
      thumbnailUrl: urls.thumbnailUrl(m.thumbnailPath),
      width: m.width ?? null,
      height: m.height ?? null,
      captionsUrl: null,
      durationSeconds: null,
    })),
    image: row.image
      ? {
          url: urls.imageUrl(row.image.path),
          width: row.image.width,
          height: row.image.height,
          alt: row.image.alt ?? null,
        }
      : null,
    tags: row.tags ?? [],
    publishedAt: row.publishedAt,
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    version: row.version,
  };
}

const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'story_not_found',
    'Story not found',
  );

/**
 * A strong validator of exactly what's sent: a hash of the JSON body, which is what Nest
 * serialises. Not the story's `version` alone, because the response embeds its tags by
 * reference (#45 review): renaming a tag changes the body, so the ETag must change too.
 */
export function representationETag(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
}

/** `If-None-Match` matches a strong ETag (also `*` and lists; weak comparison, RFC 9110). */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
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
    if (!SLUG.test(slug) || slug.length > 200) throw notFound();
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
        .setHeader('Cache-Control', CACHE_PUBLIC);
      return undefined;
    }
    const story = toPublic(row, this.urls);
    const etag = representationETag(story);
    res.setHeader('ETag', etag).setHeader('Cache-Control', CACHE_PUBLIC);
    if (matches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return story;
  }
}

@Module({ controllers: [StoriesController] })
export class StoriesModule {}

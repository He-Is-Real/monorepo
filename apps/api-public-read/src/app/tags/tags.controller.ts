import {
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Query,
  Res,
} from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { collectionETag, sendCached } from '../caching';
import { refuseQueryParameters } from '../stories/browse.query';
import type { TagRef } from '../stories/story-summary';

/** The order browse groups tags in. */
export const CATEGORIES = ['theme', 'journey', 'emotion'] as const;

/**
 * D63: whether a published story uses the tag whose slug `slug` names. One indexed match at most
 * (`publicStory_tag_slugs`), so the cost doesn't grow with the stories.
 */
export const tagInUse = (slug: string) =>
  `SELECT VALUE id FROM publicStory WHERE tagSlugs CONTAINS ${slug} LIMIT 1`;

// D63: only tags at least one published story uses, so no tag leads to an empty page; a tag
// comes back as soon as a published story uses it. One probe per tag (a few dozen). No input.
const USED_TAGS = `
  LET $tags = (SELECT record::id(id) AS slug, name, category, version FROM tag);
  RETURN $tags.filter(|$tag| array::len(${tagInUse('$tag.slug')}) > 0);`;

/**
 * api-public-read.yaml, tag Tags: listTags (M1). Reference data (D26), about 30 tags, unpaged.
 * Only tags with a published story (D63). No story counts: public responses carry no totals
 * (docs/api-conventions.md, D62).
 */
@Controller('v1/tags')
export class TagsController {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  @Get()
  async listTags(
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: TagRef[] } | undefined> {
    refuseQueryParameters(query);
    const [, tags] = (await runQuery(this.db, USED_TAGS)) as [
      unknown,
      TagRef[],
    ];
    const rank = (t: TagRef) => CATEGORIES.indexOf(t.category as never);
    const body = {
      data: [...tags].sort(
        (a, b) =>
          rank(a) - rank(b) ||
          a.name.localeCompare(b.name, 'en') ||
          a.slug.localeCompare(b.slug),
      ),
    };
    return sendCached(res, ifNoneMatch, body, collectionETag(body));
  }
}

@Module({ controllers: [TagsController] })
export class TagsModule {}

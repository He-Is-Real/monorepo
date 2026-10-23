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

const ALL_TAGS = `SELECT record::id(id) AS slug, name, category, version FROM tag`;

/**
 * api-public-read.yaml, tag Tags: listTags (M1). Reference data (D26), about 30 tags, unpaged.
 * No story counts: public responses carry no totals (docs/api-conventions.md).
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
    const [tags] = (await runQuery(this.db, ALL_TAGS)) as [TagRef[]];
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

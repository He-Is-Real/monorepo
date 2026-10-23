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
 * D63: one probe per tag for whether a published story uses it, each a top-level statement with
 * the slug bound ($t0, $t1, ...), at most one match through `publicStory_tag_slugs`. Only top
 * level: inside a closure 3.2.4 iterates the whole table instead (Codex, #67).
 */
export function tagProbes(slugs: string[]): {
  statements: string[];
  vars: Record<string, string>;
} {
  return {
    statements: slugs.map(
      (_, i) =>
        `SELECT VALUE id FROM publicStory WHERE tagSlugs CONTAINS $t${i} LIMIT 1`,
    ),
    vars: Object.fromEntries(slugs.map((slug, i) => [`t${i}`, slug])),
  };
}

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
    // D63: only tags a published story uses, so none leads to an empty page; a tag comes back
    // as soon as a published story uses it. A few dozen tags, so a few dozen indexed probes.
    const [all] = (await runQuery(this.db, ALL_TAGS)) as [TagRef[]];
    const { statements, vars } = tagProbes(all.map((t) => t.slug));
    const found = statements.length
      ? ((await runQuery(this.db, statements.join(';\n'), vars)) as unknown[][])
      : [];
    const tags = all.filter((_, i) => found[i].length > 0);
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

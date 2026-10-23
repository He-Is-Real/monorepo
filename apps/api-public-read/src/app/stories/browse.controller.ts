import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { collectionETag, publicCacheControl, sendCached } from '../caching';
import { MediaUrls } from '../media/media-urls';
import {
  type BrowseQuery,
  encodeCursor,
  parseBrowseQuery,
  refuseQueryParameters,
} from './browse.query';
import { isSlug, notFound } from './slug';
import {
  type StorySummary,
  SUMMARY_FIELDS,
  type SummaryRow,
  toSummary,
} from './story-summary';

// Only the read model (D26) and tags, on the read-only login. The query text is fixed: one
// variant per sort, chosen here; every value arrives as a bound parameter.

/** Shared by every variant: the filters and the cursor's position, bound once. */
const PREAMBLE = `
  LET $tagRefs = $tags.map(|$t| type::record('tag', $t));
  LET $at = IF $after != NONE AND $sort != 'relevance' { <datetime> $after.key };
  LET $afterId = IF $after != NONE { type::record('publicStory', $after.id) };`;
const FILTERS = `($format = NONE OR primaryFormat = $format) AND tagRefs CONTAINSALL $tagRefs`;
const SEARCH = `searchText @1@ $q`;

/** Newest or oldest first; `id` breaks ties, so the order is total and pages never overlap. */
const byDate = (direction: 'DESC' | 'ASC', search: boolean) => {
  const past = direction === 'DESC' ? '<' : '>';
  return `${PREAMBLE}
  SELECT ${SUMMARY_FIELDS} FROM publicStory
  WHERE ${FILTERS}${search ? ` AND ${SEARCH}` : ''}
    AND ($at = NONE OR publishedAt ${past} $at OR (publishedAt = $at AND id ${past} $afterId))
  ORDER BY publishedAt ${direction}, id ${direction} LIMIT $take;`;
};

/** Best BM25 score first, then id. */
const BY_RELEVANCE = `${PREAMBLE}
  SELECT * FROM (
    SELECT ${SUMMARY_FIELDS}, search::score(1) AS score FROM publicStory
    WHERE ${FILTERS} AND searchText @1@ $q
  )
  WHERE $after = NONE OR score < $after.key OR (score = $after.key AND id < $after.id)
  ORDER BY score DESC, id DESC LIMIT $take;`;

const QUERIES = {
  latest: byDate('DESC', false),
  oldest: byDate('ASC', false),
  searchLatest: byDate('DESC', true),
  searchOldest: byDate('ASC', true),
  relevance: BY_RELEVANCE,
};

/** The sidebar's related stories (the mockups show three). */
export const RELATED_COUNT = 3;

const RELATED = `
  LET $s = (SELECT id, tagRefs FROM ONLY publicStory WHERE slug = $slug LIMIT 1);
  RETURN $s != NONE;
  SELECT VALUE slug FROM publicStory WHERE $s = NONE AND slugHistory CONTAINS $slug LIMIT 1;
  IF $s = NONE { [] } ELSE {
    SELECT ${SUMMARY_FIELDS}, array::len(array::intersect(tagRefs, $s.tagRefs)) AS shared
    FROM publicStory WHERE id != $s.id
    ORDER BY shared DESC, publishedAt DESC, id DESC LIMIT ${RELATED_COUNT}
  };`;

type Row = SummaryRow & { score?: number };

export interface StoryPage {
  data: StorySummary[];
  nextCursor: string | null;
}

/** api-public-read.yaml, tag Stories: browseStories and getRelatedStories (M1). */
@Controller('v1/stories')
export class BrowseController {
  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    @Inject(MediaUrls) private readonly urls: MediaUrls,
  ) {}

  @Get()
  async browseStories(
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StoryPage | undefined> {
    const browse = parseBrowseQuery(query);
    const results = await runQuery(this.db, queryFor(browse), {
      q: browse.q ?? undefined,
      tags: browse.tags,
      format: browse.format ?? undefined,
      sort: browse.sort,
      after: browse.after ?? undefined,
      take: browse.limit + 1,
    });
    const rows = (results.at(-1) ?? []) as Row[];
    const more = rows.length > browse.limit;
    const shown = rows.slice(0, browse.limit);
    const last = shown.at(-1);
    const page: StoryPage = {
      data: shown.map((row) => toSummary(row, this.urls)),
      nextCursor:
        more && last
          ? encodeCursor(browse, {
              key:
                browse.sort === 'relevance' ? (last.score ?? 0) : last.cursorAt,
              id: last.id,
            })
          : null,
    };
    return sendCached(res, ifNoneMatch, page, collectionETag(page));
  }

  @Get(':slug/related')
  async getRelatedStories(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: StorySummary[] } | undefined> {
    refuseQueryParameters(query);
    if (!isSlug(slug)) throw notFound();
    const results = await runQuery(this.db, RELATED, { slug });
    const [found, previous, related] = results.slice(-3) as [
      boolean,
      string[],
      Row[],
    ];
    if (!found) {
      const moved = previous[0];
      if (!moved) throw notFound();
      // D30: an old slug answers 301 to the current one.
      res
        .status(HttpStatus.MOVED_PERMANENTLY)
        .setHeader('Location', `/v1/stories/${moved}/related`)
        .setHeader('Cache-Control', publicCacheControl());
      return undefined;
    }
    const body = { data: related.map((row) => toSummary(row, this.urls)) };
    return sendCached(res, ifNoneMatch, body, collectionETag(body));
  }
}

function queryFor(browse: BrowseQuery): string {
  if (browse.sort === 'relevance') return QUERIES.relevance;
  if (browse.q)
    return browse.sort === 'oldest'
      ? QUERIES.searchOldest
      : QUERIES.searchLatest;
  return browse.sort === 'oldest' ? QUERIES.oldest : QUERIES.latest;
}

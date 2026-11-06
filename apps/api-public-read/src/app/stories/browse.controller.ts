import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import {
  MediaUrls,
  type StorySummary,
  SUMMARY_FIELDS,
  type SummaryRow,
  toSummary,
} from '@heisreal/story-cards';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { collectionETag, publicCacheControl, withETag } from '../caching';
import {
  type BrowseQuery,
  encodeCursor,
  parseBrowseQuery,
  refuseQueryParameters,
} from './browse.query';
import { isSlug, notFound } from './slug';

// Published stories and themes, on the read-only login. Its rules let it read approved stories'
// published fields only (R11); every query also asks for approved stories itself, so a rule
// change can't widen what it lists. The query text is fixed: one variant per sort, chosen here;
// every value arrives as a bound parameter.

/** Shared by every variant: the filters and the cursor's position, bound once. */
const PREAMBLE = `
  LET $th = IF $theme != NONE AND record::exists(type::record('theme', $theme)) { $theme };
  LET $at = IF $after != NONE AND $sort != 'relevance' { <datetime> $after.key };
  LET $afterId = IF $after != NONE { type::record('story', $after.id) };`;
/**
 * Search (option A, Joel 2026-11-06): the published stories whose words match, with their BM25
 * score, from storySearch, which holds published stories only, so drafts never count towards a
 * score. Only in the search variants.
 */
const HITS = `
  LET $hits = SELECT story, search::score(1) AS score FROM storySearch WHERE text @1@ $q;`;
// An unknown theme id ($th NONE) filters nothing (themes plan v3, A8). themeIds, not themeRefs:
// 3.2.4's CONTAINS over an element index on record links finds nothing (docs/db-permissions.md, "SurrealDB 3.2.4 gotchas").
const FILTERS = `currentStatus.status = 'approved' AND ($format = NONE OR primaryFormat = $format) AND ($th = NONE OR themeIds CONTAINS $th)`;

/**
 * Newest or oldest first by publish date (the current approved status entry's publishedAt);
 * the story's id breaks ties, so the order is total, pages never overlap, and the "load more"
 * cursor carries both. One row per story (R11 item 5): every row the query reads counts towards
 * the page, so a page is full unless the list has ended.
 */
const byDate = (direction: 'DESC' | 'ASC', search: boolean) => {
  const past = direction === 'DESC' ? '<' : '>';
  return `${PREAMBLE}${search ? HITS : ''}
  SELECT ${SUMMARY_FIELDS} FROM ${search ? '$hits.story' : 'story'}
  WHERE ${FILTERS}
    AND ($at = NONE OR currentStatus.publishedAt ${past} $at
      OR (currentStatus.publishedAt = $at AND id ${past} $afterId))
  ORDER BY publishedAt ${direction}, id ${direction} LIMIT $take;`;
};

/** Best BM25 score first, then id. */
const BY_RELEVANCE = `${PREAMBLE}${HITS}
  LET $scores = object::from_entries($hits.map(|$h| [record::id($h.story), $h.score]));
  SELECT * FROM (
    SELECT ${SUMMARY_FIELDS}, $scores[record::id(id)] AS score FROM $hits.story
    WHERE ${FILTERS}
  )
  WHERE $after = NONE OR score < $after.key OR (score = $after.key AND id < $after.id)
  ORDER BY score DESC, id DESC LIMIT $take;`;

/** Cards for these ids (`id=`), the public ones only, newest first; never more than asked. */
const BY_IDS = `
  LET $refs = $ids.map(|$i| type::record('story', $i));
  SELECT ${SUMMARY_FIELDS} FROM $refs WHERE currentStatus.status = 'approved'
  ORDER BY publishedAt DESC, id DESC;`;

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
  LET $s = (SELECT id, themeRefs FROM ONLY story
    WHERE slug = $slug AND currentStatus.status = 'approved' LIMIT 1);
  RETURN $s != NONE;
  SELECT VALUE slug FROM story
    WHERE $s = NONE AND slugHistory CONTAINS $slug AND currentStatus.status = 'approved' LIMIT 1;
  IF $s = NONE { [] } ELSE {
    SELECT ${SUMMARY_FIELDS}, array::len(array::intersect(themeRefs, $s.themeRefs)) AS shared
    FROM story WHERE id != $s.id AND currentStatus.status = 'approved'
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<StoryPage | undefined> {
    const browse = parseBrowseQuery(query);
    if (browse.ids) {
      const results = await runQuery(this.db, BY_IDS, { ids: browse.ids });
      const rows = (results.at(-1) ?? []) as Row[];
      const page: StoryPage = {
        data: rows.map((row) => toSummary(row, this.urls)),
        nextCursor: null,
      };
      return withETag(res, page, collectionETag(page));
    }
    const results = await runQuery(this.db, queryFor(browse), {
      q: browse.q ?? undefined,
      theme: browse.theme ?? undefined,
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
    return withETag(res, page, collectionETag(page));
  }

  @Get(':slug/related')
  async getRelatedStories(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
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
    return withETag(res, body, collectionETag(body));
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

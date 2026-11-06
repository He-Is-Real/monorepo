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
// An unknown theme id ($th NONE) filters nothing (themes plan v3, A8). themeIds, not themeRefs:
// 3.2.4's CONTAINS over an element index on record links finds nothing (docs/db-permissions.md, "SurrealDB 3.2.4 gotchas").

/**
 * Newest or oldest first by publish date; the story's id breaks ties, so the order is total,
 * pages never overlap, and the "load more" cursor carries both (publishedAt, id).
 *
 * Read from the status log's (status, publishedAt) index in that order (current approved entries
 * only), filtered by the story's format and theme, until a page is full (3.2.4 stops the index
 * scan at the LIMIT; local scale test, B2): never the whole story table. The cursor is a range
 * on publishedAt (inclusive; the cursor's own story and those before it at the same instant are
 * left out), and the page's last instant is read whole, so ties sort by id across pages too. Then
 * the story cards for that one page.
 */
const LOG_FILTERS = `status = 'approved' AND story.currentStatus = id
    AND ($format = NONE OR story.primaryFormat = $format)
    AND ($th = NONE OR story.themeIds CONTAINS $th)`;
const byDate = (direction: 'DESC' | 'ASC') => {
  const past = direction === 'DESC' ? '<' : '>';
  const edge =
    direction === 'DESC'
      ? "d'9999-12-31T00:00:00Z'"
      : "d'0001-01-01T00:00:00Z'";
  const after = `($afterId = NONE OR publishedAt != $at OR story ${past} $afterId)`;
  return `${PREAMBLE}
  LET $from = $at ?? ${edge};
  LET $batch = SELECT story, publishedAt FROM storyStatusLog
    WHERE ${LOG_FILTERS} AND publishedAt ${past}= $from AND ${after}
    ORDER BY publishedAt ${direction} LIMIT $take;
  LET $edgeAt = IF array::len($batch) = $take { array::last($batch).publishedAt };
  -- (NONE when the batch isn't full: no row has that publishedAt.)
  LET $ties = SELECT story, publishedAt FROM storyStatusLog
    WHERE ${LOG_FILTERS} AND publishedAt = $edgeAt AND ${after};
  LET $page = SELECT * FROM array::union($batch, $ties)
    ORDER BY publishedAt ${direction}, story ${direction} LIMIT $take;
  SELECT ${SUMMARY_FIELDS} FROM $page.story WHERE currentStatus.status = 'approved'
  ORDER BY publishedAt ${direction}, id ${direction};`;
};

/**
 * Search (option A, Joel 2026-11-06): storySearch holds published stories only, so drafts never
 * count towards a score; it also holds each story's format, theme ids and publishedAt (Joel,
 * 2026-11-06), so search filters, scores, sorts and pages inside it, and builds story cards for
 * one page only.
 */
const SEARCH_FILTERS = `searchText @1@ $q AND ($format = NONE OR primaryFormat = $format) AND ($th = NONE OR themeIds CONTAINS $th)`;
const searchByDate = (direction: 'DESC' | 'ASC') => {
  const past = direction === 'DESC' ? '<' : '>';
  return `${PREAMBLE}
  LET $page = SELECT story, publishedAt FROM storySearch
    WHERE ${SEARCH_FILTERS}
      AND ($at = NONE OR publishedAt ${past} $at
        OR (publishedAt = $at AND story ${past} $afterId))
    ORDER BY publishedAt ${direction}, story ${direction} LIMIT $take;
  SELECT ${SUMMARY_FIELDS} FROM $page.story WHERE currentStatus.status = 'approved'
  ORDER BY publishedAt ${direction}, id ${direction};`;
};

/** Best BM25 score first, then id. */
const BY_RELEVANCE = `${PREAMBLE}
  LET $page = SELECT * FROM (
    SELECT story, search::score(1) AS score FROM storySearch WHERE ${SEARCH_FILTERS}
  )
  WHERE $after = NONE OR score < $after.key OR (score = $after.key AND story < $afterId)
  ORDER BY score DESC, story DESC LIMIT $take;
  LET $scores = object::from_entries($page.map(|$h| [record::id($h.story), $h.score]));
  SELECT ${SUMMARY_FIELDS}, $scores[record::id(id)] AS score FROM $page.story
  WHERE currentStatus.status = 'approved'
  ORDER BY score DESC, id DESC;`;

/** Cards for these ids (`id=`), the public ones only, newest first; never more than asked. */
const BY_IDS = `
  LET $refs = $ids.map(|$i| type::record('story', $i));
  SELECT ${SUMMARY_FIELDS} FROM $refs WHERE currentStatus.status = 'approved'
  ORDER BY publishedAt DESC, id DESC;`;

const QUERIES = {
  latest: byDate('DESC'),
  oldest: byDate('ASC'),
  searchLatest: searchByDate('DESC'),
  searchOldest: searchByDate('ASC'),
  relevance: BY_RELEVANCE,
};

/** The sidebar's related stories (the mockups show three). */
export const RELATED_COUNT = 3;

/**
 * Most shared themes first, then newest, then id. Without reading every story: the stories that
 * share a theme come from the story_theme_ids index, with how many they share; all of
 * those above the level that fills the sidebar are in, and that level's newest come from its
 * stories directly (a small level) or from the status log's publishedAt index, newest first,
 * until enough are found (a large one; its last instant read whole, for ties). With fewer than
 * enough sharing a theme, the newest of the rest fill it, the same way.
 */
const RELATED = `
  LET $s = (SELECT id, themeIds FROM ONLY story
    WHERE slug = $slug AND currentStatus.status = 'approved' LIMIT 1);
  RETURN $s != NONE;
  SELECT VALUE slug FROM story
    WHERE $s = NONE AND slugHistory CONTAINS $slug AND currentStatus.status = 'approved' LIMIT 1;
  -- One index scan (story_theme_ids) for every story sharing a theme, with how many it shares.
  -- (Not one query per theme in a closure: 3.2.4 uses no index there.)
  LET $g = array::flatten([IF $s = NONE { [] } ELSE {
    (SELECT id, array::len(array::intersect(themeIds, $s.themeIds)) AS shared FROM story
      WHERE themeIds CONTAINSANY $s.themeIds AND id != $s.id AND currentStatus.status = 'approved')
  }]);
  LET $levels = array::sort::desc(array::distinct($g.shared));
  LET $filled = $levels.filter(|$l| array::len($g[WHERE shared >= $l]) >= ${RELATED_COUNT});
  LET $level = $filled[0];
  -- array::flatten: 3.2.4 answers an IF block's one-row array as the row itself.
  LET $above = array::flatten([IF $level = NONE { $g.id } ELSE { $g[WHERE shared > $level].id }]);
  LET $group = array::flatten([IF $level = NONE { [] } ELSE { $g[WHERE shared = $level].id }]);
  LET $need = ${RELATED_COUNT} - array::len($above);
  -- Fewer than enough share a theme: the newest of the rest fill the sidebar (shared: 0).
  LET $exclude = IF $s = NONE { [] } ELSE { array::concat($above, [$s.id]) };
  LET $in = |$r| IF $level = NONE { $r NOT IN $exclude } ELSE { $r IN $group };
  LET $newest = array::flatten([IF $need <= 0 { [] }
    ELSE IF $level != NONE AND array::len($group) <= 1000 {
      (SELECT VALUE id FROM (SELECT id, currentStatus.publishedAt AS p FROM $group)
        ORDER BY p DESC, id DESC LIMIT $need)
    } ELSE {
      LET $batch = (SELECT story, publishedAt FROM storyStatusLog
        WHERE status = 'approved' AND story.currentStatus = id AND $in(story)
        ORDER BY publishedAt DESC LIMIT $need);
      LET $edgeAt = array::last($batch).publishedAt;
      LET $ties = (SELECT story, publishedAt FROM storyStatusLog
        WHERE status = 'approved' AND publishedAt = $edgeAt AND story.currentStatus = id
          AND $in(story));
      (SELECT VALUE story FROM (SELECT * FROM array::union($batch, $ties)
        ORDER BY publishedAt DESC, story DESC LIMIT $need))
    }]);
  IF $s = NONE { [] } ELSE {
    SELECT ${SUMMARY_FIELDS}, array::len(array::intersect(themeIds, $s.themeIds)) AS shared
    FROM array::concat($above, $newest) WHERE currentStatus.status = 'approved'
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
    // RETURN $s != NONE, the old slug's story, then (last) the related stories.
    const [found, previous] = results.slice(1, 3) as [boolean, string[]];
    const related = (results.at(-1) ?? []) as Row[];
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

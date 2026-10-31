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
import {
  groupThemes,
  type ThemeCategory,
  THEMES_SQL,
  type ThemeRow,
} from '@heisreal/story-cards';
import type { Response } from 'express';
import type { Surreal } from 'surrealdb';
import { collectionETag, sendCached } from '../caching';
import { refuseQueryParameters } from '../stories/browse.query';

/**
 * D63: one probe per theme for whether a published story uses it, each a top-level statement
 * with the id bound ($t0, $t1, ...), at most one match through `publicStory_theme_ids`. Only top
 * level: inside a closure 3.2.4 iterates the whole table instead (Codex, #67).
 */
export function themeProbes(ids: string[]): {
  statements: string[];
  vars: Record<string, string>;
} {
  return {
    statements: ids.map(
      (_, i) =>
        `SELECT VALUE id FROM publicStory WHERE themeIds CONTAINS $t${i} LIMIT 1`,
    ),
    vars: Object.fromEntries(ids.map((id, i) => [`t${i}`, id])),
  };
}

/**
 * api-public-read.yaml, tag Themes: listThemes (themes plan v3). Reference data (D26), a few
 * dozen themes, unpaged: highlighted themes always (A14: one with no story yet still shows),
 * others only once a published story uses them (D63), grouped by category. No story counts:
 * public responses carry no totals (docs/api-conventions.md, D62).
 */
@Controller('v1/themes')
export class ThemesController {
  constructor(@Inject(SURREAL) private readonly db: Surreal) {}

  @Get()
  async listThemes(
    @Query() query: Record<string, unknown>,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: ThemeCategory[] } | undefined> {
    refuseQueryParameters(query);
    const [categories, themes] = (await runQuery(this.db, THEMES_SQL)) as [
      { id: string; name: string }[],
      ThemeRow[],
    ];
    // Only the themes that aren't highlighted need a probe.
    const others = themes.filter((t) => !t.highlighted).map((t) => t.id);
    const { statements, vars } = themeProbes(others);
    const found = statements.length
      ? ((await runQuery(this.db, statements.join(';\n'), vars)) as unknown[][])
      : [];
    const used = new Set(others.filter((_, i) => found[i].length > 0));
    const body = {
      data: groupThemes(
        categories,
        themes,
        (t) => t.highlighted || used.has(t.id),
      ),
    };
    return sendCached(res, ifNoneMatch, body, collectionETag(body));
  }
}

@Module({ controllers: [ThemesController] })
export class ThemesModule {}

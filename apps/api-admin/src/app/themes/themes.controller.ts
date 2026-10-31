import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { NoConsentRequired, PersonSessions } from '@heisreal/consent';
import {
  isTransactionConflict,
  requireWritten,
  runQuery,
  SURREAL,
} from '@heisreal/database';
import { ProblemException } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import type { Request, Response } from 'express';
import type { Surreal } from 'surrealdb';
import {
  changesFor,
  type CurrentThemes,
  OTHER,
  parsePicture,
} from './theme-picture';

/** The contract's `AdminThemes`. */
export interface AdminThemes {
  version: number;
  categories: {
    id: string;
    name: string;
    themes: {
      id: string;
      name: string;
      highlighted: boolean;
      storyCount: number;
    }[];
  }[];
}

/** Everything the page and the save read, in one query (one snapshot). */
const CURRENT_SQL = `
  RETURN (SELECT VALUE version FROM ONLY themeCatalog:current) ?? 0;
  SELECT record::id(id) AS id, name FROM themeCategory;
  SELECT record::id(id) AS id, name, highlighted, record::id(category) AS category FROM theme;`;

/**
 * SaveThemes in one transaction (A1, A2): the version still the one the page loaded, then the
 * difference, then the version + 1 naming the admin (themeCatalog_audit writes the audit row).
 * Deleting a theme takes it off every story (theme_delete); deleting a category moves any theme
 * still in it to Other (themeCategory_delete), both in this same transaction.
 */
const SAVE_SQL = `BEGIN TRANSACTION;
  LET $v = (SELECT VALUE version FROM ONLY themeCatalog:current) ?? 0;
  IF $v != $version { THROW 'themes_cmd:stale_version' };
  FOR $c IN $createCategories {
    CREATE type::record('themeCategory', $c.id) CONTENT { name: $c.name } RETURN NONE;
  };
  FOR $c IN $renameCategories {
    UPDATE type::record('themeCategory', $c.id) SET name = $c.name RETURN NONE;
  };
  FOR $t IN $createThemes {
    CREATE type::record('theme', $t.id) CONTENT {
      name: $t.name, category: type::record('themeCategory', $t.category),
      highlighted: $t.highlighted
    } RETURN NONE;
  };
  FOR $t IN $updateThemes {
    UPDATE type::record('theme', $t.id) SET name = $t.name,
      category = type::record('themeCategory', $t.category),
      highlighted = $t.highlighted RETURN NONE;
  };
  FOR $id IN $deleteThemes { DELETE type::record('theme', $id) };
  FOR $id IN $deleteCategories { DELETE type::record('themeCategory', $id) };
  UPSERT ONLY themeCatalog:current SET changedBy = $user, changedByRole = $role
    RETURN version;
  COMMIT TRANSACTION;`;

/** `If-Match: "<version>"` (D29); the themes' version starts at 0. */
function parseIfMatch(
  header: string | undefined,
): number | undefined | 'invalid' {
  if (header === undefined || header.trim() === '') return undefined;
  const m = /^"(0|[1-9]\d{0,8})"$/.exec(header.trim());
  return m ? Number(m[1]) : 'invalid';
}

/** 412 (A2): never merged; the admin reloads and makes their changes again. */
const stale = () =>
  new ProblemException(
    HttpStatus.PRECONDITION_FAILED,
    'stale_version',
    'Precondition failed',
    'Someone else changed themes. Reload to see their changes',
  );

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

/**
 * api-admin.yaml, tag Themes (themes plan v3): the categories and themes for /admin/themes, for
 * Admin and above (D1). The page holds every change and saves the finished picture at the
 * version it loaded; anything missing from the picture is deleted.
 */
@Controller('v1/admin/themes')
export class ThemesController {
  private readonly logger = new Logger(ThemesController.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    private readonly people: PersonSessions,
  ) {}

  private async current(): Promise<CurrentThemes & { version: number }> {
    const [version, categories, themes] = (await runQuery(
      this.db,
      CURRENT_SQL,
    )) as [number, CurrentThemes['categories'], CurrentThemes['themes']];
    return { version, categories, themes };
  }

  @Get()
  @RequiresRole('Admin')
  @NoConsentRequired(
    'reading the themes reads settings, nothing about the admin',
  )
  async get(@Res({ passthrough: true }) res: Response): Promise<AdminThemes> {
    const { version, categories, themes } = await this.current();
    // How many stories (any status) carry each theme, for the Save summary.
    const [refs] = (await runQuery(
      this.db,
      'SELECT VALUE themeRefs.map(|$t| record::id($t)) FROM story',
    )) as [string[][]];
    const used = new Map<string, number>();
    for (const id of refs.flat()) used.set(id, (used.get(id) ?? 0) + 1);
    // Always in full (no 304): the story counts change without the version.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', `"${version}"`);
    return {
      version,
      categories: [...categories]
        .sort(
          (a, b) =>
            Number(a.id === OTHER) - Number(b.id === OTHER) || byName(a, b),
        )
        .map((c) => ({
          id: c.id,
          name: c.name,
          themes: themes
            .filter((t) => t.category === c.id)
            .sort(byName)
            .map((t) => ({
              id: t.id,
              name: t.name,
              highlighted: t.highlighted,
              storyCount: used.get(t.id) ?? 0,
            })),
        })),
    };
  }

  /**
   * SaveThemes: the whole picture at the version read (If-Match; 412 if anyone saved since,
   * including at the same moment, which conflicts at commit; 428 if missing). Checked once
   * (names tidied, no duplicates ignoring case, Other kept), then the difference is written in
   * one transaction: all or nothing.
   */
  @Put()
  @RequiresRole('Admin')
  @NoConsentRequired(
    'changing the themes is staff work on settings, not the admin’s own data',
  )
  async save(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatchHeader?: string,
  ) {
    const version = parseIfMatch(ifMatchHeader);
    if (version === undefined) {
      throw new ProblemException(
        HttpStatus.PRECONDITION_REQUIRED,
        'if_match_required',
        'Precondition required',
        'This command needs If-Match with the themes’ version.',
      );
    }
    if (version === 'invalid') throw stale();
    const picture = parsePicture(body);
    const current = await this.current();
    if (current.version !== version) throw stale();
    const changes = changesFor(picture, current);
    const { role } = await this.people.authenticate(req);
    // Who saves: the admin's own user record, from their own database session (D27).
    const user = await this.people.run(req, async ({ user }) => user);
    let results: unknown[];
    try {
      results = (await runQuery(this.db, SAVE_SQL, {
        ...changes,
        version,
        user,
        role,
      })) as unknown[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('themes_cmd:stale_version') ||
        isTransactionConflict(err)
      ) {
        throw stale();
      }
      throw err;
    }
    const row = requireWritten<{ version: number }>(
      results[results.length - 2], // the UPSERT's; COMMIT is last
      'themes',
    );
    this.logger.log(
      `Themes saved as version ${row.version}: ${changes.deleteThemes.length} deleted, ` +
        `${changes.createThemes.length} added, ${changes.updateThemes.length} changed`,
    );
    res.setHeader('ETag', `"${row.version}"`);
    return { id: 'current', version: row.version };
  }
}

@Module({ controllers: [ThemesController] })
export class ThemesModule {}

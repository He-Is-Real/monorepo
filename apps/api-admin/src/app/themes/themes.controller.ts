import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ifNoneMatches,
  NoConsentRequired,
  PersonSessions,
  weakETag,
} from '@heisreal/consent';
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
import { parseIfMatch } from '../submission-settings/submission-settings.controller';

/** A theme's name: at most 40 characters (the schema's `tag.name`). */
export const NAME_MAX = 40;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A field error, as RFC 9457 `errors[]` (D30). */
const invalid = (pointer: string, code: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, code, message }],
  );

/** 409: another theme has this name, ignoring case (`tag_name_key`). */
const nameTaken = () =>
  new ProblemException(
    HttpStatus.CONFLICT,
    'name_taken',
    'Conflict',
    'There is already a theme with this name.',
    [
      {
        pointer: '/name',
        code: 'name_taken',
        message: 'There is already a theme with this name.',
      },
    ],
  );

const notFound = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    'There is no such theme.',
  );

const stale = (what: string) =>
  new ProblemException(
    HttpStatus.PRECONDITION_FAILED,
    'stale_version',
    'Precondition failed',
    `Someone else changed ${what} since you read it: reload, then make your change again.`,
  );

const ifMatchRequired = () =>
  new ProblemException(
    HttpStatus.PRECONDITION_REQUIRED,
    'if_match_required',
    'Precondition required',
    'This command needs If-Match with the version you read.',
  );

/** A JSON object body, or 400. */
function objectBody(body: unknown, fields: string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'invalid_body', 'A JSON object.');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !fields.includes(k));
  if (unknown) {
    throw invalid(
      `/${unknown}`,
      'unknown_field',
      'Not a field of this command.',
    );
  }
  return b;
}

/**
 * A theme's name as stored: spaces at the ends removed and runs of spaces made one, 1 to 40
 * characters, no control characters.
 */
export function parseName(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('/name', 'required', 'A name is required.');
  }
  const name = value.replace(/\s+/g, ' ').trim();
  if (name === '') throw invalid('/name', 'required', 'A name is required.');
  if ([...name].length > NAME_MAX) {
    throw invalid('/name', 'too_long', `At most ${NAME_MAX} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw invalid(
      '/name',
      'invalid_characters',
      'Letters, numbers and punctuation only.',
    );
  }
  return name;
}

/**
 * The slug (the theme's id, `tag:<slug>`, and its browse address) made from its first name:
 * lower case, accents dropped, anything else between letters and numbers a hyphen. A name with
 * no such letters (another script) gets `theme`. Never changes when the theme is renamed.
 */
export function slugOf(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/, '');
  return base || 'theme';
}

/** The slug and the next ones to try when it's taken: `hope`, `hope-2`, ... `hope-50`. */
function slugCandidates(name: string): string[] {
  const base = slugOf(name);
  return [
    base,
    ...Array.from({ length: 49 }, (_, i) => {
      const suffix = `-${i + 2}`;
      return `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    }),
  ];
}

/** The contract's `UpdateMainThemes` body. */
export function parseMainThemes(body: unknown): {
  mainThemes: string[];
  mainThemesCount: number;
} {
  const b = objectBody(body, ['mainThemes', 'mainThemesCount']);
  const count = b['mainThemesCount'];
  // Admins choose the number; there is no upper cap (Joel, 2026-10-31).
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw invalid(
      '/mainThemesCount',
      'out_of_range',
      'A whole number, 1 or more.',
    );
  }
  const list = b['mainThemes'];
  if (!Array.isArray(list)) {
    throw invalid('/mainThemes', 'required', 'A list of theme slugs.');
  }
  const seen = new Set<string>();
  list.forEach((slug, i) => {
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      throw invalid(`/mainThemes/${i}`, 'invalid_slug', 'A theme’s slug.');
    }
    if (seen.has(slug)) {
      throw invalid(`/mainThemes/${i}`, 'duplicate', 'Each theme once.');
    }
    seen.add(slug);
  });
  return { mainThemes: list as string[], mainThemesCount: count };
}

const isNameTaken = (err: unknown) =>
  /tag_name_key/.test(err instanceof Error ? err.message : String(err));

/** The user record's id (Clerk holds names, D16). */
const key = (record: unknown) => {
  const s = String(record);
  return s.slice(s.indexOf(':') + 1);
};

/**
 * api-admin.yaml, tag Themes (O5, Joel 2026-10-31): the themes people pick for their stories and
 * browse by, for Admin and above (D1), at /admin/themes. An admin adds a theme or renames one;
 * nobody can delete one (the database refuses it for every login), so stories never lose a theme
 * and, since they link it by id, show a new name everywhere at once. The main themes are an ordered
 * list (its order is their priority) and how many of them people see first. Every change names
 * the admin and their role; the database writes the audit row (tag_audit, themeSettings_check).
 */
@Controller('v1/admin')
export class ThemesController {
  private readonly logger = new Logger(ThemesController.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    private readonly people: PersonSessions,
  ) {}

  /** Who is acting: the admin's role and their own user record (D27). */
  private async actor(req: Request) {
    const { role } = await this.people.authenticate(req);
    const user = await this.people.run(req, async ({ user }) => user);
    return { role, user };
  }

  @Get('themes')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'listing themes reads reference data, nothing about the admin',
  )
  async list(
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const [rows] = (await runQuery(
      this.db,
      `SELECT record::id(id) AS slug, name, category, version FROM tag`,
    )) as [{ slug: string; name: string; category: string; version: number }[]];
    const body = {
      data: rows.sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug),
      ),
    };
    const etag = weakETag(body);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return body;
  }

  /**
   * CreateTheme: a new theme (category `theme`) from its name. The slug is made from the name,
   * with `-2`, `-3`... if another theme has it. A name another theme has, ignoring case, is `409`
   * (a natural key, so a repeated request gets 409 rather than a second theme; no
   * Idempotency-Key, docs/api-conventions.md).
   */
  @Post('themes')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'adding a theme is staff work on reference data, not the admin’s own data',
  )
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const name = parseName(objectBody(body, ['name'])['name']);
    const { role, user } = await this.actor(req);
    for (let attempt = 1; ; attempt++) {
      try {
        const results = (await runQuery(
          this.db,
          `BEGIN TRANSACTION;
           LET $slug = $candidates.filter(|$c| !record::exists(type::record('tag', $c)))[0];
           IF $slug = NONE { THROW 'theme_cmd:no_slug' };
           CREATE ONLY type::record('tag', $slug) CONTENT {
             name: $name, category: 'theme', changedBy: $user, changedByRole: $role
           } RETURN record::id(id) AS slug, version;
           COMMIT TRANSACTION;`,
          { candidates: slugCandidates(name), name, user, role },
        )) as unknown[];
        const row = requireWritten<{ slug: string; version: number }>(
          results[results.length - 2],
          'theme',
        );
        this.logger.log(`Theme ${row.slug} created`);
        res.status(HttpStatus.CREATED);
        res.setHeader('Location', `/v1/admin/themes/${row.slug}`);
        res.setHeader('ETag', `"${row.version}"`);
        return { id: row.slug, version: row.version };
      } catch (err) {
        if (isNameTaken(err)) throw nameTaken();
        // Another theme took the same slug at the same moment: try the next one.
        if (isTransactionConflict(err) && attempt < 3) continue;
        if (String(err).includes('theme_cmd:no_slug')) {
          throw invalid(
            '/name',
            'no_slug',
            'Too many themes have a name like this one.',
          );
        }
        throw err;
      }
    }
  }

  /**
   * RenameTheme: JSON Merge Patch `{ name }` at the version read (If-Match; 412 if it changed
   * since, 428 if missing). The slug stays; stories link the theme by id, so they show the new
   * name everywhere at once. A name another theme has, ignoring case, is `409`.
   */
  @Patch('themes/:slug')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'renaming a theme is staff work on reference data, not the admin’s own data',
  )
  async rename(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatchHeader?: string,
  ) {
    if (!SLUG.test(slug) || slug.length > NAME_MAX) throw notFound();
    const version = parseIfMatch(ifMatchHeader);
    if (version === undefined) throw ifMatchRequired();
    if (version === 'invalid') throw stale('the theme');
    const name = parseName(objectBody(body, ['name'])['name']);
    const { role, user } = await this.actor(req);
    let results: unknown[];
    try {
      results = (await runQuery(
        this.db,
        `BEGIN TRANSACTION;
         LET $v = (SELECT VALUE version FROM ONLY type::record('tag', $slug));
         IF $v = NONE { THROW 'theme_cmd:not_found' };
         IF $v != $version { THROW 'theme_cmd:stale_version' };
         UPDATE ONLY type::record('tag', $slug)
           MERGE { name: $name, changedBy: $user, changedByRole: $role } RETURN version;
         COMMIT TRANSACTION;`,
        { slug, version, name, user, role },
      )) as unknown[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('theme_cmd:not_found')) throw notFound();
      if (isNameTaken(err)) throw nameTaken();
      if (
        message.includes('theme_cmd:stale_version') ||
        isTransactionConflict(err)
      ) {
        throw stale('the theme');
      }
      throw err;
    }
    const row = requireWritten<{ version: number }>(
      results[results.length - 2],
      'theme',
    );
    this.logger.log(`Theme ${slug} renamed (version ${row.version})`);
    res.setHeader('ETag', `"${row.version}"`);
    return { id: slug, version: row.version };
  }

  /** The main themes in priority order (existing themes only) and how many people see. */
  @Get('main-themes')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'reading the main themes reads settings, nothing about the admin',
  )
  async getMain(
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const [row] = (await runQuery(
      this.db,
      `SELECT version, updatedAt, changedBy, mainThemesCount,
         mainThemes.filter(|$t| record::exists($t)).map(|$t| record::id($t)) AS mainThemes
       FROM ONLY themeSettings:current`,
    )) as [Record<string, unknown> | null];
    if (!row) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'not_found',
        'Not found',
        'The theme settings record is missing (data script 0008 writes it).',
      );
    }
    const etag = `"${Number(row['version'])}"`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return {
      version: Number(row['version']),
      updatedAt: new Date(String(row['updatedAt'])).toISOString(),
      changedBy: row['changedBy'] ? key(row['changedBy']) : null,
      mainThemesCount: Number(row['mainThemesCount']),
      mainThemes: row['mainThemes'] as string[],
    };
  }

  /**
   * UpdateMainThemes: the whole ordered list and the count, at the version read (If-Match; 412
   * if someone saved since, 428 if missing). Every slug must be an existing theme (400 on the
   * first that isn't), each once. People see the change on their next page.
   */
  @Put('main-themes')
  @RequiresRole('Admin')
  @NoConsentRequired(
    'changing the main themes is staff work on settings, not the admin’s own data',
  )
  async updateMain(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
    @Headers('if-match') ifMatchHeader?: string,
  ) {
    const version = parseIfMatch(ifMatchHeader);
    if (version === undefined) throw ifMatchRequired();
    if (version === 'invalid') throw stale('the main themes');
    const input = parseMainThemes(body);
    const { role, user } = await this.actor(req);
    let results: unknown[];
    try {
      results = (await runQuery(
        this.db,
        `BEGIN TRANSACTION;
         LET $v = (SELECT VALUE version FROM ONLY themeSettings:current);
         IF $v = NONE { THROW 'theme_cmd:not_found' };
         IF $v != $version { THROW 'theme_cmd:stale_version' };
         LET $missing = $main.filter(|$s| !record::exists(type::record('tag', $s)));
         IF array::len($missing) > 0 { THROW 'theme_cmd:unknown_theme:' + $missing[0] };
         UPDATE ONLY themeSettings:current MERGE {
           mainThemes: $main.map(|$s| type::record('tag', $s)), mainThemesCount: $count,
           changedBy: $user, changedByRole: $role
         } RETURN version;
         COMMIT TRANSACTION;`,
        {
          version,
          main: input.mainThemes,
          count: input.mainThemesCount,
          user,
          role,
        },
      )) as unknown[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('theme_cmd:not_found')) throw notFound();
      const unknown = /theme_cmd:unknown_theme:([a-z0-9-]+)/.exec(message);
      if (unknown) {
        const i = input.mainThemes.indexOf(unknown[1]);
        throw invalid(
          `/mainThemes/${i}`,
          'unknown_theme',
          'There is no such theme.',
        );
      }
      if (
        message.includes('theme_cmd:stale_version') ||
        isTransactionConflict(err)
      ) {
        throw stale('the main themes');
      }
      throw err;
    }
    const row = requireWritten<{ version: number }>(
      results[results.length - 2],
      'theme settings',
    );
    this.logger.log(`Main themes saved as version ${row.version}`);
    res.setHeader('ETag', `"${row.version}"`);
    return { id: 'current', version: row.version };
  }
}

@Module({ controllers: [ThemesController] })
export class ThemesModule {}

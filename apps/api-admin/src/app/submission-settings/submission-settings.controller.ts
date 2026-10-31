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
import {
  ifNoneMatches,
  NoConsentRequired,
  PersonSessions,
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

const MIB = 1_048_576;

/**
 * What each limit may be set to, inclusive. The maxima are the schema's own (story.body's 50,000
 * characters, story.tagRefs' 20 themes, fn::settings::upload_ceilings' cost ceilings, and the
 * typo guards on the counts), so a value the database would refuse is a field error here instead
 * of a 500. The media minima are one unit of what /admin/limits shows (1 MB, 1 minute): nothing
 * smaller can be typed there, and no real recording is smaller. Besides these, each minimum must
 * be at most its maximum (storyTextMin ≤ storyTextMax, tagsMin ≤ tagsMax), as the database checks,
 * and tagsMin at most the themes there are (else nobody could submit), checked as it saves; no
 * login can delete a theme (O5), so the themes can't drop below it afterwards either. The
 * other limits can't lock everyone out: every count's minimum is 1, and text min ≤ max.
 */
export const BOUNDS = {
  storyTextMin: { min: 1, max: 50_000 },
  storyTextMax: { min: 1, max: 50_000 },
  tagsMin: { min: 0, max: 20 },
  tagsMax: { min: 1, max: 20 },
  openDraftsMax: { min: 1, max: 1000 },
  submissionsPer7Days: { min: 1, max: 1000 },
  uploadRequestsPerHour: { min: 1, max: 10_000 },
  uploadsPer7Days: { min: 1, max: 1000 },
  videoMaxBytes: { min: MIB, max: 10_737_418_240 }, // 10 GiB
  audioMaxBytes: { min: MIB, max: 2_147_483_648 }, // 2 GiB
  mediaMaxSeconds: { min: 60, max: 10_800 }, // 3 hours
} as const;
type Field = keyof typeof BOUNDS;
const FIELDS = Object.keys(BOUNDS) as Field[];
export type SubmissionSettings = Record<Field, number>;

/** A field error, as RFC 9457 `errors[]` (D30). */
const invalid = (pointer: string, code: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, code, message }],
  );

/** `UpdateSubmissionSettings`'s body: every limit, each within BOUNDS, minima at most maxima. */
export function parseSettings(body: unknown): SubmissionSettings {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'invalid_body', 'A JSON object.');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !Object.hasOwn(BOUNDS, k));
  if (unknown) {
    throw invalid(
      `/${unknown}`,
      'unknown_field',
      'Not a field of this command.',
    );
  }
  const out = {} as SubmissionSettings;
  for (const field of FIELDS) {
    const v = b[field];
    const { min, max } = BOUNDS[field];
    if (v === undefined) throw invalid(`/${field}`, 'required', 'Required.');
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw invalid(
        `/${field}`,
        'out_of_range',
        `A whole number from ${min} to ${max}.`,
      );
    }
    out[field] = v;
  }
  if (out.storyTextMin > out.storyTextMax) {
    throw invalid(
      '/storyTextMin',
      'min_over_max',
      'The shortest story can’t be longer than the longest.',
    );
  }
  if (out.tagsMin > out.tagsMax) {
    throw invalid(
      '/tagsMin',
      'min_over_max',
      'The fewest themes can’t be more than the most.',
    );
  }
  return out;
}

/** `If-Match: "<version>"` (D29): the version, undefined when missing, or 'invalid'. */
export function parseIfMatch(
  header: string | undefined,
): number | undefined | 'invalid' {
  if (header === undefined || header.trim() === '') return undefined;
  const m = /^"([1-9]\d{0,8})"$/.exec(header.trim());
  return m ? Number(m[1]) : 'invalid';
}

/** 412: someone saved the limits since the page read them (D29). */
const stale = () =>
  new ProblemException(
    HttpStatus.PRECONDITION_FAILED,
    'stale_version',
    'Precondition failed',
    'Someone else changed the limits since you read them: reload, then make your changes again.',
  );

/** 400 on /tagsMin: a story would need more themes than exist, so nobody could submit. */
const tooFewThemes = (themes: number) =>
  invalid(
    '/tagsMin',
    'over_theme_count',
    themes === 1
      ? 'There is only 1 theme, so a story can’t need more.'
      : `There are only ${themes} themes, so a story can’t need more.`,
  );

/** Every tag counts: a story may use any of them (api-user's checkTags). */
const COUNT_THEMES = `count(SELECT VALUE id FROM tag)`;

const missing = () =>
  new ProblemException(
    HttpStatus.NOT_FOUND,
    'not_found',
    'Not found',
    'The settings record is missing (data script 0006 writes it).',
  );

/**
 * api-admin.yaml, tag SubmissionSettings (W3, D94, D112, D113): the submission limits everyone
 * submits under, in the one record `submissionSettings:current`, for Admin and above (D1). An
 * admin reads them at /admin/limits and saves the whole set at the version they read (If-Match);
 * a new value applies to everyone's next action, with no grandfathering (Joel, 2026-10-30). The
 * database's `submissionSettings_check` event writes the audit row, naming the admin and role.
 */
@Controller('v1/admin/submission-settings')
export class SubmissionSettingsController {
  private readonly logger = new Logger(SubmissionSettingsController.name);

  constructor(
    @Inject(SURREAL) private readonly db: Surreal,
    private readonly people: PersonSessions,
  ) {}

  @Get()
  @RequiresRole('Admin')
  @NoConsentRequired(
    'reading the submission limits reads settings, nothing about the admin',
  )
  async get(
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const [row, themes] = (await runQuery(
      this.db,
      `SELECT * OMIT id, changedByRole FROM ONLY submissionSettings:current;
       RETURN ${COUNT_THEMES};`,
    )) as [Record<string, unknown> | null, number];
    if (!row) throw missing();
    const etag = `"${Number(row['version'])}"`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    const changedBy = row['changedBy'] ? String(row['changedBy']) : null;
    return {
      version: Number(row['version']),
      updatedAt: new Date(String(row['updatedAt'])).toISOString(),
      // Their user record's id (Clerk holds names, D16).
      changedBy: changedBy ? changedBy.slice(changedBy.indexOf(':') + 1) : null,
      settings: Object.fromEntries(
        FIELDS.map((f) => [f, Number(row[f])]),
      ) as SubmissionSettings,
      // The real upper bound on tagsMin: the themes there are, if fewer than the schema's 20.
      bounds: {
        ...BOUNDS,
        tagsMin: {
          ...BOUNDS.tagsMin,
          max: Math.min(BOUNDS.tagsMin.max, themes),
        },
      },
      themeCount: themes,
    };
  }

  /**
   * UpdateSubmissionSettings: every limit, at the version read (If-Match; 412 if someone saved
   * since, 428 if missing). One transaction checks the version and writes; two admins saving
   * at once conflict at commit, and the loser gets 412 too. The theme count is read in the same
   * transaction, so tagsMin is checked against the themes there are as it saves. No login can
   * delete a theme (O5), so that count can only grow while the save is in flight.
   */
  @Put()
  @RequiresRole('Admin')
  @NoConsentRequired(
    'changing the submission limits is staff work on settings, not the admin’s own data',
  )
  async update(
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
        'This command needs If-Match with the settings’ version.',
      );
    }
    if (version === 'invalid') throw stale();
    const settings = parseSettings(body);
    const { role } = await this.people.authenticate(req);
    // Who changes them: the admin's own user record, from their own database session (D27).
    const user = await this.people.run(req, async ({ user }) => user);
    let results: unknown[];
    try {
      results = (await runQuery(
        this.db,
        `BEGIN TRANSACTION;
         LET $v = (SELECT VALUE version FROM ONLY submissionSettings:current);
         IF $v = NONE { THROW 'settings_cmd:not_found' };
         IF $v != $version { THROW 'settings_cmd:stale_version' };
         LET $themes = ${COUNT_THEMES};
         IF $settings.tagsMin > $themes { THROW 'settings_cmd:too_few_themes:' + <string>$themes };
         UPDATE ONLY submissionSettings:current
           MERGE object::extend($settings, { changedBy: $user, changedByRole: $role })
           RETURN version;
         COMMIT TRANSACTION;`,
        { settings, version, user, role },
      )) as unknown[];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('settings_cmd:not_found')) throw missing();
      // Ours above, or the database's (submissionSettings_check) with the same count.
      const themes = /too_few_themes:(\d+)/.exec(message);
      if (themes) throw tooFewThemes(Number(themes[1]));
      if (
        message.includes('settings_cmd:stale_version') ||
        isTransactionConflict(err)
      ) {
        throw stale();
      }
      throw err;
    }
    const row = requireWritten<{ version: number }>(
      results[results.length - 2], // the UPDATE's; COMMIT is last
      'submission settings',
    );
    this.logger.log(`Submission settings saved as version ${row.version}`);
    res.setHeader('ETag', `"${row.version}"`);
    return { id: 'current', version: row.version };
  }
}

@Module({ controllers: [SubmissionSettingsController] })
export class SubmissionSettingsModule {}

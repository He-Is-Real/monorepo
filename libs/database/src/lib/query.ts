import { MAX_TRIES } from '@heisreal/logging';
import { note, timeDb, writeRetryLimit } from '@heisreal/logging/event';
import type { SurrealQueryable } from 'surrealdb';

/**
 * A statement failed. `message` is the root cause: in a failed transaction every other
 * statement only reports "not executed", and surrealdb.js 2.0.x's `collect()` throws that
 * unhelpful one (libs/database/SURREALDB-NOTES.md).
 */
export class DatabaseQueryError extends Error {
  constructor(
    message: string,
    /** Index of the statement that failed. */
    readonly statement: number,
    /** The query's name ({@link queryName}): our own SurrealQL, never its variables. */
    readonly query?: string,
  ) {
    super(message);
    this.name = 'DatabaseQueryError';
  }
}

const NOT_RUN = 'not executed due to a failed transaction';

/**
 * Runs SurrealQL and returns every statement's result in JSON form (record ids as
 * `table:id` strings, datetimes as RFC 3339 strings). `BEGIN`/`COMMIT` count as statements.
 * Throws {@link DatabaseQueryError} with the root cause if any statement failed.
 *
 * A command meets three outcomes: an event's THROW (a code the API maps), an empty result or a
 * dropped field (the permissions; see {@link WriteNotAppliedError}), and a retryable conflict (an
 * overlap; {@link retryOnConflict}).
 */
export async function runQuery(
  db: SurrealQueryable,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<unknown[]> {
  const responses = await timeDb(queryName(sql), () =>
    db.query(sql, vars).json().responses(),
  );
  const failed = responses.flatMap((r, i) =>
    r.success ? [] : [{ i, message: errorMessage(r.error) }],
  );
  if (failed.length) {
    const root = failed.find((f) => !f.message.includes(NOT_RUN)) ?? failed[0];
    throw new DatabaseQueryError(root.message, root.i, queryName(sql));
  }
  return responses.map((r) => (r.success ? r.result : undefined));
}

/**
 * A short name for a query on the request's event (`db.slowest.name`): its first function
 * (`fn::submit_story`), else its first statement and table (`SELECT story`). Our own SurrealQL
 * only, never the variables.
 */
export function queryName(sql: string): string {
  const fn = /\bfn::[\w:]+/.exec(sql);
  if (fn) return fn[0];
  const verb = /\b(SELECT|CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE)\b/i.exec(
    sql,
  );
  if (!verb) return 'query';
  const rest = sql.slice(verb.index + verb[0].length);
  const table = (/\b(?:FROM|INTO)\s+(?:ONLY\s+)?([A-Za-z_]\w*)/i.exec(rest) ??
    /^\s+(?:ONLY\s+)?([A-Za-z_]\w*)/i.exec(rest))?.[1];
  const name = verb[1].toUpperCase();
  return table ? `${name} ${table}` : name;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Two transactions that touch the same person write the same fence row, so the second to
 * commit fails with this retryable conflict. A transaction sees the database as it was when it
 * began and only write-write conflicts abort, so every write that depends on or changes a person
 * bumps that person's fence (likewise a Clerk id, a theme and the Admin count; schema-01's
 * `fence`). Expected, not a fault: a moderator approving while the person edits, two tabs of one
 * person, a file failing during approval, two Admins saving the themes or the same legal version.
 */
export function isTransactionConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /transaction conflict/i.test(message) || /can be retried/i.test(message)
  );
}

/**
 * What a conflict retry says about itself in the logs (the retries rule, Joel, 2026-11-27):
 * `record`, the record the saves fought over when the caller knows it (a person's `user` record,
 * whose fence both bumped), else the name of the query that conflicted. Ids only.
 */
export interface ConflictSubject {
  record?: string;
}

/** The record (or, failing that, the query) a conflict was about, for the logs. */
export function conflictSubject(
  err: unknown,
  subject: ConflictSubject = {},
): string | undefined {
  return (
    subject.record ??
    (err instanceof DatabaseQueryError ? err.query : undefined)
  );
}

/**
 * Before a save's third try (the retries rule: "whenever a save needs its third try, write one
 * log line naming which record was fought over"): a fact on the request's or job's event
 * (`db.conflict_third_try`), or its own WARNING line outside one. Often for one place means too
 * much fights over one record: change what they fight over, don't raise the number.
 */
export function noteThirdTry(err: unknown, subject?: ConflictSubject): void {
  note(
    { db: { conflict_third_try: conflictSubject(err, subject) ?? 'unknown' } },
    { severity: 'WARNING', message: 'A save needed its third try' },
  );
}

/** The save's tries ran out on a conflict: the one shared ERROR line (writeRetryLimit). */
export function conflictGaveUp(
  err: unknown,
  tries: number,
  subject?: ConflictSubject,
): void {
  writeRetryLimit({
    what: 'conflicting_save',
    id: conflictSubject(err, subject),
    tries,
    then: 'gave_up',
  });
}

/**
 * Re-runs the whole command (re-read, re-check, re-write) on a retryable transaction conflict,
 * with a small bounded backoff: {@link MAX_TRIES} tries in all (the retries rule, kind 1, RT-4 and
 * RT-5: 20 ms, then 40 ms between them). Any other error is thrown at once. The retry sees the
 * committed state, so a newer legal version or an erasure now refuses it. The third try is noted
 * ({@link noteThirdTry}); a conflict on the last writes the retry_limit line, then is thrown, so a
 * person sees the usual "Something went wrong".
 */
export async function retryOnConflict<T>(
  work: () => Promise<T>,
  {
    attempts = MAX_TRIES,
    backoffMs = 20,
    record,
  }: { attempts?: number; backoffMs?: number } & ConflictSubject = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isTransactionConflict(err)) throw err;
      if (attempt >= attempts) {
        conflictGaveUp(err, attempt, { record });
        throw err;
      }
      if (attempt + 1 === MAX_TRIES) noteThirdTry(err, { record });
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
}

/**
 * A write the permissions deny returns an empty result, not an error (D13 gotcha). Commands
 * call this on what they wrote, and fail loudly (never a 2xx) when it isn't there. It only
 * works on tables the caller can read back.
 */
export class WriteNotAppliedError extends Error {
  constructor(what: string) {
    super(`${what} was not written (refused by the database permissions?)`);
    this.name = 'WriteNotAppliedError';
  }
}

export function requireWritten<T>(result: unknown, what: string): T {
  const rows = Array.isArray(result) ? result : result == null ? [] : [result];
  if (rows.length !== 1) throw new WriteNotAppliedError(what);
  return rows[0] as T;
}

/**
 * The hard ceilings on a story (schema-04-stories.surql: `story.body`, `story.themeRefs`). The limits themselves
 * are settings an admin adjusts (W3: `submissionSettings`, read with `SUBMISSION_SETTINGS_SQL`).
 */
export const STORY_CEILINGS = {
  textLength: 50_000,
  themes: 20,
} as const;

/** The submission settings in force (W3, D112), with their defaults: `fn::settings::submission`. */
export interface SubmissionSettings {
  storyTextMin: number;
  storyTextMax: number;
  /** How many themes a story needs when it is submitted (only then). */
  themesMin: number;
  themesMax: number;
  openDraftsMax: number;
  submissionsPer7Days: number;
  uploadRequestsPerHour: number;
  /** D113's upload limits (M2 plan PR 7). */
  uploadsPer7Days: number;
  videoMaxBytes: number;
  audioMaxBytes: number;
  mediaMaxSeconds: number;
  /** One picture's file, as the browser prepared it (Joel, 2026-11-20); the same for everyone. */
  imageMaxBytes: number;
  /** G3 B: days housekeeping keeps a rejected story, and a story left in editing after it was sent. */
  rejectedRetentionDays: number;
  editingRetentionDays: number;
}

/** The query that returns them (any session: everyone reads the settings). */
export const SUBMISSION_SETTINGS_SQL = 'RETURN fn::settings::submission()';

/**
 * A text's length without the spaces around it: the database's fn::text::trimmed_length, so API
 * validation and the database agree. Strips what JavaScript's trim() strips (Unicode spaces,
 * line terminators, U+FEFF) and what SurrealDB's string::trim strips (also U+0085).
 */
export function trimmedTextLength(text: string | null | undefined): number {
  return [...(text ?? '').replace(/^[\s\u0085]+|[\s\u0085]+$/g, '')].length;
}

/**
 * The database refused to approve or publish a story whose media isn't processed yet (A2,
 * fn::story::approval_problem). api-admin answers `409` with `code: media_not_ready`.
 */
export function isMediaNotReadyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bmedia_not_ready:/.test(message);
}

/**
 * The database refused to submit a written story shorter than the setting's minimum
 * (story_text_limits). api-user answers `400` with `code: story_text_too_short`.
 */
export function isStoryTextTooShortError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /a written story needs at least \d+ characters/.test(message);
}

/**
 * The database refused a story for the settings' limits (story_text_limits): text longer than
 * allowed (any write), or, at submission, a number of themes outside themesMin–themesMax or a
 * theme that no longer exists. api-user answers `400` for `/body` or `/themeIds`.
 */
export function storyLimitOf(
  err: unknown,
): 'text' | 'theme_count' | 'themes_changed' | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/\bstory_text_too_long:/.test(message)) return 'text';
  if (/\bstory_theme_count:/.test(message)) return 'theme_count';
  if (/\bstory_themes_changed:/.test(message)) return 'themes_changed';
  return undefined;
}

/** D94's limits on what a person starts (schema-04-stories.surql, story_limits). */
export type SubmissionLimit = 'open_drafts' | 'weekly_submission';

/**
 * Which D94 limit the database refused a write for, if any: a fourth open draft
 * (`limit_open_drafts:`) or a second submission in 7 days (`limit_weekly_submission:`).
 * api-user answers `409` `draft_limit_reached` or `weekly_submission_limit_reached`.
 */
export function submissionLimitOf(err: unknown): SubmissionLimit | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/\blimit_open_drafts:/.test(message)) return 'open_drafts';
  if (/\blimit_weekly_submission:/.test(message)) return 'weekly_submission';
  return undefined;
}

/** The upload limits the database refused a grant for (schema-04-stories.surql, storyFile_attach; D113). */
export type UploadLimit = 'size' | 'duration' | 'hourly' | 'weekly';

/**
 * Which upload limit the database refused an upload grant for, if any: a file bigger or longer
 * than the person may upload (`limit_upload_size:`, `limit_upload_duration:`), or more new uploads
 * than they may start in an hour or 7 days (`limit_upload_hourly:`, `limit_upload_weekly:`).
 */
export function uploadLimitOf(err: unknown): UploadLimit | undefined {
  const message = err instanceof Error ? err.message : String(err);
  return /\blimit_upload_(size|duration|hourly|weekly):/.exec(message)?.[1] as
    UploadLimit | undefined;
}

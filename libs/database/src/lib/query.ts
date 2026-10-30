import type { SurrealQueryable } from 'surrealdb';

/**
 * A statement failed. `message` is the root cause: in a failed transaction every other
 * statement only reports "not executed", and surrealdb.js 2.0.x's `collect()` throws that
 * unhelpful one (docs/db-permissions.md, gotchas).
 */
export class DatabaseQueryError extends Error {
  constructor(
    message: string,
    /** Index of the statement that failed. */
    readonly statement: number,
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
 */
export async function runQuery(
  db: SurrealQueryable,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<unknown[]> {
  const responses = await db.query(sql, vars).json().responses();
  const failed = responses.flatMap((r, i) =>
    r.success ? [] : [{ i, message: errorMessage(r.error) }],
  );
  if (failed.length) {
    const root = failed.find((f) => !f.message.includes(NOT_RUN)) ?? failed[0];
    throw new DatabaseQueryError(root.message, root.i);
  }
  return responses.map((r) => (r.success ? r.result : undefined));
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
 * commit fails with this retryable conflict (docs/db-permissions.md, "Transactions").
 */
export function isTransactionConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /transaction conflict/i.test(message) || /can be retried/i.test(message)
  );
}

/**
 * Re-runs the whole command (re-read, re-check, re-write) on a retryable transaction conflict,
 * with a small bounded backoff. Any other error is thrown at once.
 */
export async function retryOnConflict<T>(
  work: () => Promise<T>,
  {
    attempts = 3,
    backoffMs = 20,
  }: { attempts?: number; backoffMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= attempts || !isTransactionConflict(err)) throw err;
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
 * The hard ceilings on a story (schema.surql `story.body`, `story.tagRefs`). The limits themselves
 * are settings an admin adjusts (W3: `submissionSettings`, read with `SUBMISSION_SETTINGS_SQL`).
 */
export const STORY_CEILINGS = {
  textLength: 50_000,
  tags: 20,
} as const;

/** The submission settings in force (W3, D112), with their defaults: `fn::settings::submission`. */
export interface SubmissionSettings {
  storyTextMin: number;
  storyTextMax: number;
  tagsMin: number;
  tagsMax: number;
  openDraftsMax: number;
  submissionsPer7Days: number;
  uploadRequestsPerHour: number;
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
 * The database refused text longer, or more themes, than the settings allow (story_text_limits).
 * api-user answers `400` for `/body` or `/tagSlugs`.
 */
export function storyLimitOf(err: unknown): 'text' | 'tags' | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/\bstory_text_too_long:/.test(message)) return 'text';
  if (/\bstory_too_many_tags:/.test(message)) return 'tags';
  return undefined;
}

/** D94's limits on what a person starts (schema.surql, story_limits). */
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

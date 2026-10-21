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

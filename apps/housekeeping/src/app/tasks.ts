import type { SurrealQueryable } from 'surrealdb';
import type { ClerkUsers } from './clerk';
import type { StreamLibrary } from './stream';

/**
 * What each chore gets: the database as service:housekeeping, Bunny, Clerk (when its key is
 * set), and the run's limits.
 */
export interface TaskContext {
  db: SurrealQueryable;
  /** Bunny Stream, for orphan and queued video deletions; null: they wait. */
  stream: StreamLibrary | null;
  /** Clerk's users, for queued account deletions; null or absent: they wait. */
  clerk?: ClerkUsers | null;
  /** Only log what would be deleted. */
  dryRun: boolean;
  /** At most this many deletions per chore per run. */
  maxDeletions: number;
  /** The run's clock (Bunny's dates are compared with it). */
  now: Date;
}

/** Counts and ids only: never a title, a name or any other personal data. */
export interface TaskResult {
  /** Selected for deletion this run (at most maxDeletions). */
  selected: string[];
  /** Deleted (empty in a dry run). */
  deleted: string[];
  /** Selected but not deleted because the call failed; the next run tries again. */
  failed: string[];
  /** More were eligible than maxDeletions allowed, or the listing was cut short. */
  more: boolean;
}

export interface Task {
  /** Kebab-case, for the logs. */
  name: string;
  run(ctx: TaskContext): Promise<TaskResult>;
}

/** One JSON line per chore, for Cloud Logging. */
export type Log = (entry: Record<string, unknown>) => void;

/**
 * Runs each chore in order; one failing doesn't stop the next. Answers 0 when every chore
 * finished with no failed deletion, else 1.
 */
export async function runTasks(
  tasks: readonly Task[],
  ctx: TaskContext,
  log: Log,
): Promise<number> {
  let code = 0;
  for (const task of tasks) {
    try {
      const r = await task.run(ctx);
      log({
        task: task.name,
        dryRun: ctx.dryRun,
        selected: r.selected.length,
        deleted: r.deleted.length,
        failed: r.failed.length,
        more: r.more,
        ids: ctx.dryRun ? r.selected : r.deleted,
        ...(r.failed.length ? { failedIds: r.failed } : {}),
      });
      if (r.failed.length) code = 1;
    } catch (err) {
      code = 1;
      log({
        task: task.name,
        dryRun: ctx.dryRun,
        error: (err as Error).message,
      });
    }
  }
  return code;
}

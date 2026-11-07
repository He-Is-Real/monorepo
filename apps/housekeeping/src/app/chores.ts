import { expiredDraftsTask } from './drafts';
import { pendingDeletionsTask } from './erasure';
import { detachedFilesTask, oldFileRowsTask } from './files';
import { mediaResendTask, oldMediaJobsTask } from './media-jobs';
import { expiredRequestKeysTask } from './request-keys';
import type { Task } from './tasks';
import { orphanVideosTask } from './videos';

/**
 * The nightly chores, run in this order: expired request keys first (nothing depends on them),
 * then expired drafts before orphaned videos, so their videos are orphans the same night; the
 * files stories stopped showing (R12), then the file rows that no longer count (whose media jobs
 * go with them), then ended media jobs 30 days old (J2), last.
 *
 * To add a chore: a Task in its own file, listed here, with the database permission it needs
 * for service:housekeeping (docs/db-permissions.md) and any secret granted to the housekeeping
 * service account in OpenTofu.
 */
export const CHORES: readonly Task[] = [
  expiredRequestKeysTask,
  pendingDeletionsTask,
  expiredDraftsTask,
  orphanVideosTask,
  detachedFilesTask,
  oldFileRowsTask,
  oldMediaJobsTask,
];

/**
 * Which chores a run does (HOUSEKEEPING_CHORES): `nightly`, the list above (03:30 London time),
 * or `media-resend`, only sending unfinished media jobs again (18:00 London time, when Joel's
 * machine is on; Joel, 2026-11-07). The nightly run never resends.
 */
export const RUNS = {
  nightly: CHORES,
  'media-resend': [mediaResendTask],
} as const satisfies Record<string, readonly Task[]>;
export type RunName = keyof typeof RUNS;

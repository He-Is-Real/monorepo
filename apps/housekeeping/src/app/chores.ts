import { expiredDraftsTask } from './drafts';
import { pendingDeletionsTask } from './erasure';
import { detachedFilesTask, oldFileRowsTask } from './files';
import { expiredRequestKeysTask } from './request-keys';
import type { Task } from './tasks';
import { orphanVideosTask } from './videos';

/**
 * The nightly chores, run in this order: expired request keys first (nothing depends on them),
 * then expired drafts before orphaned videos, so their videos are orphans the same night; the
 * files stories stopped showing (R12), then the file rows that no longer count, last.
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
];

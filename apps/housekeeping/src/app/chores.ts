import { expiredDraftsTask } from './drafts';
import { pendingDeletionsTask } from './erasure';
import type { Task } from './tasks';
import { orphanVideosTask } from './videos';

/**
 * The nightly chores, run in this order: expired drafts before orphaned videos, so their videos
 * are orphans the same night.
 *
 * To add a chore: a Task in its own file, listed here, with the database permission it needs
 * for service:housekeeping (docs/db-permissions.md) and any secret granted to the housekeeping
 * service account in OpenTofu. Next, not built yet:
 * - orphaned images in the images storage zone (replaced or removed pictures of stories that are
 *   still there; a deleted story's folder is queued by its delete, pendingDeletion).
 */
export const CHORES: readonly Task[] = [
  pendingDeletionsTask,
  expiredDraftsTask,
  orphanVideosTask,
];

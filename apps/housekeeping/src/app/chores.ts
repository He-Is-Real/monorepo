import { expiredDraftsTask } from './drafts';
import type { Task } from './tasks';
import { orphanVideosTask } from './videos';

/**
 * The nightly chores, run in this order. Expired drafts go first, so their videos are orphans
 * the same night.
 *
 * To add a chore: a Task in its own file, listed here, with the database permission it needs
 * for service:housekeeping (docs/db-permissions.md) and any secret granted to the housekeeping
 * service account in OpenTofu. Next, not built yet:
 * - orphaned images in the images storage zone (M2 plan PR 10);
 * - clean-up after an erasure, e.g. Bunny media a failed delete left behind (M2 plan PR 11).
 */
export const CHORES: readonly Task[] = [expiredDraftsTask, orphanVideosTask];

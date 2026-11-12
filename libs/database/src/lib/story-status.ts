/**
 * A story's status in SurrealQL, defined once (R6: `story.currentStatus` points at the story's
 * newest storyStatusLog entry that moved it; none yet = being edited and never sent, a "Draft").
 * Five states (Joel, 2026-11-11): editing, pending, approved, hidden, rejected. Fragments for a
 * query on `story`.
 */

/** The status as the log records it, 'editing' with no entry: fn::story::status_of. */
export const STORY_STATUS = 'fn::story::status_of($this)';

/**
 * A draft: never sent, so no status entry yet. Reads only the pointer, never the entry, so it also
 * works for logins that can't read the status log (service:housekeeping). The open-drafts limit
 * and the 6-month expiry count only these.
 */
export const IS_DRAFT = 'currentStatus = NONE';

/**
 * Published (approved). api-public-read's login can only read published stories anyway; its
 * queries ask for them too, so a permissions slip can't make a draft public. `path` reaches the
 * story through a link, e.g. `story.` on a favourite.
 */
export const isPublished = (path = '') =>
  `${path}currentStatus.status = 'approved'`;

/**
 * A storyStatusLog entry that is its story's current, approved one (for queries on the log's
 * (status, publishedAt) index).
 */
export const PUBLISHED_ENTRY =
  "status = 'approved' AND story.currentStatus = id";

/**
 * A story's files with their processing state, for those who read the whole storyFile row: the
 * story's owner (GetStory, "download my data") and api-admin (R12). `media`: its video or audio
 * file as one item, with Bunny's real length as `durationSeconds`; `image`: its picture.
 */
export const OWNER_FILE_FIELDS = `
  IF mediaFile != NONE {
    [object::extend(mediaFile.{ format, thumbnailPath, width, height, processing },
      { bunnyVideoId: record::id(mediaFile), durationSeconds: mediaFile.lengthSeconds })]
  } ELSE { [] } AS media,
  IF image != NONE {
    object::extend(image.file.{ width, height, processing },
      { path: record::id(image.file), alt: image.alt })
  } AS image`;

/** A detached file the nightly clean-up may delete now (DETACHED_FILES_DUE). */
export interface DetachedFile {
  /** The Bunny video id, or the picture's path in the images zone. */
  key: string;
  format: 'video' | 'audio' | 'image';
  /** Another story still points at it (dev-seed's shared dummy files): never deleted, only marked removed. */
  shared: boolean;
}

/**
 * Files a story stopped pointing at (R12, storyFile.detachedAt) once no upload link for them can
 * still be used (fn::upload::links_expire_after), the longest-detached first, at most `$limit`.
 * One read (a snapshot): a file another story still points at is marked `shared`.
 */
export const DETACHED_FILES_DUE = `
  BEGIN TRANSACTION;
  LET $due = SELECT id, record::id(id) AS key, format, detachedAt FROM storyFile
    WHERE detachedAt != NONE AND detachedAt <= time::now() - fn::upload::links_expire_after()
      AND removedAt = NONE
    ORDER BY detachedAt LIMIT $limit;
  LET $ids = $due.id;
  LET $shown = array::union(
    (SELECT VALUE mediaFile FROM story WHERE mediaFile IN $ids),
    (SELECT VALUE image.file FROM story WHERE image.file IN $ids));
  RETURN $due.map(|$f| { key: $f.key, format: $f.format, shared: $f.id IN $shown });
  COMMIT TRANSACTION;`;

/** The file is gone (bind `$key`): its row records removedAt (the database refuses it too early). */
export const DETACHED_FILE_REMOVED = `
  UPDATE type::record('storyFile', $key) SET removedAt = time::now() RETURN NONE`;

/**
 * Rows that no longer count towards the upload limits (7 days, D113) whose file is removed or
 * whose story is gone (R12), at most `$limit`; the database refuses deleting any other.
 */
export const OLD_FILE_ROWS = `
  SELECT VALUE record::id(id) FROM storyFile
    WHERE at <= time::now() - 7d AND (removedAt != NONE OR !record::exists(story))
    ORDER BY at LIMIT $limit`;
/** One of them (bind `$key`); answers it if deleted. */
export const OLD_FILE_ROW_DELETE = `
  DELETE type::record('storyFile', $key) RETURN BEFORE`;

/**
 * Super admins' list of every story (R15; api-admin's GET /v1/admin/stories), newest created
 * first: its fields, and the page query (bind `$after` = [createdAt, story id] or NONE, `$take`).
 * Also timed by api-public-read's local scale test.
 */
export const ALL_STORIES_SUMMARY = `record::id(id) AS id, slug, title,
  currentStatus.status ?? 'draft' AS status, primaryFormat,
  record::id(submitter) AS submitter, createdAt, updatedAt, version`;
export const ALL_STORIES_LIST_SQL = `
  LET $c = IF $after != NONE { <datetime> $after[0] };
  LET $cid = IF $after != NONE { type::record('story', $after[1]) };
  SELECT ${ALL_STORIES_SUMMARY} FROM story
  WHERE $c = NONE OR createdAt < $c OR (createdAt = $c AND id < $cid)
  ORDER BY createdAt DESC, id DESC LIMIT $take;`;

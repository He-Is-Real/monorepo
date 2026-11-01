-- data/0008-themes.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). Themes plan v3 (Joel, 2026-10-31): tags become themes in admin-managed
-- categories. Creates the fixed Other category, then for each old tag group with tags a category
-- (theme -> Topics, all highlighted, as they were the first-shown set; journey -> Journeys;
-- emotion -> Feelings), copies each tag to a theme with a new ULID id, relinks every story and
-- published story to them, and empties the old tag table. The theme limits keep their values
-- under their new names. Dummy data only: it runs once, with no rollback. On a fresh database it
-- creates Other and nothing else.
-- 3.2.4 refuses any write to a row that still holds a removed field unless the same write sets
-- it to NONE, and the new fields have no value on old rows yet (DEFAULT applies on create only):
-- so each row gets its new fields and loses its old ones in one SET.
-- Other may exist already: on dev, dev-seed's new image (UPSERT) ran after the schema and before
-- this script's first successful run (2026-11-01).
UPSERT themeCategory:other SET name = 'Other';
FOR $group IN [['theme', 'Topics', true], ['journey', 'Journeys', false], ['emotion', 'Feelings', false]] {
  LET $tags = (SELECT id, name FROM tag WHERE category = $group[0] ORDER BY name);
  IF array::len($tags) > 0 {
    LET $category = (CREATE ONLY type::record('themeCategory', rand::ulid()) CONTENT { name: $group[1] });
    FOR $tag IN $tags {
      LET $theme = (CREATE ONLY type::record('theme', rand::ulid()) CONTENT {
        name: $tag.name, category: $category.id, highlighted: $group[2]
      });
      UPDATE $tag.id SET theme = $theme.id;
    };
  };
};
-- Each story's themes in its tags' order (a tag that no longer exists is dropped), then its
-- published row, which must mirror it. (3.2.4: FOR over a subquery fails; over a LET works.)
LET $stories = (SELECT id, tagRefs FROM story);
FOR $story IN $stories {
  LET $themes = (SELECT VALUE theme FROM ($story.tagRefs ?? []) WHERE theme != NONE);
  UPDATE $story.id SET themeRefs = $themes, tagRefs = NONE;
  UPDATE type::record('publicStory', record::id($story.id))
    SET themeRefs = $themes, tagRefs = NONE, tagSlugs = NONE;
};
DELETE tag;
-- A settings row written before some limits existed (dev's, from data/0006, predates the upload
-- limits of #133) lacks them, and DEFAULT applies on create only, so any update of it is refused
-- until they're set: give every limit that has a default its default in the same write when it's
-- missing (2026-10-31, dev's first run of this script).
UPDATE submissionSettings SET themesMin = tagsMin ?? themesMin ?? 1, themesMax = tagsMax ?? themesMax ?? 5,
  tagsMin = NONE, tagsMax = NONE,
  storyTextMin = storyTextMin ?? 200, storyTextMax = storyTextMax ?? 10000,
  openDraftsMax = openDraftsMax ?? 3,
  uploadsPer7Days = uploadsPer7Days ?? 5, uploadRequestsPerHour = uploadRequestsPerHour ?? 10,
  videoMaxBytes = videoMaxBytes ?? 4294967296, audioMaxBytes = audioMaxBytes ?? 524288000,
  mediaMaxSeconds = mediaMaxSeconds ?? 900
  WHERE tagsMin != NONE OR tagsMax != NONE OR storyTextMin = NONE OR storyTextMax = NONE
    OR openDraftsMax = NONE OR uploadsPer7Days = NONE OR uploadRequestsPerHour = NONE
    OR videoMaxBytes = NONE OR audioMaxBytes = NONE OR mediaMaxSeconds = NONE;

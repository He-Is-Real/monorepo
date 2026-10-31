-- data/0009-theme-ids.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). R2 (Joel, 2026-10-31): a theme's id is opaque and unrelated to its name, so a
-- renamed theme's browse address (`?tag=<id>`) never keeps its old wording. Every tag whose id
-- isn't a ULID (made from its first name, e.g. tag:doubt) gets a new `tag:<ulid>`, and everything
-- linking it follows, in the same place in its list: stories' and published stories' tagRefs, and
-- the main themes. Nothing else links a tag (auditLog names only tags api-admin made, and those
-- have ULIDs already). Safe to run again: a ULID id is left alone, so a second run changes nothing.
--
-- The theme keeps its name and category; its version starts again at 1 and its createdAt is now
-- (both computed, as for any new record). The old record is deleted first, freeing its name
-- (unique ignoring case) for the new one. Re-pointing a story's links needs no consent check
-- (story_consent: a system user changing only tagRefs). A published story's row is written with
-- the story's new version, so it still mirrors the story (publicStory_mirrors_story).
-- (3.2.4 refuses `FOR $x IN (SELECT ...)`, "Cannot execute statement using value", so each list
-- is read into a variable first.)
LET $olds = (SELECT VALUE id FROM tag WHERE !string::is_ulid(type::string(record::id(id))));
FOR $old IN $olds {
  LET $new = type::record('tag', rand::ulid());
  LET $t = (SELECT name, category, changedBy, changedByRole FROM ONLY $old);
  DELETE $old;
  CREATE $new CONTENT {
    name: $t.name, category: $t.category, changedBy: $t.changedBy, changedByRole: $t.changedByRole
  };
  LET $ss = (SELECT VALUE id FROM story WHERE tagRefs CONTAINS $old);
  FOR $s IN $ss {
    LET $refs = (SELECT VALUE tagRefs FROM ONLY $s);
    LET $i = array::find_index($refs, $old);
    UPDATE $s SET tagRefs = array::concat(array::slice($refs, 0, $i), [$new],
      array::slice($refs, $i + 1));
  };
  LET $ps = (SELECT VALUE id FROM publicStory WHERE tagRefs CONTAINS $old);
  FOR $p IN $ps {
    LET $refs = (SELECT VALUE tagRefs FROM ONLY $p);
    LET $i = array::find_index($refs, $old);
    UPDATE $p SET tagRefs = array::concat(array::slice($refs, 0, $i), [$new],
      array::slice($refs, $i + 1)), version = type::record('story', record::id($p)).version;
  };
  LET $ms = (SELECT VALUE id FROM themeSettings WHERE mainThemes CONTAINS $old);
  FOR $m IN $ms {
    LET $refs = (SELECT VALUE mainThemes FROM ONLY $m);
    LET $i = array::find_index($refs, $old);
    UPDATE $m SET mainThemes = array::concat(array::slice($refs, 0, $i), [$new],
      array::slice($refs, $i + 1));
  };
};
-- Every published row is written once more, so each has tagIds (computed on write; it replaced
-- tagSlugs, whose stored values a schemafull write drops).
UPDATE publicStory SET version = type::record('story', record::id(id)).version;

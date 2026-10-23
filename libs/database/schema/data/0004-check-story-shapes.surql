-- data/0004-check-story-shapes.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). D53: the schema now checks every story write against the three story types and
-- real pixel sizes (event story_shape), but a DEFINE doesn't re-check rows written before it, and
-- REMOVE FIELD leaves stored values. So this fails the migration, before anything relies on the
-- new rules, if a story written earlier doesn't fit them or a media item still carries the old
-- aspectRatio label. Nothing is rewritten: a story's media is the person's content, and changing
-- it needs their current consent (story_consent), so an operator fixes such a row deliberately.
-- On 2026-10-23 dev holds one story, 0003's written walking-skeleton story, which fits.
LET $stories = (SELECT VALUE id FROM story WHERE fn::story::shape_problem($this) != NONE);
IF array::len($stories) > 0 {
  THROW 'D53: these stories don’t fit the story types or shapes: ' + <string> $stories
    + '. Fix them (data/0004-check-story-shapes.surql), then migrate again';
};
LET $published = (SELECT VALUE id FROM publicStory WHERE array::len(media[WHERE aspectRatio != NONE]) > 0);
IF array::len($published) > 0 {
  THROW 'D53: these read-model rows still carry aspectRatio: ' + <string> $published
    + '. Re-sync them from their stories, then migrate again';
};

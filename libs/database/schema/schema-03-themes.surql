-- schema-03-themes.surql: theme categories, themes and the catalog's save fence.
-- Part of the declarative schema: every schema-NN-*.surql file, applied in name order in one
-- transaction (see schema-01-system.surql).

-- ---------------------------------------------------------------- themes (plan v3, 2026-10-31)
-- Admins manage categories and themes at /admin/themes; every story links
-- the themes it carries (themeRefs). One fixed category, themeCategory:other ("Other"), is where
-- a deleted category's themes go: nobody may delete or rename it. Other categories and every
-- theme have ULID ids. A theme is "highlighted" in its category: highlighted themes are shown
-- first wherever people choose or browse themes. No order, no version per row: categories and
-- themes are listed A-Z (Other last). Names are tidied and checked for duplicates by api-admin
-- (case-insensitive); there's no uniqueness rule here (two saves are serialised by themeCatalog).
DEFINE TABLE OVERWRITE themeCategory SCHEMAFULL PERMISSIONS     -- id = themeCategory:<ulid> | :other
  FOR select FULL,
  FOR create, update, delete WHERE $auth = service:api_admin;
DEFINE FIELD OVERWRITE name ON themeCategory TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 40;
-- Other can't be renamed, or deleted (by anyone, system users too). Deleting another category
-- moves its themes to Other, not highlighted (so Other's first-shown list doesn't fill with
-- whatever was deleted), in the same transaction, whoever deletes it.
DEFINE EVENT OVERWRITE themeCategory_other ON themeCategory
  WHEN $event != 'DELETE' AND $after.id = themeCategory:other AND $after.name != 'Other'
  THEN { THROW 'theme_category_fixed: the Other category can’t be deleted or renamed' };
DEFINE EVENT OVERWRITE themeCategory_delete ON themeCategory
  WHEN $event = 'DELETE'
  THEN {
    IF $before.id = themeCategory:other {
      THROW 'theme_category_fixed: the Other category can’t be deleted or renamed';
    };
    UPDATE theme SET category = themeCategory:other, highlighted = false
      WHERE category = $before.id RETURN NONE;
  };
DEFINE TABLE OVERWRITE theme SCHEMAFULL PERMISSIONS             -- id = theme:<ulid>
  FOR select FULL,
  FOR create, update, delete WHERE $auth = service:api_admin;
DEFINE FIELD OVERWRITE name        ON theme TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 40;
DEFINE FIELD OVERWRITE category    ON theme TYPE record<themeCategory>
  ASSERT record::exists($value);
DEFINE FIELD OVERWRITE highlighted ON theme TYPE bool DEFAULT false;
DEFINE INDEX OVERWRITE theme_category ON theme FIELDS category;
-- Deleting a theme removes it from every story that carries it, whoever deletes it, in the same
-- transaction (published stories included: R11, one story table). A story left with fewer themes than the minimum isn't re-checked; only its next
-- submission is (plan v3, A9). Removing a deleted theme isn't the person changing their story, so
-- needs no agreement (story_agreements checks the owner's writes only) and passes the owner's content lock
-- (that's the owner only).
-- A transaction reads a snapshot, so the delete's scan can miss a story write that adds the
-- theme and commits meanwhile (leaving a submitted story linking a deleted theme). Both write the
-- theme's fence (fence:theme-<id>; story_theme_fence below), so of two overlapping ones the second to
-- commit fails with a retryable conflict, and its retry sees the other. Per theme: stories adding
-- other themes never conflict.
DEFINE EVENT OVERWRITE theme_delete ON theme
  WHEN $event = 'DELETE'
  THEN {
    fn::fence::touch('theme', $before.id);
    DELETE type::record('fence', 'theme-' + <string> record::id($before.id));
    -- themeIds: its element index finds them (3.2.4 finds nothing through one over record links).
    UPDATE story SET themeRefs -= $before.id
      WHERE themeIds CONTAINS record::id($before.id) RETURN NONE;
  };
-- The themes' version (D29) for /admin/themes: api-admin's save checks it and adds 1 in the same
-- transaction, naming the admin, so of two admins saving from the same version one is refused
-- (and two overlapping saves conflict at commit). The row keeps who saved last (R3: no audit log).
DEFINE TABLE OVERWRITE themeCatalog SCHEMAFULL PERMISSIONS     -- id = themeCatalog:current
  FOR select FULL,
  FOR create, update WHERE $auth = service:api_admin,
  FOR delete NONE;
DEFINE FIELD OVERWRITE version       ON themeCatalog TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };
DEFINE FIELD OVERWRITE changedBy     ON themeCatalog TYPE option<record<user>>;
DEFINE FIELD OVERWRITE changedByRole ON themeCatalog TYPE option<string>
  ASSERT $value = NONE OR $value IN ['Admin', 'SuperAdmin'];
DEFINE FIELD OVERWRITE updatedAt     ON themeCatalog TYPE datetime VALUE time::now();
DEFINE EVENT OVERWRITE themeCatalog_check ON themeCatalog
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    IF $after.id != themeCatalog:current { THROW 'there is one theme catalogue record: themeCatalog:current' };
    IF $after.changedBy = NONE AND $auth != NONE { THROW 'a themes save names the admin who made it (changedBy)' };
  };

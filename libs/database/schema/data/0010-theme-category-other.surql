-- data/0010-theme-category-other.surql (runs once; recorded in _migration by the runner, in the
-- same transaction). Themes plan v3 (Joel, 2026-10-31): the fixed Other category, which nobody may
-- rename or delete, and where a deleted category's themes go. data/0008 created it while it
-- turned the old tags into themes; that script left the bundle with the tags (database review 2,
-- R1, 2026-11-05), so this keeps the category on a new database. UPSERT: a database that ran
-- 0008 (or dev-seed) has it already.
UPSERT themeCategory:other SET name = 'Other';

-- data/0008-theme-settings.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). O5 (Joel, 2026-10-31): themes are managed by admins and never deleted.
-- 1. Every tag made before `tag.nameKey` existed gets it (it's computed on write, and the unique
--    index skips rows without it), so names stay unique ignoring case from here on.
-- 2. The main themes record, with no main themes yet and 10 shown: an admin picks them at
--    /admin/themes (until then pickers show every theme). Changed later by api-admin only.
UPDATE tag;
CREATE themeSettings:current CONTENT {};

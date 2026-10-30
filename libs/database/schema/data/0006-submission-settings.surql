-- data/0006-submission-settings.surql (runs once; recorded in _migration by the runner, in the
-- same transaction). W3, D112 (Joel, 2026-10-28): the submission limits an admin adjusts, with
-- today's values (the field defaults: text 200 to 10,000 characters, 1 to 5 themes, 3 open
-- drafts, 1 submission in 7 days, 10 upload requests an hour). Changed later by api-admin only.
CREATE submissionSettings:current CONTENT {};

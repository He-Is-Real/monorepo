-- schema-06-settings-and-logs.surql: request keys, submission settings and limits, and the
-- submission log.
-- Part of the declarative schema: every schema-NN-*.surql file, applied in name order in one
-- transaction (see schema-01-system.surql).

-- ---------------------------------------------------------------- idempotencyKey (D29)
-- id = idempotencyKey:['api-user' | 'api-admin', <user record | 'svix' | 'stripe'>, <key>]
-- Scoped by the internal user record, not the Clerk id (review round 3): erasure clears the Clerk
-- id, so a key must not carry it. A person-scoped key needs a live user and bumps their fence;
-- erasure deletes their keys. Moderators and admins act through their own user record too (they
-- already need one for moderationReview.moderator).
-- A person's own commands run in their session (D27), so they commit their key in the SAME
-- transaction as the command (PR #41 review round 1: a key saved separately could be lost after
-- the command committed, and a retry then re-applied it). A person may create and read only
-- their own api-user keys; never update or delete them (erasure and pruning run as services).
-- R4 (Joel, 2026-11-05): a key is useless after expiresAt (nobody resends that late); the nightly
-- housekeeping Job deletes those, and may read and delete nothing else here.
DEFINE TABLE OVERWRITE idempotencyKey SCHEMAFULL PERMISSIONS
  FOR select WHERE $auth.id IN [service:api_user, service:api_admin]
    OR (record::id(id)[0] = 'api-user' AND record::id(id)[1] = $auth.id)
    OR ($auth.id = service:housekeeping AND expiresAt < time::now()),
  FOR create WHERE $auth.id IN [service:api_user, service:api_admin]
    OR (record::id(id)[0] = 'api-user' AND record::id(id)[1] = $auth.id
        AND $auth.status != 'deleted'),
  FOR update WHERE $auth.id IN [service:api_user, service:api_admin],
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin]
    OR ($auth.id = service:housekeeping AND expiresAt < time::now());
DEFINE FIELD OVERWRITE requestHash ON idempotencyKey TYPE string;           -- same key + different body -> 422
DEFINE FIELD OVERWRITE status      ON idempotencyKey TYPE int;
DEFINE FIELD OVERWRITE response    ON idempotencyKey TYPE option<object>;   -- {id, version} only:
DEFINE FIELD OVERWRITE response.id      ON idempotencyKey TYPE option<record>;  -- typed, so no
DEFINE FIELD OVERWRITE response.version ON idempotencyKey TYPE option<int>;     -- text can go in
-- 24 hours after it was written. Only a system user ($auth = NONE: the migrator, tests) may
-- supply another, as for story.updatedAt, so tests can age a key for the nightly delete (R4).
DEFINE FIELD OVERWRITE expiresAt   ON idempotencyKey TYPE datetime
  VALUE IF $auth = NONE AND $value != NONE { $value } ELSE { $before OR time::now() + 24h };
DEFINE EVENT OVERWRITE idempotencyKey_owner ON idempotencyKey
  WHEN true
  THEN {
    LET $owner = record::id(($after ?? $before).id)[1];
    IF $event = 'DELETE' {
      IF type::is_record($owner, 'user') { fn::fence::touch('person', $owner) };
    }
    ELSE IF type::is_record($owner, 'user') { fn::person::live($owner) }
    ELSE IF $owner NOT IN ['svix', 'stripe'] {
      THROW 'an idempotency key is scoped to a user record or a webhook provider';
    };
  };
DEFINE INDEX OVERWRITE idem_expiry ON idempotencyKey FIELDS expiresAt;     -- housekeeping's expired-request-keys

-- ---------------------------------------------------------------- submissionSettings (W3, D112)
-- The limits an admin adjusts (Joel, 2026-10-28: "adjustable from the admin account view"), one
-- record, submissionSettings:current, created by data/0006 with today's values (the defaults
-- here, so a missing field reads as them too):
--   storyTextMin / storyTextMax: a written story's text, trimmed, to submit / at most (A3);
--   themesMin / themesMax: how many themes a story needs when it is submitted (only then);
--   openDraftsMax, submissionsPer7Days: D94's limits per person (overridable per person);
--   uploadRequestsPerHour: new uploads (pictures too) per person in any rolling hour
--     (overridable; trusted too);
--   uploadsPer7Days: new video and audio files per person in any rolling 7 days, never pictures
--     (overridable; none if trusted; Joel, 2026-10-30);
--   videoMaxBytes / audioMaxBytes / mediaMaxSeconds: one file's size and length (A4: 4 GB and
--     500 MB, 15 minutes; trusted submitters get the hard ceilings, fn::settings::upload_ceilings).
--   The upload limits (D113, Joel 2026-10-28/30: stop people filling our video storage) are
--   checked when an upload is granted (uploadGrant_attach) and again at submit by api-user, with
--   the values in force then ("new rules apply to everyone", Joel 2026-10-30).
-- Everyone reads it (the submit page shows the numbers); only api-admin's login, naming the admin
-- in changedBy, and the migrator change it, never delete it; the row keeps who changed it last. Admins
-- change it at /admin/limits (api-admin's GET/PUT /v1/admin/submission-settings, If-Match on
-- `version`).
-- These are anti-spam and cost controls, not invariants (coordinator, Codex #118 round 2): a
-- change applies to writes that start after it commits; a write already in flight may finish
-- under the old values. No fence ties settings writes to story writes (it would touch every
-- person on each change). Concurrent writes by the same person still conflict on their fence.
DEFINE TABLE OVERWRITE submissionSettings SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create, update WHERE $auth.id = service:api_admin,
  FOR delete NONE;
DEFINE FIELD OVERWRITE storyTextMin  ON submissionSettings TYPE int DEFAULT 200 ASSERT $value >= 1;
DEFINE FIELD OVERWRITE storyTextMax  ON submissionSettings TYPE int DEFAULT 10000
  ASSERT $value >= 1 AND $value <= 50000;                    -- story.body's hard ceiling
DEFINE FIELD OVERWRITE themesMin     ON submissionSettings TYPE int DEFAULT 1
  ASSERT $value >= 0 AND $value <= 20;
DEFINE FIELD OVERWRITE themesMax     ON submissionSettings TYPE int DEFAULT 5
  ASSERT $value >= 0 AND $value <= 20;                       -- story.themeRefs' hard ceiling
DEFINE FIELD OVERWRITE openDraftsMax ON submissionSettings TYPE int DEFAULT 3
  ASSERT $value >= 1 AND $value <= 1000;
DEFINE FIELD OVERWRITE submissionsPer7Days ON submissionSettings TYPE int DEFAULT 1
  ASSERT $value >= 1 AND $value <= 1000;
DEFINE FIELD OVERWRITE uploadRequestsPerHour ON submissionSettings TYPE int DEFAULT 10
  ASSERT $value >= 1 AND $value <= 10000;
DEFINE FIELD OVERWRITE uploadsPer7Days ON submissionSettings TYPE int DEFAULT 5
  ASSERT $value >= 1 AND $value <= 1000;
DEFINE FIELD OVERWRITE videoMaxBytes ON submissionSettings TYPE int DEFAULT 4294967296   -- 4 GiB
  ASSERT $value >= 1 AND $value <= fn::settings::upload_ceilings().videoMaxBytes;
DEFINE FIELD OVERWRITE audioMaxBytes ON submissionSettings TYPE int DEFAULT 524288000    -- 500 MiB
  ASSERT $value >= 1 AND $value <= fn::settings::upload_ceilings().audioMaxBytes;
DEFINE FIELD OVERWRITE mediaMaxSeconds ON submissionSettings TYPE int DEFAULT 900        -- 15 minutes
  ASSERT $value >= 1 AND $value <= fn::settings::upload_ceilings().mediaMaxSeconds;
DEFINE FIELD OVERWRITE changedBy     ON submissionSettings TYPE option<record<user>>;
-- The admin's role when they made the change (a snapshot of the Clerk claim, D1); api-admin sets
-- it with changedBy.
DEFINE FIELD OVERWRITE changedByRole ON submissionSettings TYPE option<string>
  ASSERT $value = NONE OR $value IN ['Admin', 'SuperAdmin'];
DEFINE FIELD OVERWRITE version       ON submissionSettings TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29
DEFINE FIELD OVERWRITE updatedAt     ON submissionSettings TYPE datetime VALUE time::now();
DEFINE EVENT OVERWRITE submissionSettings_check ON submissionSettings
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    IF $after.id != submissionSettings:current { THROW 'there is one settings record: submissionSettings:current' };
    IF $after.storyTextMin > $after.storyTextMax { THROW 'storyTextMin is more than storyTextMax' };
    IF $after.themesMin > $after.themesMax { THROW 'themesMin is more than themesMax' };
    IF $after.changedBy = NONE AND $auth != NONE { THROW 'a settings change names the admin who made it (changedBy)' };
  };
-- The settings in force, with the defaults for anything missing (also before data/0006 ran).
DEFINE FUNCTION OVERWRITE fn::settings::submission() {
  LET $s = (SELECT * FROM ONLY submissionSettings:current);
  RETURN {
    storyTextMin: $s.storyTextMin ?? 200, storyTextMax: $s.storyTextMax ?? 10000,
    themesMin: $s.themesMin ?? 1, themesMax: $s.themesMax ?? 5,
    openDraftsMax: $s.openDraftsMax ?? 3, submissionsPer7Days: $s.submissionsPer7Days ?? 1,
    uploadRequestsPerHour: $s.uploadRequestsPerHour ?? 10,
    uploadsPer7Days: $s.uploadsPer7Days ?? 5,
    videoMaxBytes: $s.videoMaxBytes ?? 4294967296, audioMaxBytes: $s.audioMaxBytes ?? 524288000,
    mediaMaxSeconds: $s.mediaMaxSeconds ?? 900
  };
};
-- The most any setting may allow for one upload, and what a trusted submitter gets: 10 GiB of
-- video, 2 GiB of audio, 3 hours (a cost ceiling, not a product rule).
DEFINE FUNCTION OVERWRITE fn::settings::upload_ceilings() {
  RETURN { videoMaxBytes: 10737418240, audioMaxBytes: 2147483648, mediaMaxSeconds: 10800 };
};

-- ---------------------------------------------------------------- submitterLimits (D94, D112)
-- One person's limits, set by an admin (Joel, 2026-10-28: test accounts get values that don't
-- interfere with testing). id = submitterLimits:<user id>. `trusted` (the whitelist: e.g. the
-- church media team, pastors) lifts the open-drafts, weekly and upload limits but the hourly one
-- (fn::limits::effective); each other field, when
-- set, replaces that setting for this person (NONE = the setting). fn::limits::effective reads it.
-- Only api-admin's login (naming the admin in changedBy) and system users (the migrator,
-- dev-seed) write it; the row keeps who changed it last. An admin resets someone by updating the
-- row (trusted false, overrides NONE), never by deleting it, so the reset names them too; only
-- erasure deletes it (api-user's login), with the person.
-- `devSeed`: written by dev-seed for dev's test accounts, refused anywhere but dev.
DEFINE TABLE OVERWRITE submitterLimits SCHEMAFULL PERMISSIONS
  FOR select WHERE user = $auth.id OR $auth.id IN [service:api_user, service:api_admin],
  FOR create, update WHERE $auth.id = service:api_admin,
  FOR delete WHERE $auth.id = service:api_user;                        -- erasure only
DEFINE FIELD OVERWRITE user          ON submitterLimits TYPE record<user> READONLY
  ASSERT record::id($value) = record::id($this.id);
DEFINE FIELD OVERWRITE trusted       ON submitterLimits TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE openDraftsMax ON submitterLimits TYPE option<int>
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 1000);
DEFINE FIELD OVERWRITE submissionsPer7Days ON submitterLimits TYPE option<int>
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 1000);
DEFINE FIELD OVERWRITE uploadRequestsPerHour ON submitterLimits TYPE option<int>
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 10000);
DEFINE FIELD OVERWRITE uploadsPer7Days ON submitterLimits TYPE option<int>
  ASSERT $value = NONE OR ($value >= 1 AND $value <= 1000);
DEFINE FIELD OVERWRITE devSeed       ON submitterLimits TYPE bool DEFAULT false;
-- The admin who made this change (their own user record); NONE only from a system user.
DEFINE FIELD OVERWRITE changedBy     ON submitterLimits TYPE option<record<user>>;
DEFINE FIELD OVERWRITE updatedAt     ON submitterLimits TYPE datetime VALUE time::now();
DEFINE EVENT OVERWRITE submitterLimits_fence ON submitterLimits
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.user) }
    ELSE {
      fn::person::live($after.user);
      IF $after.changedBy = NONE AND $auth != NONE {
        THROW 'a change to someone’s limits names the admin who made it (changedBy)';
      };
      IF $after.devSeed = true AND (SELECT VALUE environment FROM ONLY _setting:current) != 'dev' {
        THROW 'dev-seed’s test-account limits are for dev only (D112)';
      };
    };
  };

-- ---------------------------------------------------------------- submissionLog (D113)
-- Each person's submissions for review in the last 7 days (Joel, 2026-10-28: the weekly limit
-- must hold when stories are deleted; his worry is people filling our video storage). One row per
-- first submission, written by story_limits (events run elevated) and pruned there; no story
-- link, so deleting a story leaves it. Person-linked: erasure deletes it. Nobody writes it
-- directly; the person reads their own (fn::story::next_submission_at).
DEFINE TABLE OVERWRITE submissionLog SCHEMAFULL PERMISSIONS
  FOR select WHERE person = $auth.id OR $auth.id IN [service:api_user, service:api_admin],
  FOR create, update NONE,
  FOR delete WHERE $auth.id = service:api_user;                        -- erasure
DEFINE FIELD OVERWRITE person ON submissionLog TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE at     ON submissionLog TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE submissionLog_person ON submissionLog FIELDS person, at;
DEFINE EVENT OVERWRITE submissionLog_fence ON submissionLog
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.person) }
    ELSE { fn::person::live($after.person) };
  };

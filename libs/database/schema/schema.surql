-- schema.surql: declarative schema v1 (draft, 2026-10-18)
-- Applied in full on every deploy by the migrator Job (D14); every statement is
-- OVERWRITE, so re-running is safe. Data changes go in data/NNNN-*.surql (run once,
-- recorded in _migration). CI applies this file to SurrealDB 3.2.4 on every PR, so any
-- syntax below that 3.2.4 rejects is caught before merge.
-- 3.2.4 gotchas found in testing (2026-10-18/19), each covered by a test in ../integration:
--   * a correlated subquery with ORDER BY … LIMIT 1 returns wrong rows; use array::last(… ORDER BY ASC)
--   * inside a subquery, a COMPUTED field's $parent is the OUTER query's record, not its own
--     (`SELECT (SELECT consent FROM story …) FROM user` saw the user): computed fields refer to
--     their own record's fields directly (`submitter`), never through $parent
--   * a write the PERMISSIONS deny returns an empty result, not an error; so does an ALLOWED
--     write on a table the caller can't SELECT (e.g. api_user creating auditLog rows)
--   * for a `service` session, `$auth.id` is NONE in queries (the service table is PERMISSIONS
--     NONE) but resolves inside PERMISSIONS clauses; in queries use `$auth` itself
--   * $auth is not usable in a field VALUE (it is in events), so identity checks live in PERMISSIONS/events
--   * DEFAULT accepts a client-supplied value; server-controlled fields use VALUE (… READONLY)

-- ---------------------------------------------------------------- bookkeeping
DEFINE TABLE OVERWRITE _migration SCHEMAFULL PERMISSIONS NONE; -- id = _migration:`0001-seed-dpa-v1`
DEFINE FIELD OVERWRITE appliedAt ON _migration TYPE datetime VALUE $before OR time::now() READONLY;

-- ---------------------------------------------------------------- identities (D13 B, D27 B)
-- Services sign in as `service` records (secret hashes written by the init Job from Secret
-- Manager): service:api_public_read, :api_user, :api_admin, :workflow. People reach SurrealDB
-- only through api-user, in a session opened with their own Clerk token. In-cluster system
-- users remain: migrator (OWNER, schema + seeds) and backup (VIEWER, nightly export).
DEFINE TABLE OVERWRITE service SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE secretHash ON service TYPE string;
DEFINE ACCESS OVERWRITE svc ON DATABASE TYPE RECORD
  SIGNIN (SELECT * FROM service WHERE id = type::record('service', $name)
          AND crypto::argon2::compare(secretHash, $secret))
  DURATION FOR TOKEN 15m, FOR SESSION 12h;
-- Clerk's PEM public key is pinned by Terraform: GKE has no internet egress to fetch the JWKS.
-- Tokens come from a Clerk JWT template carrying the ns/db/ac claims SurrealDB needs.
-- An already-open person session outlives erasure (up to its 5m session), so every person write
-- below also checks `$auth.gdprDeletedAt = NONE`: $auth is a record id, so this reads the user
-- row as it is now, not a snapshot from sign-in.
DEFINE ACCESS OVERWRITE clerk ON DATABASE TYPE RECORD
  WITH JWT ALGORITHM RS256 KEY '${clerk_jwt_public_key}'
  AUTHENTICATE (SELECT VALUE id FROM user WHERE clerkUserId = $token.sub AND gdprDeletedAt = NONE LIMIT 1)[0]
  DURATION FOR SESSION 5m;

-- ---------------------------------------------------------------- user (D16, D1, D22)
-- Only a reference to the Clerk user. Email, name and country live in Clerk (D16);
-- roles live in Clerk (D1). A legacy person (D22) has no Clerk account yet: NONE, linked
-- by an admin if they sign up later.
DEFINE TABLE OVERWRITE user SCHEMAFULL PERMISSIONS
  FOR select WHERE id = $auth.id OR $auth.id IN [service:api_user, service:api_admin, service:workflow],
  FOR create WHERE $auth.id = service:api_user,                       -- created on first use
  FOR update WHERE $auth.id IN [service:api_user, service:api_admin], -- erasure (gdprDeletedAt)
  FOR delete NONE;
-- The identity binding (D37). Set once: by api-admin linking a legacy person (or on create by
-- api-user). Cleared once: by api-user's erasure, in the same update that sets gdprDeletedAt,
-- leaving a stub (internal id + gdprDeletedAt) that the retained consent ledger still points to.
-- Never changed otherwise, and never set again after erasure: a compromised service must not
-- point a victim's record at its own token.
DEFINE FIELD OVERWRITE clerkUserId   ON user TYPE option<string>
  PERMISSIONS FOR update WHERE $auth IN [service:api_admin, service:api_user] OR $auth = NONE;
DEFINE EVENT OVERWRITE user_clerk_binding ON user
  WHEN $event = 'UPDATE' AND $before.clerkUserId != $after.clerkUserId
   AND !(
     -- link a legacy person who has no Clerk account yet (api-admin; the migrator)
     ($before.clerkUserId = NONE AND $before.gdprDeletedAt = NONE AND $after.gdprDeletedAt = NONE
       AND $auth != service:api_user)
     -- erasure: api-user clears it once, at the moment gdprDeletedAt is set
     OR ($after.clerkUserId = NONE AND $before.gdprDeletedAt = NONE AND $after.gdprDeletedAt != NONE
       AND $auth = service:api_user)
   )
  THEN { THROW 'clerkUserId can only be linked once, or cleared once at erasure' };
-- Erasure is final and always leaves a stub without a Clerk id (D37).
DEFINE EVENT OVERWRITE user_erasure_final ON user
  WHEN $event = 'UPDATE' AND (
     ($before.gdprDeletedAt != NONE AND $after.gdprDeletedAt != $before.gdprDeletedAt)
     OR ($after.gdprDeletedAt != NONE AND $after.clerkUserId != NONE))
  THEN { THROW 'an erased user stays erased, without a clerkUserId' };
DEFINE FIELD OVERWRITE createdAt     ON user TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE gdprDeletedAt ON user TYPE option<datetime>;
DEFINE INDEX OVERWRITE user_clerk    ON user FIELDS clerkUserId UNIQUE;

-- ---------------------------------------------------------------- tag
DEFINE TABLE OVERWRITE tag SCHEMAFULL PERMISSIONS               -- id = tag:<slug>, e.g. tag:doubt
  FOR select FULL,
  FOR create, update, delete WHERE $auth.id = service:api_admin;
DEFINE FIELD OVERWRITE name      ON tag TYPE string ASSERT string::len($value) > 0 AND string::len($value) <= 40;
DEFINE FIELD OVERWRITE category  ON tag TYPE string ASSERT $value IN ['theme', 'journey', 'emotion'];
DEFINE FIELD OVERWRITE version       ON tag TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29
DEFINE FIELD OVERWRITE createdAt ON tag TYPE datetime VALUE $before OR time::now() READONLY;

-- ---------------------------------------------------------------- story (write model)
-- A person's commands run in their own session (D27), so ownership is checked by the database.
-- api-user's own login can only delete (erasure): it can't read, create, reassign or edit stories.
-- Write scope per field (D41): the person's words (content fields) only by the person; moderation
-- fields only by api-admin; media/processing fields by the person and workflow. A field write
-- outside its scope is silently dropped (field PERMISSIONS), so check the stored state.
DEFINE TABLE OVERWRITE story SCHEMAFULL PERMISSIONS               -- id = story:<ulid>
  FOR select WHERE submitter = $auth.id OR $auth.id IN [service:api_admin, service:workflow],
  FOR create WHERE submitter = $auth.id AND status = 'draft'                -- own draft only,
    AND $auth.gdprDeletedAt = NONE                                          -- not erased, and only
    AND fn::consent::granted(submitter, ['special_category_religious']),    -- with current Art 9 consent
  FOR update WHERE (submitter = $auth.id AND $auth.gdprDeletedAt = NONE)
    OR $auth.id IN [service:api_admin, service:workflow],
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin];   -- erasure
DEFINE FIELD OVERWRITE submitter     ON story TYPE record<user> READONLY;   -- owner can never be reassigned
DEFINE FIELD OVERWRITE version       ON story TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29: +1 on every command; ETag
-- Content: what the person wrote. Never api-admin or workflow (D41); moderators request changes.
DEFINE FIELD OVERWRITE slug          ON story TYPE string           -- generated at create, unique
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE title         ON story TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 140
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE description   ON story TYPE string ASSERT string::len($value) <= 5000
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE body          ON story TYPE option<string>   -- written stories
  ASSERT $value = NONE OR string::len($value) <= 20000
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE bylineName    ON story TYPE option<string>   -- story content chosen per story (D16); NONE = anonymous
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE primaryFormat ON story TYPE string ASSERT $value IN ['video', 'audio', 'written']
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE tagRefs       ON story TYPE array<record<tag>> DEFAULT []
  ASSERT array::len($value) <= 5                              -- D15: no denormalised tags[]
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- Status: the owner (submit/withdraw, checked by the events below) and api-admin (moderation).
DEFINE FIELD OVERWRITE status        ON story TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'pending', 'in_review', 'approved', 'rejected', 'changes_requested', 'withdrawn']
  PERMISSIONS FOR update WHERE $auth != service:workflow;
-- Media and processing fields: the person (upload) and workflow (M7 processing); never api-admin.
-- Each nested field carries the same rule, so `SET media[0].x = …` is covered too.
DEFINE FIELD OVERWRITE media                    ON story TYPE array<object> DEFAULT []
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].format          ON story TYPE string ASSERT $value IN ['video', 'audio']
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].bunnyVideoId    ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].thumbnailPath   ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].aspectRatio     ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].durationSeconds ON story TYPE option<int>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
-- M7 adds media[*].rawTranscriptText / transcriptText / captionsUrl / aiSummary, with the same rule.
-- D17: consent is per person; a story derives it from its submitter's current ledger state.
-- Not stored, so it can't drift: withdrawing or re-consenting changes every story at once.
-- Uses the record's own `submitter`, never $parent (see the 3.2.4 gotchas at the top).
DEFINE FIELD OVERWRITE consent ON story COMPUTED {
  religious: fn::consent::current(submitter, 'special_category_religious'),
  publish:   fn::consent::current(submitter, 'publish'),
  share:     fn::consent::current(submitter, 'share_socials'),
  age18plus: fn::consent::current(submitter, 'age_18plus')
};
DEFINE FIELD OVERWRITE submittedAt   ON story TYPE option<datetime>   -- set by the server on first submit
  VALUE IF $this.status = 'pending' { $before OR time::now() } ELSE { $before };
DEFINE FIELD OVERWRITE createdAt     ON story TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE updatedAt     ON story TYPE datetime VALUE time::now();
-- Moderation fields: only api-admin (D41; not workflow).
DEFINE FIELD OVERWRITE lockedBy      ON story TYPE option<record<user>>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
DEFINE FIELD OVERWRITE lockedAt      ON story TYPE option<datetime>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
DEFINE FIELD OVERWRITE rejectionFeedback ON story TYPE option<string>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
DEFINE FIELD OVERWRITE approvedAt    ON story TYPE option<datetime>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
-- The content fields as one value, for comparing before/after.
DEFINE FUNCTION OVERWRITE fn::story::content($s: any) {
  RETURN {
    slug: $s.slug, title: $s.title, description: $s.description, body: $s.body,
    bylineName: $s.bylineName, primaryFormat: $s.primaryFormat, tagRefs: $s.tagRefs, media: $s.media
  };
};
-- Once a story leaves draft/changes_requested, its owner can no longer change its content
-- (only withdraw it); what a moderator reviewed is what gets published.
DEFINE EVENT OVERWRITE story_owner_content_lock ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth
   AND $before.status NOT IN ['draft', 'changes_requested']
   AND fn::story::content($before) != fn::story::content($after)
  THEN { THROW 'story content is locked after submission' };
-- The owner may only move their story draft/changes_requested → pending, or withdraw it.
DEFINE EVENT OVERWRITE story_owner_transitions ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth AND $before.status != $after.status
   AND !(($before.status IN ['draft', 'changes_requested'] AND $after.status = 'pending')
         OR $after.status = 'withdrawn')
  THEN { THROW 'status change not allowed for the story owner' };
-- Consent at every step that processes testimony (D17, D21; the API plan's ⚑ routes):
--   create, edit, upload (content/media change) → current Art 9 consent (create: table permission);
--   submit (→ pending) and approve (→ approved)  → Art 9 + publish + age_18plus.
-- Withdrawing (→ withdrawn, content unchanged) and erasure (DELETE) need none.
DEFINE EVENT OVERWRITE story_owner_consent ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth
  THEN {
    IF fn::story::content($before) != fn::story::content($after)
       AND !fn::consent::granted($after.submitter, ['special_category_religious']) {
      THROW 'editing a story needs current Art 9 consent';
    };
    IF $after.status = 'pending' AND $before.status != 'pending'
       AND !fn::consent::granted($after.submitter, ['special_category_religious', 'publish', 'age_18plus']) {
      THROW 'submitting a story needs current Art 9, publish and age consent';
    };
  };
DEFINE EVENT OVERWRITE story_approval_consent ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status = 'approved' AND $before.status != 'approved'
   AND !fn::consent::granted($after.submitter, ['special_category_religious', 'publish', 'age_18plus'])
  THEN { THROW 'approving a story needs the submitter’s current Art 9, publish and age consent' };
-- Erasure: api-user's login may delete stories but can't read them, so it can't find their
-- read-model rows or reviews (both are reached through story.submitter). Deleting a story
-- removes them in the same transaction, whoever deletes it.
DEFINE EVENT OVERWRITE story_erasure_cascade ON story
  WHEN $event = 'DELETE'
  THEN {
    DELETE type::record('publicStory', record::id($before.id));
    DELETE moderationReview WHERE story = $before.id;
  };
DEFINE INDEX OVERWRITE story_slug      ON story FIELDS slug UNIQUE;
DEFINE INDEX OVERWRITE story_queue     ON story FIELDS status, submittedAt;
DEFINE INDEX OVERWRITE story_submitter ON story FIELDS submitter, createdAt;

-- ---------------------------------------------------------------- publicStory (read model, D25/D26)
-- Approved stories only, written in the same transaction as the command that changes them.
-- Same id as the story (publicStory:<ulid>). No submitter, consent, raw transcript,
-- moderation or quality data. An Art 9 location: erasure deletes it in the same transaction.
DEFINE TABLE OVERWRITE publicStory SCHEMAFULL PERMISSIONS
  FOR select FULL,                                                      -- api-public-read and everyone
  FOR create, update WHERE $auth.id = service:api_admin,                -- approve, edit
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin]    -- erasure
    OR (type::record('story', record::id(id)).submitter = $auth.id      -- owner withdraws
        AND $auth.gdprDeletedAt = NONE);
DEFINE FIELD OVERWRITE version       ON publicStory TYPE int;           -- mirrors story.version (ETag)
DEFINE FIELD OVERWRITE slug          ON publicStory TYPE string;
DEFINE FIELD OVERWRITE slugHistory   ON publicStory TYPE array<string> DEFAULT [];  -- D30: old slugs → 301
DEFINE FIELD OVERWRITE title         ON publicStory TYPE string;
DEFINE FIELD OVERWRITE description   ON publicStory TYPE string;
DEFINE FIELD OVERWRITE body          ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE bylineName    ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE primaryFormat ON publicStory TYPE string;
DEFINE FIELD OVERWRITE tagRefs       ON publicStory TYPE array<record<tag>>;
DEFINE FIELD OVERWRITE media         ON publicStory TYPE array<object>;  -- playback fields only
DEFINE FIELD OVERWRITE media[*].format        ON publicStory TYPE string;
DEFINE FIELD OVERWRITE media[*].bunnyVideoId  ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE media[*].thumbnailPath ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE media[*].aspectRatio   ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE publishedAt   ON publicStory TYPE datetime;
DEFINE FIELD OVERWRITE updatedAt     ON publicStory TYPE datetime VALUE time::now();
-- A full-text index covers one field, so search goes over a computed field.
DEFINE FIELD OVERWRITE searchText    ON publicStory TYPE string
  VALUE string::join(' ', title, description, body ?? '');
-- D41 + D17: the read model can only publish what the person wrote, for an approved story whose
-- submitter currently consents. Otherwise api-admin (which writes this table) could publish text
-- the person never wrote, or keep publishing after consent is withdrawn.
DEFINE EVENT OVERWRITE publicStory_mirrors_story ON publicStory
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $s = (SELECT * FROM ONLY type::record('story', record::id($after.id)));
    IF $s = NONE OR $s.status != 'approved' {
      THROW 'publicStory needs an approved story with the same id';
    };
    IF [$after.slug, $after.title, $after.description, $after.body, $after.bylineName,
        $after.primaryFormat, $after.tagRefs]
       != [$s.slug, $s.title, $s.description, $s.body, $s.bylineName, $s.primaryFormat, $s.tagRefs]
       OR $after.media.map(|$m| [$m.format, $m.bunnyVideoId, $m.thumbnailPath, $m.aspectRatio])
       != $s.media.map(|$m| [$m.format, $m.bunnyVideoId, $m.thumbnailPath, $m.aspectRatio]) {
      THROW 'publicStory must mirror the approved story’s content';
    };
    IF !fn::consent::granted($s.submitter, ['special_category_religious', 'publish', 'age_18plus']) {
      THROW 'publishing needs the submitter’s current Art 9, publish and age consent';
    };
  };
DEFINE ANALYZER OVERWRITE story_en TOKENIZERS blank, class FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX OVERWRITE publicStory_slug     ON publicStory FIELDS slug UNIQUE;
DEFINE INDEX OVERWRITE publicStory_slughist ON publicStory FIELDS slugHistory;
DEFINE INDEX OVERWRITE publicStory_browse   ON publicStory FIELDS publishedAt;
DEFINE INDEX OVERWRITE publicStory_tags     ON publicStory FIELDS tagRefs;
DEFINE INDEX OVERWRITE publicStory_fts      ON publicStory FIELDS searchText
  FULLTEXT ANALYZER story_en BM25 HIGHLIGHTS;                -- 3.x syntax (was SEARCH ANALYZER)

-- ---------------------------------------------------------------- dpaVersion (D20)
DEFINE TABLE OVERWRITE dpaVersion SCHEMAFULL PERMISSIONS        -- id = dpaVersion:v1
  FOR select WHERE status = 'published' OR $auth.id = service:api_admin,
  FOR create, update WHERE $auth.id = service:api_admin,
  FOR delete NONE;
DEFINE FIELD OVERWRITE kind          ON dpaVersion TYPE string DEFAULT 'standard'
  ASSERT $value IN ['standard', 'legacy'];                    -- D22: dpaVersion:legacy-squarespace
DEFINE FIELD OVERWRITE status        ON dpaVersion TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'published'];
DEFINE FIELD OVERWRITE materiality   ON dpaVersion TYPE string ASSERT $value IN ['minor', 'material'];
DEFINE FIELD OVERWRITE documentPath  ON dpaVersion TYPE string;  -- libs/legal/dpa/v1.md
DEFINE FIELD OVERWRITE contentHash   ON dpaVersion TYPE string   -- sha256 of the file, computed by Terraform (filesha256)
  ASSERT string::len($value) = 64;
DEFINE FIELD OVERWRITE changeSummary ON dpaVersion TYPE option<string>;
DEFINE FIELD OVERWRITE supersedes    ON dpaVersion TYPE option<record<dpaVersion>>;
DEFINE FIELD OVERWRITE effectiveFrom ON dpaVersion TYPE option<datetime>;
DEFINE FIELD OVERWRITE version       ON dpaVersion TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29
DEFINE FIELD OVERWRITE createdAt     ON dpaVersion TYPE datetime VALUE $before OR time::now() READONLY;
-- Published versions are immutable. Events fire for every user, including EDITOR system users
-- (who could still REMOVE EVENT; see D13).
DEFINE EVENT OVERWRITE dpa_immutable ON dpaVersion
  WHEN $event IN ['UPDATE', 'DELETE'] AND $before.status = 'published'
  THEN { THROW 'published DPA versions are immutable' };

-- ---------------------------------------------------------------- consent ledger (append-only)
-- Per person only (D17), no cache on user (D18), no IP address (D19).
DEFINE TABLE OVERWRITE consent SCHEMAFULL PERMISSIONS
  FOR select WHERE subject = $auth.id OR $auth.id IN [service:api_admin, service:workflow],
  FOR create WHERE subject = $auth.id AND $auth.gdprDeletedAt = NONE,  -- only in the person's own session
  FOR update, delete NONE;                                              -- plus the append-only event
DEFINE FIELD OVERWRITE subject      ON consent TYPE record<user> REFERENCE;  -- user:x<~consent lists a person's events
DEFINE FIELD OVERWRITE type         ON consent TYPE string
  ASSERT $value IN ['special_category_religious', 'publish', 'share_socials', 'age_18plus'];
DEFINE FIELD OVERWRITE dpaVersion   ON consent TYPE record<dpaVersion>;
DEFINE FIELD OVERWRITE event        ON consent TYPE string ASSERT $value IN ['granted', 'withdrawn'];
DEFINE FIELD OVERWRITE mechanism    ON consent TYPE string
  ASSERT $value IN ['web_form_submission', 'account_settings', 'reconsent_prompt', 'legacy_import'];
DEFINE FIELD OVERWRITE evidenceHash ON consent TYPE string ASSERT string::len($value) = 64;  -- sha256(presented text + checkbox states)
DEFINE FIELD OVERWRITE legacyGivenAt ON consent TYPE option<datetime>;  -- D22: original date, legacy imports only
DEFINE FIELD OVERWRITE occurredAt   ON consent TYPE datetime VALUE time::now() READONLY;   -- server time only
DEFINE INDEX OVERWRITE consent_latest ON consent FIELDS subject, type, occurredAt;  -- D18: "latest event" lookup
-- The single definition of "current consent" (D17). Index range scan over one person's
-- events of one type (a handful of rows); array::last avoids the LIMIT bug above.
DEFINE FUNCTION OVERWRITE fn::consent::current($user: option<record<user>>, $type: string) {
  IF $user = NONE { RETURN NONE };
  RETURN array::last((SELECT event, dpaVersion, occurredAt FROM consent
    WHERE subject = $user AND type = $type ORDER BY occurredAt ASC));
};
-- Whether every listed consent type is currently granted. Runs with the caller's permissions:
-- whoever can't read the person's ledger gets false (fail closed).
DEFINE FUNCTION OVERWRITE fn::consent::granted($user: option<record<user>>, $types: array<string>) {
  RETURN $user != NONE
    AND array::len(array::filter($types, |$t| fn::consent::current($user, $t).event = 'granted'))
      = array::len($types);
};
-- Legacy consent (D22) may only be written by the in-cluster migrator (a system user: $auth = NONE).
DEFINE EVENT OVERWRITE consent_legacy_only_migrator ON consent
  WHEN $event = 'CREATE' AND $auth != NONE
   AND ($after.mechanism = 'legacy_import' OR $after.dpaVersion.kind = 'legacy' OR $after.legacyGivenAt != NONE)
  THEN { THROW 'legacy consent can only be imported by the migrator' };
DEFINE EVENT OVERWRITE consent_append_only ON consent
  WHEN $event != 'CREATE' THEN { THROW 'consent ledger is append-only' };
DEFINE EVENT OVERWRITE consent_published_dpa ON consent
  WHEN $event = 'CREATE' AND $after.dpaVersion.status != 'published'
  THEN { THROW 'consent can only be given against a published DPA version' };  -- D20

-- ---------------------------------------------------------------- moderationReview (audit, M3)
DEFINE TABLE OVERWRITE moderationReview SCHEMAFULL PERMISSIONS
  FOR select, create WHERE $auth.id = service:api_admin,
  FOR update NONE,
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin];   -- erasure
DEFINE FIELD OVERWRITE story       ON moderationReview TYPE record<story>;
DEFINE FIELD OVERWRITE moderator   ON moderationReview TYPE record<user>;
DEFINE FIELD OVERWRITE decision    ON moderationReview TYPE string
  ASSERT $value IN ['approve', 'reject', 'request_changes', 'escalate'];  -- one per command (D28)
DEFINE FIELD OVERWRITE feedbackToSubmitter ON moderationReview TYPE option<string>;
DEFINE FIELD OVERWRITE storyVersion ON moderationReview TYPE int;      -- the version reviewed (D29)
DEFINE FIELD OVERWRITE decidedAt   ON moderationReview TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE review_story ON moderationReview FIELDS story, decidedAt;
DEFINE EVENT OVERWRITE review_append_only ON moderationReview
  WHEN $event = 'UPDATE' THEN { THROW 'moderation reviews are append-only' };  -- DELETE allowed for erasure

-- ---------------------------------------------------------------- auditLog (append-only, D38)
-- Who did what to which record, with typed fields per action and no free-form payload, so
-- testimony text has nowhere to go. Story ids stay after erasure (they then point nowhere).
-- Retention (D38, decided 2026-10-19): 6 years (for an erased person, from erasure), then
-- deleted by a nightly clean-up job running as the migrator (D14; not built yet). Same for consent.
DEFINE TABLE OVERWRITE auditLog SCHEMAFULL PERMISSIONS
  FOR select WHERE $auth.id = service:api_admin,
  FOR create WHERE $auth.id IN [service:api_user, service:api_admin, service:workflow],
  FOR update, delete NONE;                                              -- pruning: migrator only
DEFINE FIELD OVERWRITE service    ON auditLog TYPE string ASSERT $value IN ['api-user', 'api-admin', 'workflow', 'migrator'];
DEFINE FIELD OVERWRITE action     ON auditLog TYPE string ASSERT $value IN [
  -- api-user (M2)
  'CreateDraftStory', 'EditStory', 'RequestUpload', 'SubmitStory', 'WithdrawStory',
  'GrantConsent', 'WithdrawConsent', 'UpdateAccount', 'EraseAccount',
  -- api-admin (M3, M5)
  'LockStory', 'ReleaseStory', 'ApproveStory', 'RejectStory', 'RequestStoryChanges', 'EscalateStory',
  'AssignRole', 'LinkLegacyUser', 'SetFeaturedStories', 'CreateTag', 'UpdateTag', 'DeleteTag',
  'CreateDpaDraft', 'PublishDpa',
  -- workflow (M7)
  'ProcessMedia'
];
DEFINE FIELD OVERWRITE actor      ON auditLog TYPE option<record<user>>;  -- NONE = system/job
DEFINE FIELD OVERWRITE actorRole  ON auditLog TYPE option<string>         -- snapshot of the Clerk claim (D1)
  ASSERT $value = NONE OR $value IN ['Viewer', 'User', 'Moderator', 'Admin', 'SuperAdmin'];
DEFINE FIELD OVERWRITE entity     ON auditLog TYPE option<record>;        -- story, user, tag, dpaVersion…
DEFINE FIELD OVERWRITE storyVersion ON auditLog TYPE option<int>;         -- the version acted on (D29)
DEFINE FIELD OVERWRITE fromStatus ON auditLog TYPE option<string>
  ASSERT $value = NONE OR $value IN ['draft', 'pending', 'in_review', 'approved', 'rejected', 'changes_requested', 'withdrawn'];
DEFINE FIELD OVERWRITE toStatus   ON auditLog TYPE option<string>
  ASSERT $value = NONE OR $value IN ['draft', 'pending', 'in_review', 'approved', 'rejected', 'changes_requested', 'withdrawn'];
DEFINE FIELD OVERWRITE consentType ON auditLog TYPE option<string>
  ASSERT $value = NONE OR $value IN ['special_category_religious', 'publish', 'share_socials', 'age_18plus'];
DEFINE FIELD OVERWRITE dpaVersion ON auditLog TYPE option<record<dpaVersion>>;
DEFINE FIELD OVERWRITE role       ON auditLog TYPE option<string>         -- AssignRole: the role given
  ASSERT $value = NONE OR $value IN ['Viewer', 'User', 'Moderator', 'Admin', 'SuperAdmin'];
DEFINE FIELD OVERWRITE reason     ON auditLog TYPE option<string>         -- a code, never free text
  ASSERT $value = NONE OR $value IN ['account_deleted', 'consent_withdrawn', 'clerk_user_deleted'];  -- D39 erasure callers
DEFINE FIELD OVERWRITE createdAt  ON auditLog TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE audit_entity ON auditLog FIELDS entity, createdAt;
DEFINE EVENT OVERWRITE audit_append_only ON auditLog
  WHEN $event = 'UPDATE' THEN { THROW 'audit log is append-only' };      -- DELETE: retention pruning only

-- ---------------------------------------------------------------- idempotencyKey (D29)
-- id = idempotencyKey:['api-user' | 'api-admin', <clerkUserId | 'svix' | 'stripe'>, <key>]
DEFINE TABLE OVERWRITE idempotencyKey SCHEMAFULL PERMISSIONS
  FOR select, create, update, delete WHERE $auth.id IN [service:api_user, service:api_admin];
DEFINE FIELD OVERWRITE requestHash ON idempotencyKey TYPE string;           -- same key + different body → 422
DEFINE FIELD OVERWRITE status      ON idempotencyKey TYPE int;
DEFINE FIELD OVERWRITE response    ON idempotencyKey TYPE option<object> FLEXIBLE;  -- {id, version} only
DEFINE FIELD OVERWRITE expiresAt   ON idempotencyKey TYPE datetime VALUE $before OR time::now() + 24h;
DEFINE INDEX OVERWRITE idem_expiry ON idempotencyKey FIELDS expiresAt;     -- pruned by the nightly job

-- Later milestones add (same file): favourited/seen edges (M2), donor/donation (M4),
-- featuredStories (M5), helped/concern edges + trust/quality fields (M6), embedOrigin (M8).


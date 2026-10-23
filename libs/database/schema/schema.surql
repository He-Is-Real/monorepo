-- schema.surql: declarative schema v1 (draft, 2026-10-18)
-- Applied in full, in one transaction, on every migration by the migrator Job (D14; runner:
-- infra/k8s/surrealdb/base/migrate.py). Every statement is OVERWRITE, so re-running is safe.
-- Declarative means: what's here is defined; nothing is removed by deleting it from this
-- file (write an explicit REMOVE ... IF EXISTS). Data changes go in data/NNNN-*.surql (run once,
-- recorded in _migration). DEFINE ACCESS clerk is in access-clerk.surql (applied only when
-- Terraform has Clerk's key). No top-level RETURN: inside the transaction it would end it early.
-- CI applies this file to SurrealDB 3.2.4 on every PR, so any syntax below that 3.2.4 rejects
-- is caught before merge.
-- 3.2.4 gotchas found in testing (2026-10-18/19), each covered by a test in ../integration:
--   * a correlated subquery with ORDER BY ... LIMIT 1 returns wrong rows; use array::last(... ORDER BY ASC)
--   * inside a subquery, a COMPUTED field's $parent is the OUTER query's record, not its own
--     (`SELECT (SELECT consent FROM story ...) FROM user` saw the user): computed fields refer to
--     their own record's fields directly (`submitter`), never through $parent
--   * a write the PERMISSIONS deny returns an empty result, not an error; so does an ALLOWED
--     write on a table the caller can't SELECT (e.g. api_user creating auditLog rows)
--   * for a `service` session, `$auth.id` is NONE in queries (the service table is PERMISSIONS
--     NONE) but resolves inside PERMISSIONS clauses; in queries use `$auth` itself
--   * EVENTS RUN WITH ELEVATED PRIVILEGES: an event fired by a person's write could write a
--     PERMISSIONS NONE table. Events are trusted code; they must only write what they intend
--   * transactions read a SNAPSHOT: a permission/consent/erasure check can pass while another
--     transaction commits the opposite. Only write-write conflicts abort (the second commit
--     fails, "Transaction conflict ... can be retried"); hence personFence below
--   * $auth IS usable in a field VALUE (the 2026-10-18 draft said otherwise; tested 2026-10-20):
--     user.gdprDeletedAt uses it to let only the migrator supply a historical date
--   * DEFAULT accepts a client-supplied value; server-controlled fields use VALUE (... READONLY)
--   * inside a function a caller's bound variable shadows a DEFINE PARAM (2026-10-23), so no
--     switch a caller mustn't control lives in a param (D48 uses the _setting row)
--   * array<object> items store undefined keys (media[0].junk), unlike nested objects
--     (image.junk is refused), and REMOVE FIELD keeps stored values: fn::story::shape_problem
--     checks media keys, data/0004 checks rows written earlier

-- ---------------------------------------------------------------- bookkeeping
-- One row per data script, written by the runner in the script's own transaction (so a failed
-- script leaves no row). checksum = sha256 of the file: an applied script that changes later
-- fails the migration (write a new script instead).
DEFINE TABLE OVERWRITE _migration SCHEMAFULL PERMISSIONS NONE; -- id = _migration:`0001-seed-dpa-v1`
DEFINE FIELD OVERWRITE appliedAt ON _migration TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE checksum  ON _migration TYPE string ASSERT string::len($value) = 64 READONLY;
-- Fencing token (migrate.py): each run takes the next token; every mutating step checks it is
-- still the newest and writes this row, so a run that started later always wins.
DEFINE TABLE OVERWRITE _migrationRun SCHEMAFULL PERMISSIONS NONE;     -- id = _migrationRun:lock
DEFINE FIELD OVERWRITE token     ON _migrationRun TYPE int;
DEFINE FIELD OVERWRITE bundle    ON _migrationRun TYPE string;          -- sha256 of files + parameters
DEFINE FIELD OVERWRITE takenAt   ON _migrationRun TYPE datetime;
DEFINE FIELD OVERWRITE touchedAt ON _migrationRun TYPE option<datetime>;
-- A step in progress: committed before the step, deleted as the step's last write. A row left
-- behind means the step may have committed partly: migrations stop until an operator clears it.
DEFINE TABLE OVERWRITE _migrationPending SCHEMAFULL PERMISSIONS NONE; -- id = the step
DEFINE FIELD OVERWRITE token     ON _migrationPending TYPE int;
DEFINE FIELD OVERWRITE startedAt ON _migrationPending TYPE datetime;
-- _identity:current is written by SurrealDB's startup init (init.surql.tmpl), last in its
-- transaction: the identity config the running server started with. _identity:verified is
-- written by the identity-check sidecar once it has signed in with the intended credentials;
-- the migrate Job waits for it. Same definition as in the init.
DEFINE TABLE OVERWRITE _identity SCHEMAFULL PERMISSIONS NONE;     -- id = _identity:current
DEFINE FIELD OVERWRITE hash      ON _identity TYPE string;
DEFINE FIELD OVERWRITE appliedAt ON _identity TYPE datetime;

-- Settings from OpenTofu's parameters, written by the runner in the schema step of every
-- migration (migrate.py, SETTINGS). Everyone may read them (functions run with the caller's
-- permissions); only system users write. A row, not DEFINE PARAM: inside a function a caller's
-- bound variable shadows a defined param (3.2.4, tested), so a person could set their own.
-- _setting:consent (D48): consent checks relaxed for dummy data, in dev only. OpenTofu refuses the
-- variable outside dev; this event refuses the row outside dev too, whoever writes it.
DEFINE TABLE OVERWRITE _setting SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create, update, delete NONE;
DEFINE FIELD OVERWRITE devConsentRelaxed ON _setting TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE environment       ON _setting TYPE option<string>;  -- e.g. 'dev'
DEFINE EVENT OVERWRITE _setting_dev_only ON _setting
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.devConsentRelaxed = true AND $after.environment != 'dev'
  THEN { THROW 'consent checks can be relaxed in dev only (D48)' };

-- ---------------------------------------------------------------- identities (D13 B, D27 B)
-- Services sign in as `service` records: service:api_public_read, :api_user, :api_admin,
-- :workflow. SurrealDB's startup init writes their argon2 secret hashes from the Secret Manager
-- passwords (infra/k8s/surrealdb/base/init.surql.tmpl); the migrator never sees them. People
-- reach SurrealDB only through api-user, in a session opened with their own Clerk token
-- (DEFINE ACCESS clerk, access-clerk.surql). In-cluster system users remain: migrator (OWNER,
-- schema + seeds) and backup (VIEWER, nightly export); the startup init removes any other.
DEFINE TABLE OVERWRITE service SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE secretHash ON service TYPE string;
-- Re-defining svc generates a new signing key (no KEY given: a fixed one would be a secret).
-- Open WebSocket sessions carry on; tokens issued before stop working, and surrealdb.js signs
-- in again with its credentials. So a migration logs out HTTP-token clients, nothing else.
DEFINE ACCESS OVERWRITE svc ON DATABASE TYPE RECORD
  SIGNIN (SELECT * FROM service WHERE id = type::record('service', $name)
          AND crypto::argon2::compare(secretHash, $secret))
  DURATION FOR TOKEN 15m, FOR SESSION 12h;

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
DEFINE EVENT OVERWRITE user_erasure_final ON user              -- also on CREATE/INSERT (round 4)
  WHEN ($event = 'UPDATE' AND $before.gdprDeletedAt != NONE
        AND $after.gdprDeletedAt != $before.gdprDeletedAt)
    OR ($event IN ['CREATE', 'UPDATE'] AND $after.gdprDeletedAt != NONE AND $after.clerkUserId != NONE)
  THEN { THROW 'an erased user stays erased, without a clerkUserId' };
DEFINE FIELD OVERWRITE createdAt     ON user TYPE datetime VALUE $before OR time::now() READONLY;
-- Set by the database at erasure, never by the caller, and immutable afterwards (review round 3:
-- a service could backdate it and get consent pruned early). Only a system user (the migrator;
-- $auth = NONE) may supply a historical date; D22's legacy import doesn't need one (legacy
-- people aren't erased). A client value is ignored: the server time is stored instead.
DEFINE FIELD OVERWRITE gdprDeletedAt ON user TYPE option<datetime>
  VALUE IF $before != NONE { $before }
        ELSE IF $value = NONE { NONE }
        ELSE IF $auth = NONE { $value }
        ELSE { time::now() };
DEFINE INDEX OVERWRITE user_clerk    ON user FIELDS clerkUserId UNIQUE;

-- ---------------------------------------------------------------- personFence (write fence)
-- Transactions read a snapshot, so a check like "consent is granted" or "not erased" can pass
-- in one transaction while another commits the opposite (review round 2). Every write that
-- depends on or changes a person's state therefore also writes that person's fence record, so
-- of two overlapping transactions the second to commit fails with a retryable conflict.
-- Events run with elevated privileges (tested), so the fence is PERMISSIONS NONE: no session can
-- read or write it directly, and no table's permissions had to widen.
DEFINE TABLE OVERWRITE personFence SCHEMAFULL PERMISSIONS NONE;   -- id = personFence:<user id>
DEFINE FIELD OVERWRITE n ON personFence TYPE int DEFAULT 0;      -- a counter, nothing else
DEFINE FUNCTION OVERWRITE fn::fence::bump($user: option<record<user>>) {
  IF $user != NONE {
    UPSERT type::record('personFence', record::id($user)) SET n += 1 RETURN NONE;
  };
};
-- Every table holding or linking person data (directly or through story) refuses a new or
-- changed row for a person who doesn't exist or is erased, and bumps that person's fence, so a
-- write racing erasure conflicts at commit. The per-table list is in docs/db-permissions.md;
-- integration/person-linked.int-spec.ts fails if a table is added without being classified.
DEFINE FUNCTION OVERWRITE fn::person::live($user: option<record<user>>) {
  IF $user = NONE OR !record::exists($user) OR $user.gdprDeletedAt != NONE {
    THROW 'this row belongs to a person who doesn’t exist or has been erased';
  };
  fn::fence::bump($user);
};
DEFINE EVENT OVERWRITE user_fence ON user                         -- erasure, binding changes
  WHEN $event IN ['CREATE', 'UPDATE'] THEN { fn::fence::bump($after.id) };

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
-- D53: the optional image of a written story. Content: only the person writes it (D41), like the
-- text. path = its file in the images storage zone; width/height = the real pixel size; alt =
-- the person's short description (NONE: readers show a neutral default).
DEFINE FIELD OVERWRITE image         ON story TYPE option<object>
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.path    ON story TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 500
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.width   ON story TYPE int ASSERT $value > 0
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.height  ON story TYPE int ASSERT $value > 0
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.alt     ON story TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 500
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- Media and processing fields: the person (upload) and workflow (M7 processing); never api-admin.
-- Each nested field carries the same rule, so `SET media[0].x = ...` is covered too.
-- 3.2.4 stores undefined keys inside array<object> items (tested), so fn::story::shape_problem
-- allows only the fields defined here ($mediaFields there).
DEFINE FIELD OVERWRITE media                    ON story TYPE array<object> DEFAULT []
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].format          ON story TYPE string ASSERT $value IN ['video', 'audio']
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].bunnyVideoId    ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].thumbnailPath   ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
-- D53: the real pixel size (Bunny's encode result), replacing the aspectRatio label. Video only.
REMOVE FIELD IF EXISTS media[*].aspectRatio ON story;
DEFINE FIELD OVERWRITE media[*].width           ON story TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].height          ON story TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
DEFINE FIELD OVERWRITE media[*].durationSeconds ON story TYPE option<int>
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
-- M7 adds media[*].rawTranscriptText / transcriptText / captionsUrl / aiSummary, with the same
-- rule (and adds them to $mediaFields in fn::story::shape_problem).
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
    bylineName: $s.bylineName, primaryFormat: $s.primaryFormat, tagRefs: $s.tagRefs, media: $s.media,
    image: $s.image
  };
};
-- D53: whether a picture's pixel size is allowed: positive, and no taller than 1:3 or wider
-- than 3:1 (strips, not photos). Cards clamp further, between 9:16 and 2:1 (the readers' job).
DEFINE FUNCTION OVERWRITE fn::shape::allowed($width: any, $height: any) {
  RETURN type::is_int($width) AND type::is_int($height) AND $width > 0 AND $height > 0
    AND $height <= $width * 3 AND $width <= $height * 3;
};
-- D53: what's wrong with a story's type and shape, or NONE. Three types, each with one main part
-- and one optional part:
--   written: text (body, not blank), no video or audio; optional image
--   video / audio: one media item of that format, optional text; no image
-- A draft is created before its upload (CreateDraftStory), so video and audio need their media
-- item from submit on (pending, in_review, approved), and may lack it while editable or after
-- (draft, changes_requested, rejected, withdrawn: a draft can be withdrawn before its upload).
-- Used by the story_shape event and by data/0004 (the rows written before it).
DEFINE FUNCTION OVERWRITE fn::story::shape_problem($s: any) {
  LET $media = $s.media ?? [];
  LET $mediaFields = ['format', 'bunnyVideoId', 'thumbnailPath', 'width', 'height', 'durationSeconds'];
  IF $media.any(|$m| object::keys($m).any(|$k| $k NOT IN $mediaFields)) {
    RETURN 'a media item has a field the schema doesn’t define (D53: width and height replace aspectRatio)';
  };
  IF $media.any(|$m| ($m.width = NONE) != ($m.height = NONE)) {
    RETURN 'a media item needs both width and height, or neither';
  };
  IF $media.any(|$m| $m.format = 'audio' AND $m.width != NONE) {
    RETURN 'audio has no width or height';
  };
  IF $media.any(|$m| $m.width != NONE AND !fn::shape::allowed($m.width, $m.height)) {
    RETURN 'a video’s shape is beyond 1:3 or 3:1';
  };
  IF $s.image != NONE AND !fn::shape::allowed($s.image.width, $s.image.height) {
    RETURN 'an image’s shape is beyond 1:3 or 3:1';
  };
  IF $s.primaryFormat = 'written' {
    IF string::len(string::trim($s.body ?? '')) = 0 { RETURN 'a written story needs its text' };
    IF array::len($media) > 0 { RETURN 'a written story has no video or audio' };
  } ELSE {
    IF $s.image != NONE { RETURN 'only a written story can have an image' };
    IF array::len($media) > 1 { RETURN 'a ' + $s.primaryFormat + ' story has exactly one media item' };
    IF $media.any(|$m| $m.format != $s.primaryFormat) {
      RETURN 'a ' + $s.primaryFormat + ' story’s media must be ' + $s.primaryFormat;
    };
    IF array::len($media) = 0 AND $s.status IN ['pending', 'in_review', 'approved'] {
      RETURN 'a ' + $s.primaryFormat + ' story needs its ' + $s.primaryFormat + ' before it is submitted';
    };
  };
  RETURN NONE;
};
-- Every write, by anyone (system users too): the stored story always has a valid type and shape.
DEFINE EVENT OVERWRITE story_shape ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $problem = fn::story::shape_problem($after);
    IF $problem != NONE { THROW $problem };
  };
-- Once a story leaves draft/changes_requested, its owner can no longer change its content
-- (only withdraw it); what a moderator reviewed is what gets published.
DEFINE EVENT OVERWRITE story_owner_content_lock ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth
   AND $before.status NOT IN ['draft', 'changes_requested']
   AND fn::story::content($before) != fn::story::content($after)
  THEN { THROW 'story content is locked after submission' };
-- The owner may only move their story draft/changes_requested -> pending, or withdraw it.
DEFINE EVENT OVERWRITE story_owner_transitions ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth AND $before.status != $after.status
   AND !(($before.status IN ['draft', 'changes_requested'] AND $after.status = 'pending')
         OR $after.status = 'withdrawn')
  THEN { THROW 'status change not allowed for the story owner' };
-- Consent at every step that processes testimony (D17, D21; the API plan's flagged routes):
--   create, edit, upload, media processing -> current Art 9 consent (create: table permission);
--   submit (-> pending) and approve (-> approved) -> Art 9 + publish + age_18plus.
-- Checked against the story's SUBMITTER whoever writes (person, workflow, api-admin), not $auth.
-- Withdrawing (-> withdrawn, content unchanged) and erasure (DELETE) need none.
DEFINE EVENT OVERWRITE story_consent ON story
  WHEN $event = 'UPDATE'
  THEN {
    IF fn::story::content($before) != fn::story::content($after)
       AND !fn::consent::granted($after.submitter, ['special_category_religious']) {
      THROW 'changing a story’s content or media needs the submitter’s current Art 9 consent';
    };
    IF $after.submitter = $auth AND $after.status = 'pending' AND $before.status != 'pending'
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
DEFINE EVENT OVERWRITE story_fence ON story                       -- create, edit, submit, approve, delete
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.submitter) }   -- erasure: no live check
    ELSE { fn::person::live($after.submitter) };
  };
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
DEFINE FIELD OVERWRITE slugHistory   ON publicStory TYPE array<string> DEFAULT [];  -- D30: old slugs -> 301
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
REMOVE FIELD IF EXISTS media[*].aspectRatio ON publicStory;               -- D53: width + height
DEFINE FIELD OVERWRITE media[*].width         ON publicStory TYPE option<int>;
DEFINE FIELD OVERWRITE media[*].height        ON publicStory TYPE option<int>;
DEFINE FIELD OVERWRITE image                  ON publicStory TYPE option<object>;   -- D53
DEFINE FIELD OVERWRITE image.path             ON publicStory TYPE string;
DEFINE FIELD OVERWRITE image.width            ON publicStory TYPE int;
DEFINE FIELD OVERWRITE image.height           ON publicStory TYPE int;
DEFINE FIELD OVERWRITE image.alt              ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE publishedAt   ON publicStory TYPE datetime;
DEFINE FIELD OVERWRITE updatedAt     ON publicStory TYPE datetime VALUE time::now();
-- A full-text index covers one field, so search goes over a computed field.
DEFINE FIELD OVERWRITE searchText    ON publicStory TYPE string
  VALUE string::join(' ', title, description, body ?? '');
-- D41 + D17: the read model can only publish what the person wrote, for an approved story whose
-- submitter currently consents. Otherwise api-admin (which writes this table) could publish text
-- the person never wrote, or keep publishing after consent is withdrawn.
DEFINE EVENT OVERWRITE publicStory_fence ON publicStory           -- publish, re-sync, unpublish
  WHEN true THEN {
    IF $event = 'DELETE' {
      fn::fence::bump(type::record('story', record::id($before.id)).submitter);
    } ELSE {
      fn::person::live(type::record('story', record::id($after.id)).submitter);
    };
  };
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
       OR $after.media.map(|$m| [$m.format, $m.bunnyVideoId, $m.thumbnailPath, $m.width, $m.height])
       != $s.media.map(|$m| [$m.format, $m.bunnyVideoId, $m.thumbnailPath, $m.width, $m.height])
       -- array<object> items take undefined keys (3.2.4): playback fields only, nothing else
       OR $after.media.any(|$m| object::keys($m).any(|$k|
            $k NOT IN ['format', 'bunnyVideoId', 'thumbnailPath', 'width', 'height']))
       OR [$after.image.path, $after.image.width, $after.image.height, $after.image.alt]
       != [$s.image.path, $s.image.width, $s.image.height, $s.image.alt] {
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
  ASSERT $value IN ['standard', 'legacy'];                    -- 'legacy': D22's rules, until the M1 import (D44)
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
-- D48: whether consent checks are relaxed (dev only; see _setting). The one switch: every
-- consent gate goes through fn::consent::granted below, and so does libs/consent's guard.
DEFINE FUNCTION OVERWRITE fn::consent::relaxed() {
  LET $s = (SELECT devConsentRelaxed, environment FROM ONLY _setting:consent);
  RETURN $s.devConsentRelaxed = true AND $s.environment = 'dev';
};
-- Whether every listed consent type is currently granted. Runs with the caller's permissions:
-- whoever can't read the person's ledger gets false (fail closed). With D48's dev-only switch on,
-- true for any person (the ledger itself, fn::consent::current, is unchanged).
DEFINE FUNCTION OVERWRITE fn::consent::granted($user: option<record<user>>, $types: array<string>) {
  RETURN $user != NONE AND (fn::consent::relaxed()
    OR array::len(array::filter($types, |$t| fn::consent::current($user, $t).event = 'granted'))
      = array::len($types));
};
-- Legacy consent (D22) may only be written by the in-cluster migrator (a system user: $auth = NONE).
DEFINE EVENT OVERWRITE consent_legacy_only_migrator ON consent
  WHEN $event = 'CREATE' AND $auth != NONE
   AND ($after.mechanism = 'legacy_import' OR $after.dpaVersion.kind = 'legacy' OR $after.legacyGivenAt != NONE)
  THEN { THROW 'legacy consent can only be imported by the migrator' };
DEFINE EVENT OVERWRITE consent_fence ON consent                   -- grant, withdraw (and pruning)
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.subject) }     -- retention pruning
    ELSE { fn::person::live($after.subject) };
  };
-- Append-only, with one exit (D38): the nightly retention job, running as the migrator (a
-- system user, so no record $auth), may delete the rows of a subject erased more than 6 years
-- ago. 2192d = 6 x 365 days + 2 leap days, so nothing goes early. Nothing else can delete.
DEFINE EVENT OVERWRITE consent_append_only ON consent
  WHEN $event = 'UPDATE'
    OR ($event = 'DELETE' AND !($auth = NONE AND $before.subject.gdprDeletedAt != NONE
                                AND $before.subject.gdprDeletedAt < time::now() - 2192d))
  THEN { THROW 'consent ledger is append-only (retention pruning: erased > 6 years ago only)' };
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
-- Review round 3: a review must belong to an existing story of a live person, and bumps that
-- person's fence, so a review racing erasure can't outlive it (the cascade deletes the rest).
DEFINE EVENT OVERWRITE review_live_story ON moderationReview
  WHEN true
  THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.story.submitter) }   -- NONE in the erasure cascade
    ELSE {
      IF !record::exists($after.story) { THROW 'a moderation review needs an existing story' };
      fn::person::live($after.story.submitter);
    };
  };
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
DEFINE FIELD OVERWRITE entity     ON auditLog TYPE option<record>;        -- story, user, tag, dpaVersion...
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
-- id = idempotencyKey:['api-user' | 'api-admin', <user record | 'svix' | 'stripe'>, <key>]
-- Scoped by the internal user record, not the Clerk id (review round 3): erasure clears the Clerk
-- id, so a key must not carry it. A person-scoped key needs a live user and bumps their fence;
-- erasure deletes their keys. Moderators and admins act through their own user record too (they
-- already need one for moderationReview.moderator and auditLog.actor).
-- A person's own commands run in their session (D27), so they commit their key in the SAME
-- transaction as the command (PR #41 review round 1: a key saved separately could be lost after
-- the command committed, and a retry then re-applied it). A person may create and read only
-- their own api-user keys; never update or delete them (erasure and pruning run as services).
DEFINE TABLE OVERWRITE idempotencyKey SCHEMAFULL PERMISSIONS
  FOR select WHERE $auth.id IN [service:api_user, service:api_admin]
    OR (record::id(id)[0] = 'api-user' AND record::id(id)[1] = $auth.id),
  FOR create WHERE $auth.id IN [service:api_user, service:api_admin]
    OR (record::id(id)[0] = 'api-user' AND record::id(id)[1] = $auth.id
        AND $auth.gdprDeletedAt = NONE),
  FOR update, delete WHERE $auth.id IN [service:api_user, service:api_admin];
DEFINE FIELD OVERWRITE requestHash ON idempotencyKey TYPE string;           -- same key + different body -> 422
DEFINE FIELD OVERWRITE status      ON idempotencyKey TYPE int;
DEFINE FIELD OVERWRITE response    ON idempotencyKey TYPE option<object>;   -- {id, version} only:
DEFINE FIELD OVERWRITE response.id      ON idempotencyKey TYPE option<record>;  -- typed, so no
DEFINE FIELD OVERWRITE response.version ON idempotencyKey TYPE option<int>;     -- text can go in
DEFINE FIELD OVERWRITE expiresAt   ON idempotencyKey TYPE datetime VALUE $before OR time::now() + 24h;
DEFINE EVENT OVERWRITE idempotencyKey_owner ON idempotencyKey
  WHEN true
  THEN {
    LET $owner = record::id(($after ?? $before).id)[1];
    IF $event = 'DELETE' {
      IF type::is_record($owner, 'user') { fn::fence::bump($owner) };
    }
    ELSE IF type::is_record($owner, 'user') { fn::person::live($owner) }
    ELSE IF $owner NOT IN ['svix', 'stripe'] {
      THROW 'an idempotency key is scoped to a user record or a webhook provider';
    };
  };
DEFINE INDEX OVERWRITE idem_expiry ON idempotencyKey FIELDS expiresAt;     -- pruned by the nightly job

-- Later milestones add (same file): favourited/seen edges (M2), donor/donation (M4),
-- featuredStories (M5), helped/concern edges + trust/quality fields (M6), embedOrigin (M8).


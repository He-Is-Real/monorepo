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
--   * an element index over record links (`tagRefs.*`, `tagRefs[*]`) makes `CONTAINS` return no
--     rows; over strings it works (2026-10-24): publicStory.tagSlugs
--   * a query inside a closure (`$list.filter(|$x| ...)`) iterates the whole table, never an
--     index (Codex, #67): /v1/tags sends its probes as top-level statements
--   * a field VALUE also runs for a nested SET (`SET media[0].x = ...`), with $value the whole
--     new field and $before the old one (2026-10-23): media/image VALUE use it to reset
--     `processing` (A2)

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
-- D75: the dev-only placeholder privacy document and consent forms count (fn::legal::counts).
-- Same rules as devConsentRelaxed: OpenTofu's dev_legal_placeholders, dev only.
DEFINE FIELD OVERWRITE devLegalPlaceholders ON _setting TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE environment       ON _setting TYPE option<string>;  -- e.g. 'dev'
DEFINE EVENT OVERWRITE _setting_dev_only ON _setting
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.devConsentRelaxed = true AND $after.environment != 'dev'
  THEN { THROW 'consent checks can be relaxed in dev only (D48)' };
DEFINE EVENT OVERWRITE _setting_dev_legal_only ON _setting
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.devLegalPlaceholders = true AND $after.environment != 'dev'
  THEN { THROW 'the placeholder privacy document and forms are for dev only (D75)' };
-- Turning D48 or D75 off takes away the basis dev's consent stood on (no new form version does
-- that: D93), and so does leaving dev: both switches only count in dev (a dev backup restored
-- elsewhere). So whenever the database is or was dev, every settings write (each migration)
-- hides the public stories whose uploader's consent no longer counts and brings back hidden ones
-- it covers again (fn::consent::reconcile). When a switch or the environment changes, every
-- person's fence and legalFence are bumped too: any consent-dependent write (a draft, a
-- submission, an approval) overlapping the change fails at commit and retries under it.
DEFINE EVENT OVERWRITE _setting_reconcile ON _setting
  WHEN $event IN ['CREATE', 'UPDATE']
   AND ($after.environment = 'dev' OR $before.environment = 'dev')
  THEN {
    IF $before.devConsentRelaxed != $after.devConsentRelaxed
       OR $before.devLegalPlaceholders != $after.devLegalPlaceholders
       OR $before.environment != $after.environment {
      fn::fence::legal();
      LET $people = (SELECT VALUE id FROM user);
      FOR $u IN $people { fn::fence::bump($u) };
    };
    fn::consent::reconcile();
  };

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
-- Some consent checks also read state no person owns: which consent form versions are published
-- (D84). A grant must be on the version in force, and a new draft or a submission needs the
-- sign-up version in force accepted and no newer testimony version requiring acceptance for new
-- submissions (fn::consent::may_draft). Either can pass its check on a snapshot from before a
-- publication. So every form-version write, every consent event, every new story and every
-- submission also write legalFence:forms: of two overlapping transactions the second to commit
-- fails with a retryable conflict, as with personFence. One record for everyone, so unrelated
-- people's grants, new drafts and submissions can conflict too and retry (fine at our volume).
-- Edits, approvals and publication don't write it: what they check (consent on any version that
-- counts) no form-version write can change (D93).
DEFINE TABLE OVERWRITE legalFence SCHEMAFULL PERMISSIONS NONE;    -- id = legalFence:forms
DEFINE FIELD OVERWRITE n ON legalFence TYPE int DEFAULT 0;
DEFINE FUNCTION OVERWRITE fn::fence::legal() {
  UPSERT legalFence:forms SET n += 1 RETURN NONE;
};

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
-- fields only by api-admin; media fields by workflow (processing) and api-user's login, through an
-- upload grant only (D80: never the person's session; uploadGrant_attach), and `processing` (A2)
-- by workflow only. A field write outside its scope is silently dropped (field PERMISSIONS,
-- or the field's VALUE for `processing`), so check the stored state.
DEFINE TABLE OVERWRITE story SCHEMAFULL PERMISSIONS               -- id = story:<ulid>
  FOR select WHERE submitter = $auth.id OR $auth.id IN [service:api_admin, service:workflow],
  FOR create WHERE submitter = $auth.id AND status = 'draft'                -- own draft only,
    AND $auth.gdprDeletedAt = NONE                                          -- not erased, and only
    AND fn::consent::may_draft(submitter),         -- with Art 9 consent on the forms in force (D93)
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
  -- A hard ceiling; the limit itself is a setting (W3: storyTextMax, story_text_limits).
  ASSERT $value = NONE OR string::len($value) <= 50000
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE bylineName    ON story TYPE option<string>   -- story content chosen per story (D16); NONE = anonymous
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE primaryFormat ON story TYPE string ASSERT $value IN ['video', 'audio', 'written']
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE tagRefs       ON story TYPE array<record<tag>> DEFAULT []
  ASSERT array::len($value) <= 20     -- D15: no denormalised tags[]; the limit is a setting (W3)
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- Status: the owner (submit/withdraw, checked by the events below) and api-admin (moderation).
DEFINE FIELD OVERWRITE status        ON story TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'pending', 'in_review', 'approved', 'rejected', 'changes_requested', 'withdrawn']
  PERMISSIONS FOR update WHERE $auth != service:workflow;
-- D53: the optional image of a written story, an audio story's own picture (M2 plan PR 10; it
-- becomes the clip's thumbnail through processing, M7), or a video's own thumbnail (Joel,
-- 2026-10-30): readers show it in place of Bunny's generated thumbnail. One image system: it is
-- never set at Bunny. Processing and the media-ready step (PR 13) can never overwrite it: this
-- VALUE keeps workflow to `processing` alone, and media writes never touch `image`. path = its file in the images storage
-- zone; width/height = the real pixel size; alt = the person's short description (NONE: readers
-- show a neutral default).
-- D65/D80 (M2 plan PR 10): the file is server-assigned like a video. Only an upload grant puts
-- one on a story (uploadGrant_attach, on api-user's login: path, size and alt together); the
-- person's session may then change only `alt`, or remove the image (NONE), never add one or
-- change its path or size. story_media_granted refuses a new path without a grant for the story.
-- A2: image.processing is workflow's (the server-side check before approval), so workflow may
-- write `image`, but its VALUE keeps only workflow's `processing` and the stored other fields.
-- Every other writer's `processing` is ignored: it stays as it was while the file (path, size)
-- is unchanged, and goes back to NONE (not processed) when a new file comes. System users ($auth
-- NONE, the migrator, dev-seed) write it as given.
DEFINE FIELD OVERWRITE image         ON story TYPE option<object>
  VALUE IF $auth = NONE { $value }
    ELSE IF $auth = service:workflow {
      IF $before = NONE OR $value = NONE { $before }
      ELSE { object::extend(object::remove($before, 'processing'), { processing: $value.processing }) }
    }
    ELSE IF $value = NONE { NONE }
    ELSE IF $auth = service:api_user {
      object::extend(object::remove($value, 'processing'), {
        processing: IF $before != NONE
          AND [$before.path, $before.width, $before.height] = [$value.path, $value.width, $value.height]
          { $before.processing } ELSE { NONE }
      })
    }
    ELSE IF $before = NONE { NONE }
    ELSE { object::extend($before, { alt: $value.alt }) }
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
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
-- A2: NONE = not processed yet (just uploaded or replaced); then 'processing', 'ready' or
-- 'failed'. Only 'ready' can be approved and published (fn::story::approval_problem).
DEFINE FIELD OVERWRITE image.processing ON story TYPE option<string>
  ASSERT $value = NONE OR $value IN ['processing', 'ready', 'failed']
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
-- Media and processing fields (D80, Joel 2026-10-25): never the person's session, never api-admin.
-- Workflow writes them (M7 processing). An upload reaches them only through an upload grant that
-- api-user's own login creates: its event (uploadGrant_attach, elevated) puts the video on the
-- draft. A person's write to them is dropped. Each nested field carries the same rule, so
-- `SET media[0].x = ...` is covered too; story_media_granted refuses a new Bunny id without a
-- grant for that story, whoever writes it (system users aside).
-- 3.2.4 stores undefined keys inside array<object> items (tested), so fn::story::shape_problem
-- allows only the fields defined here ($mediaFields there).
-- A2: media[*].processing is workflow's. For everyone else (the person) the VALUE keeps an item's
-- stored `processing` only while the item is otherwise unchanged; a new or changed item (another
-- upload, a different size) starts again at NONE, and a person's own `processing` is ignored.
-- A person's session gets its stored media back (none on create); api-user's login (only ever
-- through uploadGrant_attach) gets the new item, processing NONE.
DEFINE FIELD OVERWRITE media                    ON story TYPE array<object> DEFAULT []
  VALUE IF $auth = NONE OR $auth = service:workflow { $value }
    ELSE IF $auth != service:api_user { $before ?? [] }
    ELSE {
      $value.map(|$m| object::extend(object::remove($m, 'processing'), {
        processing: ($before ?? []).find(|$b|
          object::remove($b, 'processing') = object::remove($m, 'processing')).processing
      }))
    }
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].format          ON story TYPE string ASSERT $value IN ['video', 'audio']
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].bunnyVideoId    ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].thumbnailPath   ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- D53: the real pixel size, replacing the aspectRatio label. A video's is Bunny's encode result.
-- An audio file's is its thumbnail's, the picture shown for it (Joel, 2026-10-24): the person's
-- own image, or the site's default audio thumbnail; never Bunny's audio placeholder.
REMOVE FIELD IF EXISTS media[*].aspectRatio ON story;
DEFINE FIELD OVERWRITE media[*].width           ON story TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].height          ON story TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].durationSeconds ON story TYPE option<int>
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- A2: NONE = not processed yet; then 'processing', 'ready' or 'failed' (set by workflow, M7).
DEFINE FIELD OVERWRITE media[*].processing      ON story TYPE option<string>
  ASSERT $value = NONE OR $value IN ['processing', 'ready', 'failed']
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- M7 adds media[*].rawTranscriptText / transcriptText / captionsUrl / aiSummary, with the same
-- rule (and adds them to $mediaFields in fn::story::shape_problem).
-- D17, D86: consent is per person; a story derives it from its submitter's current ledger state.
-- Not stored, so it can't drift: withdrawing or re-consenting changes every story at once. No
-- story holds a consent or form version: the ledger's history and submittedAt show which version
-- the person was on when they submitted.
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
-- The length of a text without the spaces around it, as readers see it. One policy for every
-- length rule: string::trim strips Unicode White_Space (U+0085 too), and JavaScript's trim()
-- also strips U+FEFF, which string::trim keeps (3.2.4, tested). So U+FEFF counts as a space
-- (interior ones too: the length is the same), and nothing invisible pads a text past a minimum
-- or makes an empty one look written. Mirrored by trimmedTextLength in libs/database.
DEFINE FUNCTION OVERWRITE fn::text::trimmed_length($text: option<string>) {
  RETURN string::len(string::trim(string::replace($text ?? '', '\u{FEFF}', ' ')));
};
-- D53: what's wrong with a story's type and shape, or NONE. Three types, each with one main part
-- and one optional part:
--   written: text (body, not blank), no video or audio; optional image
--   video / audio: one media item of that format, optional text; an optional image (M2 plan
--   PR 10): an audio story's picture, or a video's own thumbnail (Joel, 2026-10-30), shown in
--   place of Bunny's generated thumbnail
-- A draft is created before its upload (CreateDraftStory), so video and audio need their media
-- item from submit on (pending, in_review, approved), and may lack it while editable or after
-- (draft, changes_requested, rejected, withdrawn: a draft can be withdrawn before its upload).
-- A written story's minimum length (Joel, 2026-10-23, from the POC; a setting since W3) is
-- checked when it's submitted (story_text_limits), so a short draft can still be saved.
-- Used by the story_shape event and by data/0004 (the rows written before it).
DEFINE FUNCTION OVERWRITE fn::story::shape_problem($s: any) {
  LET $media = $s.media ?? [];
  LET $mediaFields = ['format', 'bunnyVideoId', 'thumbnailPath', 'width', 'height', 'durationSeconds',
    'processing'];
  IF $media.any(|$m| object::keys($m).any(|$k| $k NOT IN $mediaFields)) {
    RETURN 'a media item has a field the schema doesn’t define (D53: width and height replace aspectRatio)';
  };
  IF $media.any(|$m| ($m.width = NONE) != ($m.height = NONE)) {
    RETURN 'a media item needs both width and height, or neither';
  };
  IF $media.any(|$m| $m.width != NONE AND !fn::shape::allowed($m.width, $m.height)) {
    RETURN 'a video’s or audio thumbnail’s shape is beyond 1:3 or 3:1';
  };
  IF $s.image != NONE AND !fn::shape::allowed($s.image.width, $s.image.height) {
    RETURN 'an image’s shape is beyond 1:3 or 3:1';
  };
  IF $s.primaryFormat = 'written' {
    LET $length = fn::text::trimmed_length($s.body);
    IF $length = 0 { RETURN 'a written story needs its text' };
    IF array::len($media) > 0 { RETURN 'a written story has no video or audio' };
  } ELSE {
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
-- An audio file's thumbnail (Joel, 2026-10-24): exactly the paths api-public-read signs
-- (MediaUrls.thumbnailUrl, bunny-tokens.ts safePath), so a published audio story always has a
-- picture: `<bunnyVideoId>/<file>`, at most 500 characters, each segment only A-Z a-z 0-9 . _ -,
-- no `.` or `..` segment. Both are tested against one table of cases
-- (libs/contracts/src/media-paths.ts; Codex, #79).
DEFINE FUNCTION OVERWRITE fn::media::safe_segment($s: any) {
  RETURN type::is_string($s) AND string::matches($s, '^[A-Za-z0-9._-]+$')
    AND $s NOT IN ['.', '..'];
};
DEFINE FUNCTION OVERWRITE fn::media::own_thumbnail($m: any) {
  IF !type::is_string($m.thumbnailPath) OR !type::is_string($m.bunnyVideoId)
    OR string::len($m.thumbnailPath) > 500 { RETURN false };
  LET $parts = string::split($m.thumbnailPath, '/');
  RETURN array::len($parts) = 2 AND $parts[0] = $m.bunnyVideoId
    AND fn::media::safe_segment($parts[0]) AND fn::media::safe_segment($parts[1]);
};
-- A2 (Joel, 2026-10-23): what keeps a story from being approved or published, or NONE. Every
-- upload must be processed by workflow (M7: size, duration, the malware and content checks) and
-- carry the facts processing found: a video its width, height and duration, an audio file its
-- duration and its thumbnail with that picture's width and height (the person's image or the
-- site's default, set by processing; Joel, 2026-10-24), an image (already sized by the person's
-- browser) processing = 'ready'. So nothing
-- unprocessed, or possibly malicious, reaches the public view. Messages start with
-- 'media_not_ready:' so api-admin answers 409 (libs/database isMediaNotReadyError).
DEFINE FUNCTION OVERWRITE fn::story::approval_problem($s: any) {
  LET $media = $s.media ?? [];
  IF $media.any(|$m| $m.processing != 'ready') {
    RETURN 'media_not_ready: the story’s video or audio hasn’t finished processing';
  };
  IF $media.any(|$m| $m.format = 'video' AND !(type::is_int($m.width) AND type::is_int($m.height)
       AND type::is_int($m.durationSeconds) AND $m.durationSeconds > 0)) {
    RETURN 'media_not_ready: a video needs its width, height and duration';
  };
  IF $media.any(|$m| $m.format = 'audio' AND !(type::is_int($m.durationSeconds) AND $m.durationSeconds > 0)) {
    RETURN 'media_not_ready: an audio file needs its duration';
  };
  IF $media.any(|$m| $m.format = 'audio' AND !(fn::media::own_thumbnail($m)
       AND type::is_int($m.width) AND type::is_int($m.height))) {
    RETURN 'media_not_ready: an audio file needs its thumbnail and that picture’s width and height';
  };
  IF $s.image != NONE AND $s.image.processing != 'ready' {
    RETURN 'media_not_ready: the story’s image hasn’t finished processing';
  };
  RETURN NONE;
};
-- D65, D80: a story's video, audio or image is only ever what was uploaded for it. A Bunny id a write
-- adds (one the story didn't have) needs an upload grant naming this story (uploadGrant, made by
-- api-user's login when it created that video at Bunny), whoever writes: workflow, api-user's
-- grant, and a person's write if a permission ever let one through. System users (the migrator,
-- dev-seed's dummy data) load data as given. Thumbnails stay workflow's (M7) and are checked at
-- approval (fn::media::own_thumbnail); the person can't write them (field permissions).
DEFINE EVENT OVERWRITE story_media_granted ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND $auth != NONE
  THEN {
    LET $had = ($before.media ?? []).map(|$m| $m.bunnyVideoId);
    FOR $m IN ($after.media ?? []) {
      IF $m.bunnyVideoId != NONE AND $m.bunnyVideoId NOT IN $had
        AND (SELECT VALUE story FROM ONLY type::record('uploadGrant', <string> $m.bunnyVideoId)) != $after.id {
        THROW 'media_not_granted: a story’s video or audio must be one api-user created for it (D80)';
      };
    };
    -- Its image likewise (M2 plan PR 10): a new path must be in the story's own folder and
    -- granted to it.
    IF $after.image.path != NONE AND $after.image.path != $before.image.path
      AND (!string::starts_with($after.image.path, 'stories/' + record::id($after.id) + '/')
        OR (SELECT VALUE story FROM ONLY type::record('uploadGrant', $after.image.path)) != $after.id) {
      THROW 'media_not_granted: a story’s image must be one api-user picked for it, in its own folder (D80)';
    };
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
--   edit, upload, media processing -> Art 9 consent that counts, on any version (D93);
--   create (table permission) and submit (-> pending): something new, so the forms in force too:
--     the sign-up version in force accepted (18+ is there only, D93) and no newer testimony
--     version requiring acceptance for new submissions (fn::consent::may_draft, may_submit);
--   approve (-> approved) and publishing -> Art 9 + publish + 18+ that count, on any version
--     (fn::consent::publishable): no form version ever takes a story off the site (D93).
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
       AND !fn::consent::may_submit($after.submitter) {
      THROW 'submitting a story needs current Art 9 and publish consent on the testimony form in force, and the sign-up form in force (18+)';
    };
  };
-- D94, D112 (founder, 2026-10-25/28): limits on what a person starts, from the settings an admin
-- adjusts (submissionSettings, below) and the person's own overrides (submitterLimits): open
-- drafts (default 3) and stories submitted for review in any rolling 7 days (default 1). A trusted
-- submitter has neither. Only the person's own writes are limited ($auth = submitter): the
-- migrator and dev-seed load data as themselves. A submission counts from its first submit, kept
-- in submissionLog (D113) for 7 days whatever happens to the story since (withdrawn, rejected,
-- deleted), so withdrawing or deleting and submitting again doesn't get round it; sending a story
-- back after "changes requested" isn't a new one. Messages start with a code so api-user answers
-- 409 with it (libs/database submissionLimitOf). Both checks read the person's other rows; every
-- story write bumps their fence (story_fence), so two overlapping creates or submissions conflict
-- at commit and the retry sees the other.
-- The limits that apply to a person: their override where an admin set one, else the setting.
-- Trusted: no open-drafts, weekly or weekly-upload limit (NONE = unlimited), and the uploads'
-- size and length limits are the hard ceilings (D113's video limits, Joel 2026-10-30: "trusted
-- submitters are exempt, as with the other limits"); the hourly upload limit still applies (an
-- abuse guard, raised per person if needed).
-- Runs with the caller's permissions: a person reads the settings and their own override row.
DEFINE FUNCTION OVERWRITE fn::limits::effective($user: option<record<user>>) {
  LET $set = fn::settings::submission();
  LET $o = IF $user = NONE { NONE } ELSE {
    (SELECT * FROM ONLY type::record('submitterLimits', record::id($user)))
  };
  LET $trusted = $o.trusted = true;
  LET $ceil = fn::settings::upload_ceilings();
  RETURN {
    trusted: $trusted,
    openDraftsMax: IF $trusted { NONE } ELSE { $o.openDraftsMax ?? $set.openDraftsMax },
    submissionsPer7Days: IF $trusted { NONE } ELSE { $o.submissionsPer7Days ?? $set.submissionsPer7Days },
    uploadRequestsPerHour: $o.uploadRequestsPerHour ?? $set.uploadRequestsPerHour,
    uploadsPer7Days: IF $trusted { NONE } ELSE { $o.uploadsPer7Days ?? $set.uploadsPer7Days },
    videoMaxBytes: IF $trusted { $ceil.videoMaxBytes } ELSE { $set.videoMaxBytes },
    audioMaxBytes: IF $trusted { $ceil.audioMaxBytes } ELSE { $set.audioMaxBytes },
    mediaMaxSeconds: IF $trusted { $ceil.mediaMaxSeconds } ELSE { $set.mediaMaxSeconds }
  };
};
-- When the person may next submit a story for review: 7 days after the submission that fills
-- their allowance, or NONE if that's now (or they're unlimited). Their own session reads their
-- own submissionLog.
DEFINE FUNCTION OVERWRITE fn::story::next_submission_at($user: option<record<user>>) {
  IF $user = NONE { RETURN NONE };
  LET $max = fn::limits::effective($user).submissionsPer7Days;
  IF $max = NONE { RETURN NONE };
  LET $times = (SELECT VALUE at FROM submissionLog
    WHERE person = $user AND at > time::now() - 7d ORDER BY at ASC);
  IF array::len($times) < $max { RETURN NONE };
  RETURN $times[array::len($times) - $max] + 7d;
};
DEFINE EVENT OVERWRITE story_limits ON story
  WHEN $after.submitter = $auth
   AND ($event = 'CREATE'
        OR ($event = 'UPDATE' AND $after.status = 'pending' AND $before.status != 'pending'
            AND $before.submittedAt = NONE))
  THEN {
    IF $event = 'CREATE' {
      LET $max = fn::limits::effective($after.submitter).openDraftsMax;
      LET $open = (SELECT VALUE id FROM story
        WHERE submitter = $after.submitter AND status = 'draft' AND id != $after.id);
      IF $max != NONE AND array::len($open) >= $max {
        THROW 'limit_open_drafts: the person has as many open drafts as they may (D94)';
      };
    } ELSE {
      IF fn::story::next_submission_at($after.submitter) != NONE {
        THROW 'limit_weekly_submission: the person has submitted as many stories as they may in 7 days (D94)';
      };
      -- D113: the submission is recorded for 7 days; older entries of theirs go now.
      DELETE submissionLog WHERE person = $after.submitter AND at <= time::now() - 7d;
      CREATE submissionLog CONTENT { person: $after.submitter } RETURN NONE;
    };
  };
-- W3 (Joel, 2026-10-28): the text and theme limits come from the settings an admin adjusts.
-- No grandfathering (Joel, 2026-10-30: "make people stick to new rules even if they had
-- progress under old rule"): every later action meets the limits in force, drafts started under
-- older ones included. Which action checks what, by whoever writes:
--   - a change of text or themes is refused only if it's over the maximum AND makes it worse
--     (longer, more themes), so someone over a newly lowered maximum can still trim their draft;
--   - submitting (entering pending, in_review or approved from an editable status, or created
--     there by a system user) needs the minimum and maximum length, and at most the maximum
--     number of themes, as they are now. The minimum number of themes is api-user's check at
--     submit (tests and data loaded before it have none).
-- Hard ceilings stay on the fields (body, tagRefs). Messages start with a code for api-user.
DEFINE EVENT OVERWRITE story_text_limits ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $set = fn::settings::submission();
    LET $len = string::len($after.body ?? '');
    LET $tags = array::len($after.tagRefs ?? []);
    LET $was_len = IF $event = 'CREATE' { 0 } ELSE { string::len($before.body ?? '') };
    LET $was_tags = IF $event = 'CREATE' { 0 } ELSE { array::len($before.tagRefs ?? []) };
    IF $len > $set.storyTextMax AND $len > $was_len {
      THROW 'story_text_too_long: the story’s body is longer than the setting allows (W3)';
    };
    IF $tags > $set.tagsMax AND $tags > $was_tags {
      THROW 'story_too_many_tags: a story has more themes than the setting allows (W3)';
    };
    IF $after.status IN ['pending', 'in_review', 'approved']
       AND ($event = 'CREATE' OR $before.status NOT IN ['pending', 'in_review', 'approved']) {
      IF $len > $set.storyTextMax {
        THROW 'story_text_too_long: the story’s body is longer than the setting allows (W3)';
      };
      IF $tags > $set.tagsMax {
        THROW 'story_too_many_tags: a story has more themes than the setting allows (W3)';
      };
      IF $after.primaryFormat = 'written' AND fn::text::trimmed_length($after.body) < $set.storyTextMin {
        THROW 'a written story needs at least ' + <string> $set.storyTextMin
          + ' characters before it is submitted';
      };
    };
  };
DEFINE EVENT OVERWRITE story_approval_media ON story          -- A2: whoever approves (system users too)
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status = 'approved' AND $before.status != 'approved'
  THEN {
    LET $problem = fn::story::approval_problem($after);
    IF $problem != NONE { THROW $problem };
  };
-- Joel, 2026-10-23: an approved story stays approved when its media stops being ready ('failed',
-- back to 'processing', a size fact removed): "we need to ... get it loading again instead of
-- approving again". While any item isn't ready the story is hidden: the same write deletes its
-- publicStory row and creates hiddenStory (below). When the same media is ready again (Bunny
-- re-encodes it; workflow or a system user sets processing back to 'ready' with its facts) the
-- same write re-creates the row, with its first publishedAt and its slugHistory, and deletes
-- hiddenStory. No new approval. Only workflow and system users can cause either: the person's
-- content is locked after submission and api-admin can't write media. auditLog records
-- HideStory/RepublishStory. If the media differs from the row that was hidden (another
-- bunnyVideoId or image path, or a thumbnail that isn't a frame Bunny generated, D60), it stays
-- hidden: a moderator must review it (fn::story::hidden_by_media lists it with mediaChanged).
-- A public story whose media changes that way is hidden too (reason media_changed; D59: changed
-- after going public needs approving again). Only a story that was public is hidden and
-- restored. The event never writes the story itself, so the command's own write is
-- the story's only version step (D29) and returns the committed version.
-- Which media is shown: formats, Bunny ids and the image's path. Works on a story or a
-- publicStory row. The hide stores the identity of the row it deletes (what a moderator
-- approved), never the story's: workflow may have swapped the media in that write.
-- Thumbnails are compared on their own (fn::story::shows_reviewed_media), not hashed here.
DEFINE FUNCTION OVERWRITE fn::story::media_identity($s: any) {
  RETURN crypto::sha256(<string> {
    media: ($s.media ?? []).map(|$m| [$m.format, $m.bunnyVideoId]),
    image: $s.image.path
  });
};
-- D60 (Joel, 2026-10-23): re-encoding a video on Bunny can give it another thumbnail. A frame
-- Bunny generated from the reviewed video is still reviewed media. Bunny's generated frames are
-- thumbnail_1.jpg to thumbnail_5.jpg in the video's folder (Stream docs: storage structure, set
-- thumbnail). A custom upload is stored in the same folder, and the selected-thumbnail file
-- (thumbnail.jpg) isn't proof of a generated frame, so no other name counts (Codex, #67).
DEFINE FUNCTION OVERWRITE fn::media::generated_thumbnail($m: any) {
  RETURN type::is_string($m.bunnyVideoId) AND type::is_string($m.thumbnailPath)
    AND $m.thumbnailPath IN ['1', '2', '3', '4', '5'].map(|$n|
      $m.bunnyVideoId + '/thumbnail_' + $n + '.jpg');
};
-- Whether a story's media is still what was reviewed: the same identity (formats, Bunny ids,
-- image path), and each thumbnail either the reviewed one or a frame Bunny generated for that
-- video. $thumbnails: the reviewed row's thumbnail paths, in media order.
DEFINE FUNCTION OVERWRITE fn::story::shows_reviewed_media($identity: string, $thumbnails: any, $s: any) {
  LET $media = $s.media ?? [];
  RETURN $identity = fn::story::media_identity($s)
    AND type::is_array($thumbnails) AND array::len($thumbnails) = array::len($media)
    AND array::all($media.map(|$m, $i|
      $m.thumbnailPath = $thumbnails[$i] OR fn::media::generated_thumbnail($m)));
};
DEFINE FUNCTION OVERWRITE fn::story::thumbnails($s: any) {
  RETURN ($s.media ?? []).map(|$m| $m.thumbnailPath);
};
-- Hides a public story (Joel, 2026-10-23): deletes its publicStory row and keeps what
-- re-publishing needs in hiddenStory, in the caller's transaction, with a HideStory audit row.
-- $reason: media_unavailable, media_changed or consent_required (dev's switches turned off,
-- fn::consent::reconcile). Called by events only (they
-- run elevated). Nothing to do if the story isn't public.
DEFINE FUNCTION OVERWRITE fn::story::hide($story: record<story>, $reason: string) {
  LET $public = type::record('publicStory', record::id($story));
  LET $hidden = type::record('hiddenStory', record::id($story));
  LET $row = (SELECT * FROM ONLY $public);
  IF $row = NONE { RETURN NONE };
  DELETE $public;
  DELETE $hidden;
  CREATE $hidden CONTENT {
    publishedAt: $row.publishedAt, slugHistory: $row.slugHistory,
    identity: fn::story::media_identity($row), thumbnails: fn::story::thumbnails($row)
  } RETURN NONE;
  CREATE auditLog CONTENT {
    service: fn::audit::service(), action: 'HideStory', entity: $story,
    storyVersion: (SELECT VALUE version FROM ONLY $story), fromStatus: 'approved',
    toStatus: 'approved', reason: $reason
  };
};
-- Brings a hidden story back once nothing keeps it hidden: still approved, its media ready and
-- still what was reviewed, and its uploader's consent counts (D17, D86). The same write
-- re-creates the publicStory row with its first publishedAt and its slugHistory, and deletes
-- hiddenStory; no new approval. $reason: media_restored or consent_restored. Returns whether it
-- did. Called by events only.
DEFINE FUNCTION OVERWRITE fn::story::restore($story: record<story>, $reason: string) {
  LET $public = type::record('publicStory', record::id($story));
  LET $hidden = type::record('hiddenStory', record::id($story));
  LET $h = (SELECT * FROM ONLY $hidden);
  LET $s = (SELECT * FROM ONLY $story);
  IF $h = NONE OR $s = NONE OR $s.status != 'approved' OR record::exists($public)
    OR fn::story::approval_problem($s) != NONE
    OR !fn::story::shows_reviewed_media($h.identity, $h.thumbnails, $s)
    -- Consent rules publishing (D17): until it counts, the story stays hidden (in dev, the next
    -- migration brings it back once it does: fn::consent::reconcile).
    OR !fn::consent::publishable($s.submitter) {
    RETURN false;
  };
  DELETE $hidden;
  CREATE $public CONTENT {
    version: $s.version, slug: $s.slug, slugHistory: $h.slugHistory,
    title: $s.title, description: $s.description, body: $s.body,
    bylineName: $s.bylineName, primaryFormat: $s.primaryFormat,
    tagRefs: $s.tagRefs, publishedAt: $h.publishedAt,
    image: IF $s.image != NONE { { path: $s.image.path, width: $s.image.width,
      height: $s.image.height, alt: $s.image.alt } },
    media: $s.media.map(|$m| { format: $m.format, bunnyVideoId: $m.bunnyVideoId,
      thumbnailPath: $m.thumbnailPath, width: $m.width, height: $m.height })
  } RETURN NONE;
  CREATE auditLog CONTENT {
    service: fn::audit::service(), action: 'RepublishStory', entity: $story,
    storyVersion: $s.version, fromStatus: 'approved', toStatus: 'approved', reason: $reason
  };
  RETURN true;
};
-- Which service a database-made audit row names: the writer's session.
DEFINE FUNCTION OVERWRITE fn::audit::service() {
  RETURN IF $auth = NONE { 'migrator' }
    ELSE IF $auth = service:api_admin { 'api-admin' }
    ELSE IF $auth = service:workflow { 'workflow' }
    ELSE { 'api-user' };
};
DEFINE EVENT OVERWRITE story_media_availability ON story
  WHEN $event = 'UPDATE' AND $before.status = 'approved'
  THEN {
    LET $public = type::record('publicStory', record::id($after.id));
    LET $hidden = type::record('hiddenStory', record::id($after.id));
    IF $after.status != 'approved' {
      -- Left approved (withdrawn): nothing is hidden any more.
      DELETE $hidden;
    } ELSE IF record::exists($public) AND (fn::story::approval_problem($after) != NONE
      OR !fn::story::shows_reviewed_media(fn::story::media_identity($public),
        fn::story::thumbnails($public), $after)) {
      -- Only what is public gets hidden (and so restored): a story that wasn't public (consent
      -- withdrawn) is never published by a media fix. A marker left from an earlier hide never
      -- stops this one (Codex, #61): it is replaced by what is public now.
      fn::story::hide($after.id, IF fn::story::approval_problem($after) != NONE
        { 'media_unavailable' } ELSE { 'media_changed' });
    } ELSE IF record::exists($hidden) {
      fn::story::restore($after.id, 'media_restored');
    };
  };
DEFINE EVENT OVERWRITE story_approval_consent ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status = 'approved' AND $before.status != 'approved'
   AND !fn::consent::publishable($after.submitter)
  THEN { THROW 'approving a story needs the submitter’s current Art 9, publish and age consent' };
-- Erasure: api-user's login may delete stories but can't read them, so it can't find their
-- read-model rows or reviews (both are reached through story.submitter). Deleting a story
-- removes them in the same transaction, whoever deletes it.
DEFINE EVENT OVERWRITE story_fence ON story                       -- create, edit, submit, approve, delete
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.submitter) }   -- erasure: no live check
    ELSE { fn::person::live($after.submitter) };
    -- A new draft and a submission check the forms in force (legalFence).
    IF $event = 'CREATE' OR ($event = 'UPDATE' AND $after.status = 'pending' AND $before.status != 'pending') {
      fn::fence::legal();
    };
  };
DEFINE EVENT OVERWRITE story_erasure_cascade ON story
  WHEN $event = 'DELETE'
  THEN {
    DELETE type::record('publicStory', record::id($before.id));
    DELETE type::record('hiddenStory', record::id($before.id));
    DELETE moderationReview WHERE story = $before.id;
    DELETE favourite WHERE story = $before.id;                  -- others' hearts on it
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
-- Cards show a clip's length (M1 step 6a). Computed from the story on every write, so no
-- publisher copies it and none can change it. The approval gate (A2) means a published video or
-- audio story always has it; NONE for written stories.
DEFINE FIELD OVERWRITE durationSeconds ON publicStory TYPE option<int>
  VALUE type::record('story', record::id(id)).media[0].durationSeconds;
-- D63: /v1/tags lists a tag only if a published story uses it, probing an index for one match
-- per tag (top-level statements, see the gotchas). The tags' slugs, computed on every write (no writer sets them): 3.2.4 returns no rows
-- from an element index over record links (`tagRefs.*`), but indexes strings correctly.
DEFINE FIELD OVERWRITE tagSlugs      ON publicStory TYPE array<string>
  VALUE tagRefs.map(|$t| record::id($t));
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
    -- A2, defence in depth: never publish unprocessed media, even for a story approved earlier.
    LET $unready = fn::story::approval_problem($s);
    IF $unready != NONE { THROW $unready };
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
    IF !fn::consent::publishable($s.submitter) {
      THROW 'publishing needs the submitter’s current Art 9, publish and age consent';
    };
  };
-- Any publication (ApproveStory, a moderator's re-publish, or the media restore) ends a media
-- hide: the row now shows what was reviewed, so a later failure hides it afresh (Codex, #61:
-- a stale marker for replaced media blocked the next hide).
DEFINE EVENT OVERWRITE publicStory_clears_hide ON publicStory
  WHEN $event = 'CREATE'
  THEN { DELETE type::record('hiddenStory', record::id($after.id)) };
-- Processing (workflow, M7) may correct a published clip's size or duration, and a re-encode may
-- give it another frame Bunny generated as its thumbnail (D60). The same write copies them into
-- the published row (durationSeconds is recomputed there), so cards never keep old facts or a
-- dead thumbnail link. Only while the clip is ready and the story's media is still what was
-- reviewed (fn::story::shows_reviewed_media against the published row). Anything else (another
-- clip or image, a custom thumbnail) is never copied: story_media_availability hides the story
-- in the same write, for a moderator to review.
DEFINE EVENT OVERWRITE story_published_media_facts ON story
  WHEN $event = 'UPDATE' AND $after.status = 'approved'
    AND $after.media.map(|$m| [$m.width, $m.height, $m.durationSeconds, $m.thumbnailPath])
      != $before.media.map(|$m| [$m.width, $m.height, $m.durationSeconds, $m.thumbnailPath])
    AND fn::story::approval_problem($after) = NONE
  THEN {
    LET $public = type::record('publicStory', record::id($after.id));
    LET $row = (SELECT media, image FROM ONLY $public);
    IF $row != NONE AND fn::story::shows_reviewed_media(fn::story::media_identity($row),
      fn::story::thumbnails($row), $after) {
      UPDATE $public SET media = $row.media.map(|$m, $i| object::extend($m, {
        width: $after.media[$i].width, height: $after.media[$i].height,
        thumbnailPath: $after.media[$i].thumbnailPath })) RETURN NONE;
    };
  };
DEFINE ANALYZER OVERWRITE story_en TOKENIZERS blank, class FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX OVERWRITE publicStory_slug     ON publicStory FIELDS slug UNIQUE;
DEFINE INDEX OVERWRITE publicStory_slughist ON publicStory FIELDS slugHistory;
DEFINE INDEX OVERWRITE publicStory_browse   ON publicStory FIELDS publishedAt;
DEFINE INDEX OVERWRITE publicStory_tags     ON publicStory FIELDS tagRefs;
DEFINE INDEX OVERWRITE publicStory_tag_slugs ON publicStory FIELDS tagSlugs.*;  -- D63
DEFINE INDEX OVERWRITE publicStory_fts      ON publicStory FIELDS searchText
  FULLTEXT ANALYZER story_en BM25 HIGHLIGHTS;                -- 3.x syntax (was SEARCH ANALYZER)

-- ---------------------------------------------------------------- hiddenStory (Joel, 2026-10-23)
-- An approved story hidden because its media isn't ready (story_media_availability), or, in dev
-- only, because D48's or D75's switch was turned off and its uploader's consent no longer counts
-- (fn::consent::reconcile; never because of a form version, D93). It comes back on its own once
-- its media is ready and their consent counts (fn::story::restore). Same id as the story
-- (hiddenStory:<ulid>). Keeps what re-publishing needs: the deleted row's publishedAt and
-- slugHistory, and the identity of its media. A table of its own, not a story field, so
-- hiding and restoring add no story write (D29: one version step per command). Written by the
-- event only (events run elevated); erasure deletes it with the story.
DEFINE TABLE OVERWRITE hiddenStory SCHEMAFULL PERMISSIONS
  FOR select WHERE $auth.id IN [service:api_admin, service:workflow],
  FOR create, update, delete NONE;
DEFINE FIELD OVERWRITE since       ON hiddenStory TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE publishedAt ON hiddenStory TYPE datetime;
DEFINE FIELD OVERWRITE slugHistory ON hiddenStory TYPE array<string>;
DEFINE FIELD OVERWRITE identity    ON hiddenStory TYPE string ASSERT string::len($value) = 64;
-- D60: the hidden row's thumbnail paths, in media order (rows from before D60 have none, so
-- they stay hidden for a moderator).
DEFINE FIELD OVERWRITE thumbnails  ON hiddenStory TYPE option<array<option<string>>>;
DEFINE INDEX OVERWRITE hiddenStory_since ON hiddenStory FIELDS since;
DEFINE EVENT OVERWRITE hiddenStory_fence ON hiddenStory          -- hide, restore
  WHEN true THEN {
    IF $event = 'DELETE' {
      fn::fence::bump(type::record('story', record::id($before.id)).submitter);
    } ELSE {
      fn::person::live(type::record('story', record::id($after.id)).submitter);
    };
  };
-- For api-admin (someone chases Bunny): approved stories hidden because of their media, oldest
-- first. problem = what's still not ready; mediaChanged = the media differs from what was
-- public, so it needs a moderator rather than Bunny. A story whose media is fine is only waiting
-- for its uploader's consent (dev's switches), so it isn't listed. Runs with the caller's permissions (only
-- api-admin and workflow read hiddenStory).
DEFINE FUNCTION OVERWRITE fn::story::hidden_by_media() {
  LET $hidden = (SELECT since, identity, thumbnails, type::record('story', record::id(id)) AS story
    FROM hiddenStory ORDER BY since ASC);
  RETURN $hidden.map(|$h| {
    LET $s = (SELECT * FROM ONLY $h.story);
    RETURN IF $s.status = 'approved' {
      { id: $s.id, slug: $s.slug, title: $s.title, primaryFormat: $s.primaryFormat,
        hiddenSince: $h.since, problem: fn::story::approval_problem($s),
        mediaChanged: !fn::story::shows_reviewed_media($h.identity, $h.thumbnails, $s) }
    };
  }).filter(|$r| $r != NONE AND ($r.problem != NONE OR $r.mediaChanged));
};

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
-- The document's words, copied from libs/legal/dpa/<id>.md by dpa-sync.surql (D84): what a
-- person read is kept beside the ledger, and api-public-read serves it. NONE on a version
-- published before the copy existed (published versions are frozen).
DEFINE FIELD OVERWRITE text          ON dpaVersion TYPE option<string>;
-- D75: the dev-only placeholder privacy document (libs/legal/dpa/dev_placeholder.md). Refused
-- unless dev's placeholder setting is on, and it (with every form version linking it) counts only
-- while that setting is on (fn::legal::counts): restored into another environment, it doesn't.
DEFINE FIELD OVERWRITE devPlaceholder ON dpaVersion TYPE bool DEFAULT ALWAYS false;
DEFINE EVENT OVERWRITE dpa_dev_placeholder ON dpaVersion
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.devPlaceholder = true AND !fn::legal::dev_placeholders()
  THEN { THROW 'the placeholder privacy document is for dev only (D75)' };
-- D75: whether dev's placeholder privacy document and forms count. Read from the settings row
-- (never a param: see the gotchas at the top), like fn::consent::relaxed.
DEFINE FUNCTION OVERWRITE fn::legal::dev_placeholders() {
  LET $s = (SELECT devLegalPlaceholders, environment FROM ONLY _setting:consent);
  RETURN $s.devLegalPlaceholders = true AND $s.environment = 'dev';
};
-- Whether a privacy document version counts: published (D20), and not a dev placeholder outside
-- dev (D75). Runs with the caller's permissions (everyone reads published versions).
DEFINE FUNCTION OVERWRITE fn::legal::counts($dpa: option<record<dpaVersion>>) {
  IF $dpa = NONE { RETURN false };
  LET $d = (SELECT status, devPlaceholder FROM ONLY $dpa);
  RETURN $d.status = 'published' AND ($d.devPlaceholder != true OR fn::legal::dev_placeholders());
};
-- The privacy document in force: the newest (by effectiveFrom, else createdAt, then createdAt,
-- then id) published standard version that counts and is already in effect; NONE while there
-- is none (D20). GET /v1/legal/dpa serves it.
DEFINE FUNCTION OVERWRITE fn::legal::dpa_in_force() {
  LET $rows = (SELECT id, effectiveFrom ?? createdAt AS since, createdAt FROM dpaVersion
    WHERE status = 'published' AND kind = 'standard'
      AND (effectiveFrom = NONE OR effectiveFrom <= time::now())
    ORDER BY since ASC, createdAt ASC, id ASC);
  RETURN array::last($rows.filter(|$d| fn::legal::counts($d.id))).id;
};

-- ---------------------------------------------------------------- consent forms (D73, D74, D84, D93)
-- Every version of the three forms a person ticks. id = <table>:v1, the version.
--   signupFormVersion: after Clerk's sign-up (D73): "I am 18 or over" and "store my account and
--     favourites" (account_data). 18+ is asked here only (D93): testimony relies on it.
--   testimonyFormVersion: Art 9 at the start of a draft (D67), and publishing on heisreal.today
--     at submit (when the version covers it). Nothing about other sites.
--   socialSharingFormVersion: optional, separate (D93): may the media team also share the story
--     beyond heisreal.today, where, and how. One feature column per platform or use; a platform
--     or use no column lists is not allowed, and one added later needs a new version people opt
--     into (the early-adopter rule).
-- Three tables, not one with a kind column: each has columns the others must not carry.
-- An older published or retired version keeps counting for everything it covered (D93): a new
-- version only gates what it adds, checked against the version the person agreed to (D85, D86).
-- No form version ever takes a story off the site.
-- Text: libs/legal/forms/<signup|testimony|social>/<id>.md. form-sync.surql copies its words
-- (text) and OpenTofu's sha256 of the file (textHash) into the row on every migration, as
-- dpa-sync does for the DPA. Lifecycle (fn::form::check_change): draft (follows its file) ->
-- published (frozen; needs its text and a privacy document that counts) -> retired (no new
-- grants; still counts for its grants). Never deleted once published: the ledger points at it.
DEFINE TABLE OVERWRITE signupFormVersion SCHEMAFULL PERMISSIONS
  FOR select WHERE status != 'draft' OR $auth.id = service:api_admin,
  FOR create, update, delete WHERE $auth.id = service:api_admin;
DEFINE FIELD OVERWRITE status      ON signupFormVersion TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'published', 'retired'];
DEFINE FIELD OVERWRITE textRef     ON signupFormVersion TYPE string;   -- libs/legal/forms/signup/v1.md
DEFINE FIELD OVERWRITE textHash    ON signupFormVersion TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD OVERWRITE text        ON signupFormVersion TYPE option<string>;
DEFINE FIELD OVERWRITE dpaVersion  ON signupFormVersion TYPE record<dpaVersion>;
-- D114: the version's boxes (statements) and the exact words shown beside each, as structured
-- data, never read from its text: libs/legal/forms/<kind>/<id>.statements.json, copied in by
-- form-sync.surql with the file's sha256 (statementsHash, which evidence v3 covers).
DEFINE FIELD OVERWRITE statements     ON signupFormVersion TYPE option<array<{ key: string, label: string }>>;
DEFINE FIELD OVERWRITE statementsHash ON signupFormVersion TYPE option<string>
  ASSERT $value = NONE OR string::len($value) = 64;
DEFINE FIELD OVERWRITE publishedAt ON signupFormVersion TYPE option<datetime>   -- set by the server
  VALUE IF $this.status != 'draft' { $before OR time::now() } ELSE { NONE };
DEFINE FIELD OVERWRITE version     ON signupFormVersion TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29
DEFINE FIELD OVERWRITE createdAt   ON signupFormVersion TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE EVENT OVERWRITE signupFormVersion_lifecycle ON signupFormVersion
  WHEN true THEN { fn::form::check_change($event, $before, $after); fn::fence::legal() };

DEFINE TABLE OVERWRITE testimonyFormVersion SCHEMAFULL PERMISSIONS
  FOR select WHERE status != 'draft' OR $auth.id = service:api_admin,
  FOR create, update, delete WHERE $auth.id = service:api_admin;
DEFINE FIELD OVERWRITE status      ON testimonyFormVersion TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'published', 'retired'];
DEFINE FIELD OVERWRITE textRef     ON testimonyFormVersion TYPE string;   -- libs/legal/forms/testimony/v1.md
DEFINE FIELD OVERWRITE textHash    ON testimonyFormVersion TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD OVERWRITE text        ON testimonyFormVersion TYPE option<string>;
DEFINE FIELD OVERWRITE dpaVersion  ON testimonyFormVersion TYPE record<dpaVersion>;
-- D114: the version's boxes (statements) and the exact words shown beside each, as structured
-- data, never read from its text: libs/legal/forms/<kind>/<id>.statements.json, copied in by
-- form-sync.surql with the file's sha256 (statementsHash, which evidence v3 covers).
DEFINE FIELD OVERWRITE statements     ON testimonyFormVersion TYPE option<array<{ key: string, label: string }>>;
DEFINE FIELD OVERWRITE statementsHash ON testimonyFormVersion TYPE option<string>
  ASSERT $value = NONE OR string::len($value) = 64;
DEFINE FIELD OVERWRITE publishedAt ON testimonyFormVersion TYPE option<datetime>
  VALUE IF $this.status != 'draft' { $before OR time::now() } ELSE { NONE };
DEFINE FIELD OVERWRITE version     ON testimonyFormVersion TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };
DEFINE FIELD OVERWRITE createdAt   ON testimonyFormVersion TYPE datetime VALUE $before OR time::now() READONLY;
-- D93: once this version is published, people whose testimony version is older must accept it
-- before starting a new draft or submitting (fn::consent::may_draft). It changes nothing else:
-- their existing stories stay public and their older grants keep counting. The D85 banner
-- shows it (fn::consent::testimony_status). Named for exactly what it gates, so nobody reads it
-- as "existing consent stops counting".
DEFINE FIELD OVERWRITE requiresAcceptanceForNewSubmissions ON testimonyFormVersion TYPE bool DEFAULT false;
-- The form asks to publish on heisreal.today: only then is `publish` one of its statements.
DEFINE FIELD OVERWRITE coversPublicPublishing ON testimonyFormVersion TYPE bool DEFAULT false;
-- D71: untouched drafts are deleted after this many months (the form says so).
DEFINE FIELD OVERWRITE draftRetentionMonths   ON testimonyFormVersion TYPE int
  ASSERT $value > 0 AND $value <= 120;
DEFINE EVENT OVERWRITE testimonyFormVersion_lifecycle ON testimonyFormVersion
  WHEN true THEN { fn::form::check_change($event, $before, $after); fn::fence::legal() };

DEFINE TABLE OVERWRITE socialSharingFormVersion SCHEMAFULL PERMISSIONS
  FOR select WHERE status != 'draft' OR $auth.id = service:api_admin,
  FOR create, update, delete WHERE $auth.id = service:api_admin;
DEFINE FIELD OVERWRITE status      ON socialSharingFormVersion TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'published', 'retired'];
DEFINE FIELD OVERWRITE textRef     ON socialSharingFormVersion TYPE string;   -- libs/legal/forms/social/v1.md
DEFINE FIELD OVERWRITE textHash    ON socialSharingFormVersion TYPE string ASSERT string::len($value) = 64;
DEFINE FIELD OVERWRITE text        ON socialSharingFormVersion TYPE option<string>;
DEFINE FIELD OVERWRITE dpaVersion  ON socialSharingFormVersion TYPE record<dpaVersion>;
-- D114: the version's boxes (statements) and the exact words shown beside each, as structured
-- data, never read from its text: libs/legal/forms/<kind>/<id>.statements.json, copied in by
-- form-sync.surql with the file's sha256 (statementsHash, which evidence v3 covers).
DEFINE FIELD OVERWRITE statements     ON socialSharingFormVersion TYPE option<array<{ key: string, label: string }>>;
DEFINE FIELD OVERWRITE statementsHash ON socialSharingFormVersion TYPE option<string>
  ASSERT $value = NONE OR string::len($value) = 64;
DEFINE FIELD OVERWRITE publishedAt ON socialSharingFormVersion TYPE option<datetime>
  VALUE IF $this.status != 'draft' { $before OR time::now() } ELSE { NONE };
DEFINE FIELD OVERWRITE version     ON socialSharingFormVersion TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };
DEFINE FIELD OVERWRITE createdAt   ON socialSharingFormVersion TYPE datetime VALUE $before OR time::now() READONLY;
-- The feature columns (D84, D93), read by fn::consent::may_share. Each must match what the
-- version's words name. DEFAULT ALWAYS false: a column added later reads NONE on every older
-- version (so "no"), and retiring such a version fills it with false instead of failing (3.2.4:
-- a plain DEFAULT isn't applied when an older row is updated, and the update fails).
--   share<Platform>: the media team may post the story on that platform's He Is Real Today
--     accounts.
DEFINE FIELD OVERWRITE shareYouTube   ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE shareInstagram ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE shareTikTok    ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE shareFacebook  ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
--   allow<Use>: what the media team may do with it, wherever it's shared:
--     EditingAndClipping: shorter clips, still images, captions, subtitles and translations;
--     ChurchAndPartnerMedia: give it to partner churches and ministries for their own media;
--     PrintAndEvents: show it at events and services, and in printed material;
--     PaidPromotion: use it in paid adverts promoting He Is Real Today.
DEFINE FIELD OVERWRITE allowEditingAndClipping    ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE allowChurchAndPartnerMedia ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE allowPrintAndEvents        ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE FIELD OVERWRITE allowPaidPromotion         ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false;
DEFINE EVENT OVERWRITE socialSharingFormVersion_lifecycle ON socialSharingFormVersion
  WHEN true THEN { fn::form::check_change($event, $before, $after); fn::fence::legal() };

-- The lifecycle of a form version, for the three tables. Events fire for every writer, system
-- users included (who could still REMOVE EVENT; see D13). Every write also bumps legalFence
-- (the events above), so a grant or a new draft can't commit on a snapshot from before it.
DEFINE FUNCTION OVERWRITE fn::form::check_change($event: string, $before: any, $after: any) {
  IF $event = 'DELETE' {
    IF $before.status != 'draft' {
      THROW 'a published form version is kept: the consent ledger points at it (retire it instead)';
    };
  } ELSE {
    IF $event = 'CREATE' AND $after.status = 'retired' {
      THROW 'only a published form version can be retired';
    };
    IF $event = 'UPDATE' AND $before.status != 'draft' {
      IF $after.status != $before.status AND !($before.status = 'published' AND $after.status = 'retired') {
        THROW 'a published form version can only be retired';
      };
      -- Frozen (D84): nothing but the status (and D29's counter) changes. A column added after
      -- publishing goes from NONE to its default false, which isn't a change.
      LET $keys = array::union(object::keys($before), object::keys($after))
        .filter(|$k| $k NOT IN ['status', 'version']);
      -- D114: a version published before statements existed gets them once, from its file
      -- (form-sync.surql); after that they're frozen like everything else.
      IF $keys.any(|$k| $after[$k] != $before[$k] AND !($before[$k] = NONE AND $after[$k] = false)
          AND !($k IN ['statements', 'statementsHash'] AND $before[$k] = NONE)) {
        THROW 'published form versions are frozen: publish a new version instead';
      };
    };
    IF $after.statements != NONE OR $after.statementsHash != NONE {
      fn::form::check_statements(record::tb($after.id), $after);
    };
    IF $after.status != 'draft' AND ($event = 'CREATE' OR $before.status = 'draft') {
      IF $after.text = NONE OR crypto::sha256($after.text) != $after.textHash {
        THROW 'a form version is published with its text, matching its textHash';
      };
      IF !fn::legal::counts($after.dpaVersion) {
        THROW 'a form version links a published privacy document (D20; a dev placeholder in dev only, D75)';
      };
    };
  };
};
-- Whether a form version counts: published or retired, linking a privacy document that counts.
DEFINE FUNCTION OVERWRITE fn::form::counts($form: any) {
  IF $form = NONE { RETURN false };
  LET $f = (SELECT status, dpaVersion FROM ONLY $form);
  RETURN $f.status IN ['published', 'retired'] AND fn::legal::counts($f.dpaVersion);
};
-- The version in force of one form ('signup', 'testimony' or 'social'): the newest published
-- version that counts, by publishedAt then id; NONE while there is none. The only one a grant
-- may use.
DEFINE FUNCTION OVERWRITE fn::form::latest($kind: string) {
  LET $rows = IF $kind = 'signup' {
    (SELECT * FROM signupFormVersion WHERE status = 'published' ORDER BY publishedAt ASC, id ASC)
  } ELSE IF $kind = 'testimony' {
    (SELECT * FROM testimonyFormVersion WHERE status = 'published' ORDER BY publishedAt ASC, id ASC)
  } ELSE IF $kind = 'social' {
    (SELECT * FROM socialSharingFormVersion WHERE status = 'published' ORDER BY publishedAt ASC, id ASC)
  } ELSE { [] };
  RETURN array::last($rows.filter(|$f| fn::legal::counts($f.dpaVersion)));
};
-- The statements a form can ever have, by its table (D93, D109): 18+ and account_data on the
-- sign-up form only; Art 9 and publish on the testimony form; share_socials on the social
-- sharing form. No ledger row, grant or withdrawal, may pair a statement with another form's
-- version (consent_form): testimony is implicitly adult through the account's sign-up consent.
DEFINE FUNCTION OVERWRITE fn::form::kind_statements($form: any) {
  IF $form = NONE { RETURN [] };
  IF record::tb($form) = 'signupFormVersion' { RETURN ['age_18plus', 'account_data'] };
  IF record::tb($form) = 'testimonyFormVersion' { RETURN ['special_category_religious', 'publish'] };
  IF record::tb($form) = 'socialSharingFormVersion' { RETURN ['share_socials'] };
  RETURN [];
};
-- The statements (boxes) a form version must have, each one consent type (D93), from its table
-- and, for a testimony version, whether it covers publishing: `publish` only then. Its
-- statements data (D114) must list exactly these (fn::form::check_statements).
DEFINE FUNCTION OVERWRITE fn::form::required_statements($table: string, $coversPublicPublishing: any) {
  IF $table = 'signupFormVersion' { RETURN ['age_18plus', 'account_data'] };
  IF $table = 'testimonyFormVersion' {
    RETURN array::concat(['special_category_religious'],
      IF $coversPublicPublishing = true { ['publish'] } ELSE { [] });
  };
  IF $table = 'socialSharingFormVersion' { RETURN ['share_socials'] };
  RETURN [];
};
-- The statements (boxes) one form version has: fn::form::required_statements for it. A grant
-- only counts for a statement its version has (fn::consent::valid).
DEFINE FUNCTION OVERWRITE fn::form::statements($form: any) {
  IF $form = NONE { RETURN [] };
  RETURN fn::form::required_statements(record::tb($form),
    IF record::tb($form) = 'testimonyFormVersion' {
      (SELECT VALUE coversPublicPublishing FROM ONLY $form)
    } ELSE { NONE });
};
-- D114: a version's statements data lists every statement it must have, once each, and no
-- other, each with words to show beside its box, and comes with its file's sha256. The pages
-- draw the boxes from it, so a version can't be published with a box missing or misnamed.
DEFINE FUNCTION OVERWRITE fn::form::check_statements($table: string, $f: any) {
  IF $f.statements = NONE OR $f.statementsHash = NONE {
    THROW 'a form version’s statements come with their file’s sha256 (statementsHash), and the other way round';
  };
  LET $keys = $f.statements.map(|$s| $s.key);
  LET $required = fn::form::required_statements($table, $f.coversPublicPublishing);
  IF array::len($keys) != array::len(array::distinct($keys))
    OR array::len($keys) != array::len($required)
    OR $required.any(|$k| $k NOT IN $keys) {
    THROW 'a form version’s statements must be exactly ' + <string> $required + ' (D114), each once';
  };
  IF $f.statements.any(|$s| string::len(string::trim($s.label)) = 0) {
    THROW 'every statement of a form version has words to show beside its box (D114)';
  };
};
-- D93: whether a person whose testimony version is $form (NONE: a grant from before forms) must
-- accept the version in force before a new draft or submission: theirs isn't the one in force,
-- and a version requiring acceptance for new submissions, that counts, was published after
-- theirs (published or since retired: it was in force, so everyone on an older version had to
-- accept it or a later one; accepting the one in force always settles it).
DEFINE FUNCTION OVERWRITE fn::form::requires_acceptance($form: any) {
  IF $form != NONE AND $form = fn::form::latest('testimony').id { RETURN false };
  LET $since = IF $form = NONE { NONE } ELSE { (SELECT VALUE publishedAt FROM ONLY $form) };
  LET $later = (SELECT VALUE id FROM testimonyFormVersion
    WHERE status IN ['published', 'retired'] AND requiresAcceptanceForNewSubmissions = true
      AND ($since = NONE OR publishedAt > $since));
  RETURN $later.any(|$t| fn::form::counts($t));
};

-- ---------------------------------------------------------------- consent ledger (append-only)
-- Per person only (D17), no cache on user (D18), no IP address (D19).
DEFINE TABLE OVERWRITE consent SCHEMAFULL PERMISSIONS
  FOR select WHERE subject = $auth.id OR $auth.id IN [service:api_admin, service:workflow],
  FOR create WHERE subject = $auth.id AND $auth.gdprDeletedAt = NONE,  -- only in the person's own session
  FOR update, delete NONE;                                              -- plus the append-only event
DEFINE FIELD OVERWRITE subject      ON consent TYPE record<user> REFERENCE;  -- user:x<~consent lists a person's events
DEFINE FIELD OVERWRITE type         ON consent TYPE string   -- the statement (box) ticked
  ASSERT $value IN ['special_category_religious', 'publish', 'share_socials', 'age_18plus', 'account_data'];
DEFINE FIELD OVERWRITE dpaVersion   ON consent TYPE record<dpaVersion>;
-- D84: the form version the person saw (its statement is `type`). NONE only on rows from before
-- forms (evidence v1), on legacy imports, and on a withdrawal of such a grant (consent_form).
DEFINE FIELD OVERWRITE form         ON consent TYPE option<record<signupFormVersion | testimonyFormVersion | socialSharingFormVersion>>;
DEFINE FIELD OVERWRITE event        ON consent TYPE string ASSERT $value IN ['granted', 'withdrawn'];
DEFINE FIELD OVERWRITE mechanism    ON consent TYPE string
  ASSERT $value IN ['web_form_submission', 'account_settings', 'reconsent_prompt', 'legacy_import'];
DEFINE FIELD OVERWRITE evidenceHash ON consent TYPE string ASSERT string::len($value) = 64;  -- sha256(presented text + checkbox states)
-- Which evidence format evidenceHash follows (libs/consent/src/lib/evidence.ts), so it can be
-- recomputed: 3 (D114: it also covers the form version's statements data, the words beside each
-- box), set by the API on every event since; NONE on older rows: v2 with a form, v1 without.
DEFINE FIELD OVERWRITE evidenceVersion ON consent TYPE option<int> ASSERT $value = NONE OR $value = 3;
DEFINE FIELD OVERWRITE legacyGivenAt ON consent TYPE option<datetime>;  -- D22: original date, legacy imports only
DEFINE FIELD OVERWRITE occurredAt   ON consent TYPE datetime VALUE time::now() READONLY;   -- server time only
DEFINE INDEX OVERWRITE consent_latest ON consent FIELDS subject, type, occurredAt;  -- D18: "latest event" lookup
-- The single definition of "current consent" (D17). Index range scan over one person's
-- events of one type (a handful of rows); array::last avoids the LIMIT bug above.
DEFINE FUNCTION OVERWRITE fn::consent::current($user: option<record<user>>, $type: string) {
  IF $user = NONE { RETURN NONE };
  RETURN array::last((SELECT type, event, dpaVersion, form, occurredAt FROM consent
    WHERE subject = $user AND type = $type ORDER BY occurredAt ASC));
};
-- D84, D93: whether a latest ledger event ($c, from fn::consent::current) is a grant that counts:
-- on a form version that counts (published or retired, its privacy document counting) and that
-- has this statement. A version never stops counting because a newer one is published: it still
-- covers what it covered. No form: a v1 row from before forms, or a legacy import: counts.
-- The statement check is defence in depth: consent_form refuses a row pairing a statement with
-- another form's version (D109), so a grant of 18+ counts only from the sign-up form.
DEFINE FUNCTION OVERWRITE fn::consent::valid($c: any) {
  IF $c.event != 'granted' { RETURN false };
  IF $c.form = NONE { RETURN true };
  RETURN $c.type IN fn::form::statements($c.form) AND fn::form::counts($c.form);
};
-- D48: whether consent checks are relaxed (dev only; see _setting). The one switch: every
-- consent gate goes through fn::consent::granted below (or checks it first), and so does
-- libs/consent's guard.
DEFINE FUNCTION OVERWRITE fn::consent::relaxed() {
  LET $s = (SELECT devConsentRelaxed, environment FROM ONLY _setting:consent);
  RETURN $s.devConsentRelaxed = true AND $s.environment = 'dev';
};
-- Whether every listed consent type is currently granted, on a form version that counts
-- (fn::consent::valid). Runs with the caller's permissions: whoever can't read the person's
-- ledger gets false (fail closed). With D48's dev-only switch on, true for any person (the
-- ledger itself, fn::consent::current, is unchanged).
DEFINE FUNCTION OVERWRITE fn::consent::granted($user: option<record<user>>, $types: array<string>) {
  RETURN $user != NONE AND (fn::consent::relaxed()
    OR array::len(array::filter($types, |$t| fn::consent::valid(fn::consent::current($user, $t))))
      = array::len($types));
};
-- D73: whether the person has accepted the sign-up form in force: both of its boxes granted on
-- the latest sign-up version. Sign-in (api-user's account bootstrap) asks for it, and a new
-- draft or submission needs it (fn::consent::may_draft). Their earlier sign-up grants keep
-- counting for everything else (D93: 18+ for publishing stays met).
DEFINE FUNCTION OVERWRITE fn::consent::signup_accepted($user: option<record<user>>) {
  IF $user = NONE { RETURN false };
  IF fn::consent::relaxed() { RETURN true };
  LET $latest = fn::form::latest('signup').id;
  LET $data = fn::consent::current($user, 'account_data');
  LET $age = fn::consent::current($user, 'age_18plus');
  RETURN $latest != NONE AND $data.event = 'granted' AND $data.form = $latest
    AND $age.event = 'granted' AND $age.form = $latest;
};
-- D85: testimony consent is per account. The person's testimony version is the form version of
-- their current Art 9 grant (given at the start of a draft, D67): accepting a newer version moves
-- the whole account. NONE without a current grant, or for a grant from before forms. No story
-- stores a version (D86).
DEFINE FUNCTION OVERWRITE fn::consent::testimony_version($user: option<record<user>>) {
  LET $c = fn::consent::current($user, 'special_category_religious');
  RETURN IF $c.event = 'granted' { $c.form } ELSE { NONE };
};
-- D85, D93: what the signed-in banner needs. version: the account's testimony version (above);
-- latest: the testimony version in force; updateAvailable: a newer one is published that they
-- haven't accepted; acceptanceRequired: a version requiring acceptance for new submissions came
-- after theirs, so they must accept the one in force before a new draft or submission (their
-- stories stay public either way).
DEFINE FUNCTION OVERWRITE fn::consent::testimony_status($user: option<record<user>>) {
  LET $mine = fn::consent::testimony_version($user);
  LET $granted = fn::consent::current($user, 'special_category_religious').event = 'granted';
  LET $latest = fn::form::latest('testimony').id;
  RETURN {
    version: $mine, latest: $latest,
    updateAvailable: $granted AND $latest != NONE AND $mine != $latest,
    acceptanceRequired: $granted AND fn::form::requires_acceptance($mine)
  };
};
-- D67, D93: whether the person may start a new draft: Art 9 consent that counts, the sign-up
-- form in force accepted (18+ lives there), and no newer testimony version requiring acceptance
-- for new submissions. D48 relaxes it. Story creation writes legalFence (story_fence), so a
-- form version published meanwhile can't be missed.
DEFINE FUNCTION OVERWRITE fn::consent::may_draft($user: option<record<user>>) {
  RETURN $user != NONE AND (fn::consent::relaxed()
    OR (fn::consent::granted($user, ['special_category_religious'])
      AND fn::consent::signup_accepted($user)
      AND !fn::form::requires_acceptance(fn::consent::testimony_version($user))));
};
-- D93: submitting is new too: may_draft, and publish consent that counts.
DEFINE FUNCTION OVERWRITE fn::consent::may_submit($user: option<record<user>>) {
  RETURN fn::consent::may_draft($user) AND fn::consent::granted($user, ['publish']);
};
-- D17, D86, D93: whether a person's stories may be public: their Art 9, publish and 18+ consent
-- counts, on whichever versions they agreed to. No newer form version changes it; withdrawing
-- does (WithdrawConsent unpublishes in its own transaction), and so do dev's switches.
DEFINE FUNCTION OVERWRITE fn::consent::publishable($user: option<record<user>>) {
  RETURN fn::consent::granted($user, ['special_category_religious', 'publish', 'age_18plus']);
};
-- D93: may a person's stories go beyond heisreal.today in this way? $use names a feature
-- column of the social sharing form: a platform ('shareTikTok', ...) or a use
-- ('allowEditingAndClipping', ...). Answered from their latest share_socials event: a grant on a
-- social sharing version that counts, whose column for $use is true. Missing, withdrawn, a
-- column that version doesn't have (added later: NONE), an unknown or odd name: no. Their
-- stories must also be publishable on consent that really counts: never relaxed by D48.
DEFINE FUNCTION OVERWRITE fn::consent::may_share($user: option<record<user>>, $use: string) {
  IF $user = NONE OR !string::matches($use, '^(share|allow)[A-Z][A-Za-z0-9]*$') { RETURN false };
  LET $share = fn::consent::current($user, 'share_socials');
  IF !fn::consent::valid($share) OR $share.form = NONE
    OR record::tb($share.form) != 'socialSharingFormVersion'
    OR !fn::consent::valid(fn::consent::current($user, 'special_category_religious'))
    OR !fn::consent::valid(fn::consent::current($user, 'publish'))
    OR !fn::consent::valid(fn::consent::current($user, 'age_18plus')) {
    RETURN false;
  };
  RETURN (SELECT * FROM ONLY $share.form)[$use] = true;
};
-- A story is shared only while it's public on heisreal.today, and through its uploader (D86).
DEFINE FUNCTION OVERWRITE fn::story::may_share($story: record<story>, $use: string) {
  RETURN record::exists(type::record('publicStory', record::id($story)))
    AND fn::consent::may_share((SELECT VALUE submitter FROM ONLY $story), $use);
};
-- Dev only (D48, D75): the switches can take away the basis dev's consent stood on. Run by the
-- settings event (elevated; it reads every public and hidden story): hides every public story
-- whose uploader's consent no longer counts, hidden not reverted (as for media, Joel
-- 2026-10-23), and brings back hidden stories it covers (again). Never run for a form version.
DEFINE FUNCTION OVERWRITE fn::consent::reconcile() {
  LET $shown = (SELECT VALUE type::record('story', record::id(id)) FROM publicStory);
  FOR $s IN $shown {
    IF !fn::consent::publishable($s.submitter) { fn::story::hide($s, 'consent_required') };
  };
  LET $waiting = (SELECT VALUE type::record('story', record::id(id)) FROM hiddenStory);
  FOR $s IN $waiting { fn::story::restore($s, 'consent_restored') };
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
-- Withdrawing publish or Art 9 consent ends any media hide of the person's stories (WithdrawConsent
-- deletes their publicStory rows), so a later media fix never publishes them, even after consent
-- is given again (D17: as for a story that was public).
DEFINE EVENT OVERWRITE consent_withdrawal_unhides ON consent
  WHEN $event = 'CREATE' AND $after.event = 'withdrawn'
   AND $after.type IN ['publish', 'special_category_religious']
  THEN {
    FOR $s IN (SELECT VALUE id FROM story WHERE submitter = $after.subject) {
      DELETE type::record('hiddenStory', record::id($s));
    };
  };
-- Every consent event writes legalFence: a grant checked against the form version in force
-- can't commit on a snapshot from before a publication or retirement (consent_form, and the
-- API's in-transaction check). Nothing is restored on a grant (D93: no form version hides).
DEFINE EVENT OVERWRITE consent_legal_fence ON consent
  WHEN $event = 'CREATE' THEN { fn::fence::legal() };
-- Append-only, with one exit (D38): the nightly retention job, running as the migrator (a
-- system user, so no record $auth), may delete the rows of a subject erased more than 6 years
-- ago. 2192d = 6 x 365 days + 2 leap days, so nothing goes early. Nothing else can delete.
DEFINE EVENT OVERWRITE consent_append_only ON consent
  WHEN $event = 'UPDATE'
    OR ($event = 'DELETE' AND !($auth = NONE AND $before.subject.gdprDeletedAt != NONE
                                AND $before.subject.gdprDeletedAt < time::now() - 2192d))
  THEN { THROW 'consent ledger is append-only (retention pruning: erased > 6 years ago only)' };
-- D84: a grant names the form version the person saw, which must be published (not a draft or
-- retired) and count, have that statement, and link the same privacy document. Withdrawals bind
-- to the form of the grant they withdraw (NONE for a v1 grant: withdrawing is always possible,
-- Art 7(3)). D109: no row, grant or withdrawal, pairs a statement with another form's version
-- (fn::form::kind_statements): 18+ is never tied to a testimony or social sharing version, so
-- every grant it follows was on the sign-up form and withdrawing it always works. Which version
-- is in force is the API's check (409), as for the DPA (D20).
DEFINE EVENT OVERWRITE consent_form ON consent
  WHEN $event = 'CREATE'
  THEN {
    IF $after.form = NONE {
      IF $after.event = 'granted' AND $after.mechanism != 'legacy_import' {
        THROW 'consent is given on a consent form version (D84)';
      };
    } ELSE {
      IF $after.type NOT IN fn::form::kind_statements($after.form) {
        THROW 'that statement belongs to another consent form (D93, D109: 18+ is on the sign-up form only)';
      };
      IF $after.event = 'granted' AND $after.type NOT IN fn::form::statements($after.form) {
        THROW 'that statement isn’t on this form version';
      };
      IF $after.dpaVersion != (SELECT VALUE dpaVersion FROM ONLY $after.form) {
        THROW 'consent names the privacy document its form version links';
      };
      IF $after.event = 'granted' AND !((SELECT VALUE status FROM ONLY $after.form) = 'published'
           AND fn::form::counts($after.form)) {
        THROW 'consent can only be given on a published form version (D84)';
      };
    };
  };
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
  'AssignRole', 'LinkLegacyUser', 'CreateTag', 'UpdateTag', 'DeleteTag',
  'CreateDpaDraft', 'PublishDpa', 'UpdateSubmissionSettings', 'UpdateSubmitterLimits',
  -- workflow (M7)
  'ProcessMedia',
  -- the database itself (story_media_availability), in the writer's transaction
  'HideStory', 'RepublishStory'
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
  ASSERT $value = NONE OR $value IN ['special_category_religious', 'publish', 'share_socials', 'age_18plus',
    'account_data'];
DEFINE FIELD OVERWRITE dpaVersion ON auditLog TYPE option<record<dpaVersion>>;
DEFINE FIELD OVERWRITE role       ON auditLog TYPE option<string>         -- AssignRole: the role given
  ASSERT $value = NONE OR $value IN ['Viewer', 'User', 'Moderator', 'Admin', 'SuperAdmin'];
DEFINE FIELD OVERWRITE reason     ON auditLog TYPE option<string>         -- a code, never free text
  ASSERT $value = NONE OR $value IN ['account_deleted', 'consent_withdrawn', 'clerk_user_deleted',  -- D39 erasure callers
    'media_unavailable', 'media_changed', 'media_restored',               -- Hide/RepublishStory
    'consent_required', 'consent_restored'];
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

-- ---------------------------------------------------------------- favourite (M2: hearts)
-- A person's hearts: their private favourites list (founder, 2026-10-25). Only the person who
-- hearted a story can read the row: no service login, and not the story's owner (who will see a
-- count per story on their profile later, never who gave it: not built, see
-- docs/db-permissions.md item 35). One per person and story. A heart needs the sign-up form's
-- consent ("store my account and favourites" and 18+, D73; any version that counts, D93) and a
-- story that is public now (its publicStory row). A story that stops being public later keeps
-- the heart, but lists read publicStory, so it no longer shows (C15). Person-linked twice: a new
-- heart fences both the person and the story's owner. Erasure deletes the person's hearts
-- (user_erasure_favourites), and deleting a story deletes the hearts on it (story_erasure_cascade). Nothing about a heart changes after it is made.
DEFINE TABLE OVERWRITE favourite SCHEMAFULL PERMISSIONS        -- id = favourite:<random>
  FOR select, delete WHERE person = $auth.id,
  FOR create WHERE person = $auth.id AND $auth.gdprDeletedAt = NONE,
  FOR update NONE;
DEFINE FIELD OVERWRITE person    ON favourite TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE story     ON favourite TYPE record<story> READONLY;
DEFINE FIELD OVERWRITE createdAt ON favourite TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE favourite_unique ON favourite FIELDS person, story UNIQUE;
DEFINE INDEX OVERWRITE favourite_list   ON favourite FIELDS person, createdAt;  -- newest first
DEFINE INDEX OVERWRITE favourite_story  ON favourite FIELDS story;              -- story deletion
DEFINE EVENT OVERWRITE favourite_rules ON favourite
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.person) }      -- erasure: no live check
    ELSE {
      fn::person::live($after.person);
      IF !fn::consent::granted($after.person, ['account_data', 'age_18plus']) {
        THROW 'favourite_needs_consent: a heart needs the sign-up consent (account_data, age_18plus)';
      };
      IF !record::exists(type::record('publicStory', record::id($after.story))) {
        THROW 'favourite_not_published: only a public story can be hearted';
      };
      -- The story's owner too (Codex, #117): a heart racing their erasure, which deletes the
      -- story and the hearts on it, then conflicts at commit instead of outliving the story.
      fn::person::live($after.story.submitter);
    };
  };
DEFINE EVENT OVERWRITE user_erasure_favourites ON user
  WHEN $event = 'UPDATE' AND $before.gdprDeletedAt = NONE AND $after.gdprDeletedAt != NONE
  THEN { DELETE favourite WHERE person = $after.id };

-- ---------------------------------------------------------------- submissionSettings (W3, D112)
-- The limits an admin adjusts (Joel, 2026-10-28: "adjustable from the admin account view"), one
-- record, submissionSettings:current, created by data/0006 with today's values (the defaults
-- here, so a missing field reads as them too):
--   storyTextMin / storyTextMax: a written story's text, trimmed, to submit / at most (A3);
--   tagsMin / tagsMax: themes to submit / at most;
--   openDraftsMax, submissionsPer7Days: D94's limits per person (overridable per person);
--   uploadRequestsPerHour: new uploads per person in any rolling hour (overridable; trusted too);
--   uploadsPer7Days: new uploads per person in any rolling 7 days (overridable; none if trusted);
--   videoMaxBytes / audioMaxBytes / mediaMaxSeconds: one file's size and length (A4: 4 GB and
--     500 MB, 15 minutes; trusted submitters get the hard ceilings, fn::settings::upload_ceilings).
--   The upload limits (D113, Joel 2026-10-28/30: stop people filling our video storage) are
--   checked when an upload is granted (uploadGrant_attach) and again at submit by api-user, with
--   the values in force then ("new rules apply to everyone", Joel 2026-10-30).
-- Everyone reads it (the submit page shows the numbers); only api-admin's login, naming the admin
-- in changedBy, and the migrator change it, never delete it. Every change is audit-logged. No
-- admin route or page yet: they come with M3's admin screens.
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
DEFINE FIELD OVERWRITE tagsMin       ON submissionSettings TYPE int DEFAULT 1 ASSERT $value >= 0;
DEFINE FIELD OVERWRITE tagsMax       ON submissionSettings TYPE int DEFAULT 5
  ASSERT $value >= 1 AND $value <= 20;                       -- story.tagRefs' hard ceiling
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
DEFINE FIELD OVERWRITE version       ON submissionSettings TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29
DEFINE FIELD OVERWRITE updatedAt     ON submissionSettings TYPE datetime VALUE time::now();
DEFINE EVENT OVERWRITE submissionSettings_check ON submissionSettings
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    IF $after.id != submissionSettings:current { THROW 'there is one settings record: submissionSettings:current' };
    IF $after.storyTextMin > $after.storyTextMax { THROW 'storyTextMin is more than storyTextMax' };
    IF $after.tagsMin > $after.tagsMax { THROW 'tagsMin is more than tagsMax' };
    IF $after.changedBy = NONE AND $auth != NONE { THROW 'a settings change names the admin who made it (changedBy)' };
    CREATE auditLog CONTENT {
      service: fn::audit::service(), action: 'UpdateSubmissionSettings',
      entity: $after.id, actor: $after.changedBy
    };
  };
-- The settings in force, with the defaults for anything missing (also before data/0006 ran).
DEFINE FUNCTION OVERWRITE fn::settings::submission() {
  LET $s = (SELECT * FROM ONLY submissionSettings:current);
  RETURN {
    storyTextMin: $s.storyTextMin ?? 200, storyTextMax: $s.storyTextMax ?? 10000,
    tagsMin: $s.tagsMin ?? 1, tagsMax: $s.tagsMax ?? 5,
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
-- dev-seed) write it; every change is audit-logged. An admin resets someone by updating the row
-- (trusted false, overrides NONE), never by deleting it, so the reset is audited too; only
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
    IF $event = 'DELETE' { fn::fence::bump($before.user) }
    ELSE {
      fn::person::live($after.user);
      IF $after.changedBy = NONE AND $auth != NONE {
        THROW 'a change to someone’s limits names the admin who made it (changedBy)';
      };
      IF $after.devSeed = true AND (SELECT VALUE environment FROM ONLY _setting:consent) != 'dev' {
        THROW 'dev-seed’s test-account limits are for dev only (D112)';
      };
      CREATE auditLog CONTENT {
        service: fn::audit::service(), action: 'UpdateSubmitterLimits',
        entity: $after.user, actor: $after.changedBy
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
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin];   -- erasure
DEFINE FIELD OVERWRITE person ON submissionLog TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE at     ON submissionLog TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE submissionLog_person ON submissionLog FIELDS person, at;
DEFINE EVENT OVERWRITE submissionLog_fence ON submissionLog
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.person) }
    ELSE { fn::person::live($after.person) };
  };

-- ---------------------------------------------------------------- uploadGrant (D65, D80, D113)
-- One row per video or audio file api-user created at Bunny Stream for a story (RequestUpload,
-- M2 plan PR 7). id = uploadGrant:<bunnyVideoId>, so a Bunny video is granted once, to one story.
-- Only api-user's own login creates it, after creating the video itself (title = the story id,
-- D69); its event checks the draft and the person's upload limits and puts the video on the draft
-- in the same write (D80: the browser never names a video, and a person's session never writes
-- media). story_media_granted then refuses any Bunny id without a grant for that story.
-- Also the per-person record of uploads (D113, Joel 2026-10-28: the limits must hold when stories
-- or videos are deleted): replacing a draft's file deletes the old video at Bunny but keeps its
-- grant, so the hourly and weekly counts stay honest. A grant that's no longer its story's media
-- goes after 7 days (pruned here); a story's current one stays while the story does. Person-linked:
-- erasure deletes them all. The person reads their own (the limits page, the submit checks).
-- storyVersion: the `If-Match` the command was given: the event refuses another (412).
-- sizeBytes / durationSeconds: what the browser declared (the TUS link binds neither, D68); the
-- limits are checked on them here and again at submit, with Bunny's own length once it has one.
-- Images (M2 plan PR 10): id = uploadGrant:`stories/<story id>/<random>.webp`, the file's path in
-- the images storage zone, which api-user picks (D80); the presigned PUT it signs binds that path,
-- the type and the exact size (D68). width/height/alt: the picture's real size (D53, 1:3..3:1) and
-- its description, put on the story with it. Images count towards the same hourly and weekly
-- upload limits; their size and pixel bounds are fixed (fn::upload::image_limits).
DEFINE TABLE OVERWRITE uploadGrant SCHEMAFULL PERMISSIONS
  FOR select WHERE person = $auth.id OR $auth.id IN [service:api_user, service:api_admin],
  FOR create WHERE $auth.id = service:api_user,
  FOR update NONE,
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin];   -- erasure
DEFINE FIELD OVERWRITE story           ON uploadGrant TYPE record<story> READONLY;
DEFINE FIELD OVERWRITE person          ON uploadGrant TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE format          ON uploadGrant TYPE string READONLY
  ASSERT $value IN ['video', 'audio', 'image'];
DEFINE FIELD OVERWRITE contentType     ON uploadGrant TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 100;
DEFINE FIELD OVERWRITE sizeBytes       ON uploadGrant TYPE int READONLY ASSERT $value > 0;
DEFINE FIELD OVERWRITE durationSeconds ON uploadGrant TYPE option<int> READONLY
  ASSERT $value = NONE OR $value > 0;
DEFINE FIELD OVERWRITE width           ON uploadGrant TYPE option<int> READONLY;   -- images
DEFINE FIELD OVERWRITE height          ON uploadGrant TYPE option<int> READONLY;
DEFINE FIELD OVERWRITE alt             ON uploadGrant TYPE option<string> READONLY
  ASSERT $value = NONE OR string::len($value) <= 500;
DEFINE FIELD OVERWRITE storyVersion    ON uploadGrant TYPE int READONLY;
DEFINE FIELD OVERWRITE at              ON uploadGrant TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE uploadGrant_person ON uploadGrant FIELDS person, at;
DEFINE INDEX OVERWRITE uploadGrant_story  ON uploadGrant FIELDS story;
-- When the person may next start an upload: NONE if now, else when the hourly or weekly count
-- frees a place (the later of the two). Their own session reads their own grants.
DEFINE FUNCTION OVERWRITE fn::upload::next_allowed_at($user: option<record<user>>) {
  IF $user = NONE { RETURN NONE };
  LET $l = fn::limits::effective($user);
  LET $week = (SELECT VALUE at FROM uploadGrant
    WHERE person = $user AND at > time::now() - 7d ORDER BY at ASC);
  LET $hour = $week.filter(|$a| $a > time::now() - 1h);
  LET $byHour = IF array::len($hour) < $l.uploadRequestsPerHour { NONE }
    ELSE { $hour[array::len($hour) - $l.uploadRequestsPerHour] + 1h };
  LET $byWeek = IF $l.uploadsPer7Days = NONE OR array::len($week) < $l.uploadsPer7Days { NONE }
    ELSE { $week[array::len($week) - $l.uploadsPer7Days] + 7d };
  RETURN IF $byHour = NONE { $byWeek } ELSE IF $byWeek = NONE { $byHour }
    ELSE IF $byHour > $byWeek { $byHour } ELSE { $byWeek };
};
-- An image's fixed bounds (M2 plan PR 10): the browser re-encodes it to WebP at most 2048 px on its
-- longer side, so these only stop what no browser of ours sends. Mirrored in api-user (uploads.ts).
DEFINE FUNCTION OVERWRITE fn::upload::image_limits() {
  RETURN { maxBytes: 5242880, minSide: 200, maxSide: 4096 };
};
DEFINE EVENT OVERWRITE uploadGrant_attach ON uploadGrant
  WHEN $event IN ['CREATE', 'DELETE'] THEN {
    IF $event = 'DELETE' { fn::fence::bump($before.person) }
    ELSE {
      fn::person::live($after.person);
      LET $s = (SELECT * FROM ONLY $after.story);
      IF $s = NONE OR $s.submitter != $after.person {
        THROW 'upload_refused: the story isn’t this person’s';
      };
      IF $s.version != $after.storyVersion { THROW 'story_cmd:stale_version' };
      IF $s.status NOT IN ['draft', 'changes_requested'] { THROW 'story_cmd:locked' };
      LET $l = fn::limits::effective($after.person);
      IF $after.format = 'image' {
        -- A written story's image, an audio story's picture or a video's own thumbnail, in the
        -- story's own folder, named by api-user (a 32-hex random name), a WebP of a size and
        -- shape we take (D53).
        LET $path = record::id($after.id);
        LET $name = string::replace($path, 'stories/' + record::id($s.id) + '/', '');
        IF !string::starts_with($path, 'stories/' + record::id($s.id) + '/')
          OR string::len($name) != 37 OR !string::ends_with($name, '.webp')
          OR !string::is_hexadecimal(string::slice($name, 0, 32)) {
          THROW 'upload_refused: an image goes in its story’s own folder, under a name api-user picks';
        };
        IF $after.contentType != 'image/webp' { THROW 'upload_refused: an image is a WebP' };
        LET $il = fn::upload::image_limits();
        IF $after.sizeBytes > $il.maxBytes {
          THROW 'limit_upload_size: the image is bigger than we take (M2 plan PR 10)';
        };
        IF $after.width = NONE OR $after.height = NONE
          OR $after.width < $il.minSide OR $after.height < $il.minSide
          OR $after.width > $il.maxSide OR $after.height > $il.maxSide
          OR !fn::shape::allowed($after.width, $after.height) {
          THROW 'upload_refused: an image’s pixel size or shape is outside what we take (D53)';
        };
        IF $s.primaryFormat = 'written' AND fn::text::trimmed_length($after.alt) = 0 {
          THROW 'upload_refused: a written story’s image needs its description';
        };
      } ELSE {
        IF $s.primaryFormat != $after.format {
          THROW 'upload_refused: a ' + $s.primaryFormat + ' story takes no ' + $after.format;
        };
        IF $after.sizeBytes > (IF $after.format = 'video' { $l.videoMaxBytes } ELSE { $l.audioMaxBytes }) {
          THROW 'limit_upload_size: the file is bigger than the person may upload (D113)';
        };
        IF $after.durationSeconds != NONE AND $after.durationSeconds > $l.mediaMaxSeconds {
          THROW 'limit_upload_duration: the file is longer than the person may upload (D113)';
        };
      };
      -- Counted without this row; the fence above makes two overlapping grants conflict.
      LET $week = (SELECT VALUE at FROM uploadGrant
        WHERE person = $after.person AND id != $after.id AND at > time::now() - 7d);
      IF array::len($week.filter(|$a| $a > time::now() - 1h)) >= $l.uploadRequestsPerHour {
        THROW 'limit_upload_hourly: the person has started as many uploads as they may in an hour (D113)';
      };
      IF $l.uploadsPer7Days != NONE AND array::len($week) >= $l.uploadsPer7Days {
        THROW 'limit_upload_weekly: the person has started as many uploads as they may in 7 days (D113)';
      };
      -- The draft's one video or audio file, or its image, is now this one (D80). The story's
      -- media or image VALUE starts its processing again (A2); its version steps once, to
      -- storyVersion + 1. A replaced image's file stays where it is: an approved story's public
      -- copy may still show it, so the clean-up sweep removes it later (media-runbook).
      IF $after.format = 'image' {
        UPDATE $after.story SET image = { path: record::id($after.id), width: $after.width,
          height: $after.height, alt: IF fn::text::trimmed_length($after.alt) = 0 { NONE }
            ELSE { string::trim($after.alt) } } RETURN NONE;
      } ELSE {
        UPDATE $after.story SET media = [{ format: $after.format, bunnyVideoId: record::id($after.id) }]
          RETURN NONE;
      };
      -- Older grants that are no longer any story's media or image.
      DELETE uploadGrant WHERE person = $after.person AND at <= time::now() - 7d
        AND record::id(id) NOT IN (story.media ?? []).map(|$m| $m.bunnyVideoId)
        AND record::id(id) != story.image.path;
    };
  };

-- Later milestones add (same file): seen edges (dropped, D72), donor/donation (M4),
-- helped/concern edges + trust/quality fields (M6), embedOrigin (M8).


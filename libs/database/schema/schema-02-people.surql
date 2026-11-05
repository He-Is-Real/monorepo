-- schema-02-people.surql: people (user), their hearts, and erasure.
-- Part of the declarative schema: every schema-NN-*.surql file, applied in name order in one
-- transaction (see schema-01-system.surql).

-- ---------------------------------------------------------------- user (D16, D1, D22)
-- Only a reference to the Clerk user. Email, name and country live in Clerk (D16);
-- roles live in Clerk (D1). A legacy person (D22) has no Clerk account yet: NONE, linked
-- by an admin if they sign up later.
DEFINE TABLE OVERWRITE user SCHEMAFULL PERMISSIONS
  FOR select WHERE id = $auth.id OR $auth.id IN [service:api_user, service:api_admin, service:workflow],
  FOR create WHERE $auth.id = service:api_user,                       -- created on first use
  FOR update WHERE $auth.id IN [service:api_user, service:api_admin]  -- erasure (status)
    -- plan 4e: the person's own session agrees to the terms of use and the testimony consent
    -- (user_agreements: those four fields only)
    OR (id = $auth.id AND $auth.status != 'deleted'),
  FOR delete NONE;
-- The identity binding (D37). Set once: by api-admin linking a legacy person (or on create by
-- api-user). Cleared once: by api-user's erasure, in the same update that sets the status to
-- deleted, leaving a stub (internal id + status; plan 4e: no agreement survives it).
-- Never changed otherwise, and never set again after erasure: a compromised service must not
-- point a victim's record at its own token.
DEFINE FIELD OVERWRITE clerkUserId   ON user TYPE option<string>
  PERMISSIONS FOR update WHERE $auth IN [service:api_admin, service:api_user] OR $auth = NONE;
DEFINE EVENT OVERWRITE user_clerk_binding ON user
  WHEN $event = 'UPDATE' AND $before.clerkUserId != $after.clerkUserId
   AND !(
     -- link a legacy person who has no Clerk account yet (api-admin; the migrator)
     ($before.clerkUserId = NONE AND $before.status != 'deleted' AND $after.status != 'deleted'
       AND $auth != service:api_user)
     -- erasure: api-user clears it once, at the moment the status becomes deleted
     OR ($after.clerkUserId = NONE AND $before.status != 'deleted' AND $after.status = 'deleted'
       AND $auth = service:api_user)
   )
  THEN { THROW 'clerkUserId can only be linked once, or cleared once at erasure' };
-- Erasure is final and always leaves a stub without a Clerk id (D37).
DEFINE EVENT OVERWRITE user_erasure_final ON user              -- also on CREATE/INSERT (round 4)
  WHEN ($event = 'UPDATE' AND $before.status = 'deleted' AND $after.status != 'deleted')
    OR ($event IN ['CREATE', 'UPDATE'] AND $after.status = 'deleted' AND $after.clerkUserId != NONE)
  THEN { THROW 'an erased user stays erased, without a clerkUserId' };
DEFINE FIELD OVERWRITE createdAt     ON user TYPE datetime VALUE $before OR time::now() READONLY;
-- R3 (Joel, 2026-11-04/05): whether the account still exists: 'active', or 'deleted' once erased
-- (fn::account::erase), with no date and no reason. Every rule that asks "is this person
-- erased?" asks status = 'deleted' (a row without one counts as active). Final: once deleted, a
-- write that sets it back is ignored.
DEFINE FIELD OVERWRITE status ON user TYPE string DEFAULT 'active'
  VALUE IF $before = 'deleted' { 'deleted' } ELSE { $value ?? 'active' }
  ASSERT $value IN ['active', 'deleted'];
DEFINE INDEX OVERWRITE user_clerk    ON user FIELDS clerkUserId UNIQUE;
-- Plan 4e: what the person agreed to, each a pointer to a version with the database's time of
-- agreeing (fn::legal::check_pointer has the rules). termsOfUse: before using the account (one
-- "I am 18 or over and agree to the terms of use"; NONE until then: api-user creates the row on
-- first use, and only the person's own session can agree). testimonyConsent: NONE until their
-- first testimony; it covers every story they submit. Both move forward to the latest version
-- when the person re-agrees, and are cleared only by erasure (fn::account::erase).
DEFINE FIELD OVERWRITE termsOfUse       ON user TYPE option<record<termsOfUseAgreement>>;
DEFINE FIELD OVERWRITE termsOfUseAgreedAt ON user TYPE option<datetime>
  VALUE IF $this.termsOfUse = NONE { NONE } ELSE IF $value != $before { time::now() } ELSE { $before };
DEFINE FIELD OVERWRITE testimonyConsent ON user TYPE option<record<testimonyConsent>>;
DEFINE FIELD OVERWRITE testimonyConsentAgreedAt ON user TYPE option<datetime>
  VALUE IF $this.testimonyConsent = NONE { NONE } ELSE IF $value != $before { time::now() } ELSE { $before };
DEFINE EVENT OVERWRITE user_agreements ON user
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $erasing = $before.status != 'deleted' AND $after.status = 'deleted';
    IF $after.status = 'deleted' AND ($after.termsOfUse != NONE OR $after.testimonyConsent != NONE) {
      THROW 'agreement_kept: an erased account keeps no agreement (plan 4e)';
    };
    fn::legal::check_pointer('termsOfUseAgreement', $after.id, $before.termsOfUse, $after.termsOfUse,
      $before.termsOfUseAgreedAt, $after.termsOfUseAgreedAt, $erasing);
    fn::legal::check_pointer('testimonyConsent', $after.id, $before.testimonyConsent,
      $after.testimonyConsent, $before.testimonyConsentAgreedAt, $after.testimonyConsentAgreedAt, $erasing);
    -- The person's own session writes nothing else on their row.
    IF $auth = $after.id AND ($before.clerkUserId != $after.clerkUserId
       OR $before.status != $after.status) {
      THROW 'a person agrees on their own row; nothing else there is theirs to change';
    };
  };
-- D82: an erased Clerk id never gets a row again, whoever writes it (erasedIdentity below). A token
-- minted before erasure lives 60 s, and a Clerk user whose deletion failed can still sign in, so
-- api-user's first-use create (provisionPerson) and a legacy link are both refused here.
-- Both sides write fence:identity-<fingerprint>, so a first-use create racing the erasure of a Clerk
-- id it can't see yet (Clerk's user.deleted for someone who never used the API) conflicts at commit;
-- the retry then sees the tombstone, or the erasure's retry sees the row and erases it.
DEFINE EVENT OVERWRITE user_not_erased_identity ON user
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.clerkUserId != NONE
   AND $after.clerkUserId != $before.clerkUserId
  THEN {
    fn::fence::touch('identity', crypto::sha256($after.clerkUserId));
    IF record::exists(type::record('erasedIdentity', crypto::sha256($after.clerkUserId))) {
      THROW 'identity_erased: this Clerk account was deleted';
    };
  };
-- Every table holding or linking person data (directly or through story) refuses a new or
-- changed row for a person who doesn't exist or is erased, and bumps that person's fence, so a
-- write racing erasure conflicts at commit. The per-table list is in docs/db-permissions.md;
-- integration/person-linked.int-spec.ts fails if a table is added without being classified.
DEFINE FUNCTION OVERWRITE fn::person::live($user: option<record<user>>) {
  IF $user = NONE OR !record::exists($user) OR $user.status = 'deleted' {
    THROW 'this row belongs to a person who doesn’t exist or has been erased';
  };
  fn::fence::touch('person', $user);
};
DEFINE EVENT OVERWRITE user_fence ON user                         -- erasure, binding changes
  WHEN $event IN ['CREATE', 'UPDATE'] THEN { fn::fence::touch('person', $after.id) };

-- ---------------------------------------------------------------- favourite (M2: hearts)
-- A person's hearts: their private favourites list (founder, 2026-10-25). Only the person who
-- hearted a story can read the row: no service login, and not the story's owner (who will see a
-- count per story on their profile later, never who gave it: not built, see
-- docs/db-permissions.md item 35). One per person and story. A heart needs the person to have
-- agreed to the latest terms of use (plan 4e, Q2: their own write) and a story that is public now (its publicStory row). A story that stops being public later keeps
-- the heart, but lists read publicStory, so it no longer shows (C15). Person-linked twice: a new
-- heart fences both the person and the story's owner. Erasure deletes the person's hearts
-- (user_erasure_favourites), and deleting a story deletes the hearts on it (story_erasure_cascade). Nothing about a heart changes after it is made.
-- R14 (Joel, 2026-11-05): the id is a ULID, which starts with the moment the heart was made, so
-- there is no separate date: the list sorts and pages by id, and "Download my data" reads the
-- time back with time::from_ulid. favourite_rules refuses an id that isn't a ULID made just now,
-- so nobody can backdate a heart. The list uses favourite_unique's person prefix (no index can
-- cover the id; timed on a local database, 2026-11-05: about 2 ms for 250 hearts, 40 ms for 5,000).
DEFINE TABLE OVERWRITE favourite SCHEMAFULL PERMISSIONS        -- id = favourite:<ulid>
  FOR select, delete WHERE person = $auth.id,
  FOR create WHERE person = $auth.id AND $auth.status != 'deleted',
  FOR update NONE;
DEFINE FIELD OVERWRITE person    ON favourite TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE story     ON favourite TYPE record<story> READONLY;
DEFINE INDEX OVERWRITE favourite_unique ON favourite FIELDS person, story UNIQUE;  -- and the list
DEFINE INDEX OVERWRITE favourite_story  ON favourite FIELDS story;              -- story deletion
-- Whether a heart's id is a ULID whose time is within 5 seconds of the database's clock, either
-- way (the API's clock and the database's may differ a little).
DEFINE FUNCTION OVERWRITE fn::favourite::made_now($id: record<favourite>) {
  LET $key = record::id($id);
  IF !type::is_string($key) OR !string::matches($key, '^[0-7][0-9A-HJKMNP-TV-Z]{25}$') { RETURN false };
  LET $at = time::from_ulid($key);
  RETURN $at > time::now() - 5s AND $at < time::now() + 5s;
};
DEFINE EVENT OVERWRITE favourite_rules ON favourite
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.person) }      -- erasure: no live check
    ELSE {
      fn::person::live($after.person);
      IF $event = 'CREATE' AND !fn::favourite::made_now($after.id) {
        THROW 'favourite_id: a heart’s id is a ULID made just now (R14)';
      };
      IF $auth != NONE { fn::legal::require_terms($after.person) };
      IF !record::exists(type::record('publicStory', record::id($after.story))) {
        THROW 'favourite_not_published: only a public story can be hearted';
      };
      -- The story's owner too (Codex, #117): a heart racing their erasure, which deletes the
      -- story and the hearts on it, then conflicts at commit instead of outliving the story.
      fn::person::live($after.story.submitter);
    };
  };
DEFINE EVENT OVERWRITE user_erasure_favourites ON user
  WHEN $event = 'UPDATE' AND $before.status != 'deleted' AND $after.status = 'deleted'
  THEN { DELETE favourite WHERE person = $after.id };

-- ---------------------------------------------------------------- erasedIdentity (D82 tombstone)
-- id = erasedIdentity:<sha256 of the Clerk user id>: a retained fingerprint of an erased identity,
-- and nothing else (no date, no user link). It is not anonymous: whoever holds the Clerk id can
-- hash it and match the row, so it stays personal data (pseudonymous), kept on purpose and named
-- in the privacy notes. Written by the erasure (fn::account::erase), even for a Clerk id that
-- never had a row (Clerk's user.deleted for someone who never used the API).
-- user_not_erased_identity refuses that Clerk id for ever after, so a still-valid token can't
-- recreate the person (#44's reproduction). Kept: dropping one would let a leftover Clerk account
-- back in. Only api-user's login reads or writes it.
DEFINE TABLE OVERWRITE erasedIdentity SCHEMAFULL PERMISSIONS
  FOR select, create WHERE $auth.id = service:api_user,
  FOR update, delete NONE;
DEFINE EVENT OVERWRITE erasedIdentity_fingerprint ON erasedIdentity
  WHEN $event = 'CREATE'
  THEN {
    IF !string::matches(<string> record::id($after.id), '^[0-9a-f]{64}$') {
      THROW 'an erased identity is a sha256 fingerprint only';
    };
    fn::fence::touch('identity', record::id($after.id));        -- see user_not_erased_identity
  };

-- ---------------------------------------------------------------- pendingDeletion (D40)
-- What must still be deleted outside the database, written in the transaction that made it
-- needed and deleted row by row once done: kind 'bunny_video' (a Stream video api-user made: an
-- erased person's upload grants, never seeded media), 'image' (a deleted story's whole folder in
-- the images storage zone, `stories/<story id>/`: only story_picture_folder writes these, keyed
-- by the story, M2 plan PR 10), 'clerk_user' (the Clerk account, for "Delete my account", which is
-- also how a person withdraws all consent (plan 4e); the only place a Clerk id outlives erasure,
-- until Clerk confirms). No person link:
-- the person or story is gone. api-user deletes an erasure's rows straight after the commit; the
-- nightly housekeeping retries the rest. A failed try counts in `attempts` and waits
-- (fn::erasure::retry_after), so rows that keep failing go to the back and never hold up the
-- others. finalPassAt (folders only): a picture's PUT link may still be used until then, so a
-- delete before it leaves the row, due again at finalPassAt (pendingDeletion_done), and only a
-- delete from then on removes it; a repeat delete of the id moves it later (story_picture_folder),
-- which also refuses the id to anyone but a system user while the row is queued. Only api-user and housekeeping read, delete or count tries on it;
-- only api-user's erasure writes rows itself (never an 'image' one).
DEFINE TABLE OVERWRITE pendingDeletion SCHEMAFULL PERMISSIONS
  FOR select, update WHERE $auth.id IN [service:api_user, service:housekeeping],
  FOR delete WHERE $auth.id IN [service:api_user, service:housekeeping]
    AND (finalPassAt = NONE OR finalPassAt <= time::now()),
  FOR create WHERE $auth.id = service:api_user AND kind != 'image';
DEFINE FIELD OVERWRITE kind ON pendingDeletion TYPE string READONLY
  ASSERT $value IN ['bunny_video', 'image', 'clerk_user'];
DEFINE FIELD OVERWRITE ref  ON pendingDeletion TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 500;
DEFINE FIELD OVERWRITE at   ON pendingDeletion TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE attempts      ON pendingDeletion TYPE int DEFAULT 0 ASSERT $value >= 0;
DEFINE FIELD OVERWRITE nextAttemptAt ON pendingDeletion TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE finalPassAt   ON pendingDeletion TYPE option<datetime>
  PERMISSIONS FOR update NONE;                                  -- set by the event only
DEFINE INDEX OVERWRITE pendingDeletion_due ON pendingDeletion FIELDS nextAttemptAt;
-- A deleted story's folder's queue key: one row per folder, however many deletes ask for it.
DEFINE FUNCTION OVERWRITE fn::erasure::folder_key($story: record<story>) {
  RETURN 'image-' + <string> record::id($story);
};
-- How long after a story's deletion its folder's last delete waits: past the 10-minute life of a
-- picture's PUT link (api-user's IMAGE_LINK_SECONDS), with room for a link signed just before.
DEFINE FUNCTION OVERWRITE fn::erasure::final_pass_after() {
  RETURN 15m;
};
-- One queued deletion is done (`$key`): the row goes, unless its final pass is still to come,
-- when it waits for that instead, its tries unchanged.
DEFINE FUNCTION OVERWRITE fn::erasure::pending_done($key: string) {
  LET $row = type::record('pendingDeletion', $key);
  IF $row.finalPassAt != NONE AND $row.finalPassAt > time::now() {
    UPDATE $row SET nextAttemptAt = finalPassAt RETURN NONE;
  } ELSE {
    DELETE $row;
  };
};
-- How long a queued deletion waits after its $attempts-th failed try: 1 h,
-- then doubling, at most a week. Set together with the count, from its value before the try.
DEFINE FUNCTION OVERWRITE fn::erasure::retry_after($attempts: int) {
  RETURN duration::from_hours(<int> math::min([math::pow(2, $attempts), 168]));
};

-- ---------------------------------------------------------------- EraseAccount (D39, D82, D40)
-- The database half of erasing a person, in the caller's transaction: api-user's ERASE_ACCOUNT
-- (libs/database erasure.ts, on its own login), for "Delete my account" (which is also how a person
-- withdraws all consent, plan 4e) and Clerk's user.deleted. Answers [user, keys]:
-- the erased user (or NONE: already erased, or never known) and the pendingDeletion keys written.
-- - The erased-identity tombstone (D82): the sha256 of the Clerk id, written even when nobody has
--   that id, so provisioning refuses it from now on (user_not_erased_identity).
-- - What must go outside the database (D40): each of the person's video and audio upload grants
--   (bunny_video), each of their stories' picture folders (image: queued by the story's own
--   delete, story_picture_folder, from the story rows, so a pruned grant can't hide one), and,
--   unless Clerk has already deleted the person ($reason clerk_user_deleted), their Clerk account.
-- - Then the stories (the cascade takes publicStory, hiddenStory, reviews and others' hearts),
--   idempotency keys, limits, submission log and grants; the user row becomes a stub (D37) and
--   their own hearts go with it (user_erasure_favourites). R3: the stub's status is 'deleted',
--   with no date and no reason ($reason only decides whether the Clerk account is queued).
-- Plan 4e: the stub keeps no agreement (the terms and testimony pointers are cleared with it), and
-- nothing else kept (the tombstone) records consent. On a caller's own
-- permissions (api-user's grants are exactly these); anyone else's leave nothing done.
DEFINE FUNCTION OVERWRITE fn::account::erase($clerkUserId: string, $reason: string) {
  LET $fingerprint = type::record('erasedIdentity', crypto::sha256($clerkUserId));
  IF !record::exists($fingerprint) { CREATE $fingerprint RETURN NONE };
  LET $u = (SELECT VALUE id FROM user WHERE clerkUserId = $clerkUserId AND status != 'deleted')[0];
  LET $media = (SELECT VALUE { kind: 'bunny_video', ref: <string> record::id(id) }
    FROM uploadGrant WHERE $u != NONE AND person = $u AND format != 'image');
  LET $account = IF $u = NONE OR $reason = 'clerk_user_deleted' { [] }
    ELSE { [{ kind: 'clerk_user', ref: $clerkUserId }] };
  LET $pending = IF array::len(array::concat($media, $account)) = 0 { [] }
    ELSE { (INSERT INTO pendingDeletion array::concat($media, $account) RETURN VALUE record::id(id)) };
  -- Each story's picture folder is queued by its delete (story_picture_folder), one per story.
  -- api-user can't read stories, so their keys are the folder rows written from here on (one
  -- another delete committed in the same instant may join them: trying it early is harmless).
  LET $since = time::now();
  IF $u != NONE {
    DELETE story WHERE submitter = $u;              -- cascades publicStory, hiddenStory, reviews, hearts
    DELETE idempotencyKey WHERE record::id(id)[1] = $u;   -- keys are scoped by user record
    DELETE submitterLimits WHERE user = $u;         -- D112: their limits and trusted mark
    DELETE submissionLog WHERE person = $u;         -- D113: their recent submissions
    DELETE uploadGrant WHERE person = $u;           -- D80, D113: their uploads (queued above, D40)
    UPDATE $u SET status = 'deleted', clerkUserId = NONE,   -- D37: a stub remains
      termsOfUse = NONE, testimonyConsent = NONE;
  };
  LET $folders = IF $u = NONE { [] } ELSE { (SELECT VALUE record::id(id) FROM pendingDeletion
    WHERE kind = 'image' AND at >= $since) };
  RETURN [$u, array::concat($pending, $folders)];
};

-- Later milestones add (same file): seen edges (dropped, D72), donor/donation (M4),
-- helped/concern edges + trust/quality fields (M6), embedOrigin (M8).

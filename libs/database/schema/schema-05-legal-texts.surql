-- schema-05-legal-texts.surql: the four legal texts' versions and the rules on agreeing to them.
-- Part of the declarative schema: every schema-NN-*.surql file, applied in name order in one
-- transaction (see schema-01-system.surql).

-- ---------------------------------------------------------------- legal texts (plan 4e)
-- Joel, 2026-10-31 and 2026-11-01 (privacy-consent-architecture.html, sections 4e and 8b): four
-- version tables of exactly the same shape, one per text.
--   termsOfUseAgreement: the terms of use (they say you must be 18 or over); user.termsOfUse
--   testimonyConsent: the Art 9 testimony consent, per person, covering every story they
--     submit; user.testimonyConsent
--   socialMediaSharingConsent: the optional box at the end of an upload, per story, naming every
--     platform; story.socialMediaSharingConsent
--   privacyNotice: shown on the site with its past versions; nothing points to it and nobody
--     agrees to it (no ticks, no approvals, no view logs)
-- id = the version, an int from 0 (testimonyConsent:0, :1...); content = the full Markdown text as
-- shown; release_date = when it was saved, set by the database; publishedBy = the admin who
-- published it (R3, Joel 2026-11-04/05: in place of an audit row), set by api-admin from the
-- admin's own user record, never by the browser, and readable by api-admin only (the public
-- never learns who saved a version). NONE only for a system user's version (data/0009's
-- version 0). A saved version is in force at
-- once (no "takes effect on" date): the latest is the highest id. Only api-admin's login (an
-- Admin or Super Admin publishing at /admin/consent) and the migrator (data/0009 seeds version
-- 0 of each) create versions, each the next number. Nobody changes or deletes one, system
-- users included: a mistake is fixed by saving another version.
-- The old consent machinery is gone (plan 4e, "What goes"): the consent ledger, dpaVersion,
-- termsVersion, the three form-version tables, evidence hashes, legalFence, the computed
-- story.consent, fn::consent::* and the old fn::legal::* / fn::form::*, the dev consent switches
-- and erasureRequest (Joel, 2026-11-01: "Delete my account" erases directly). All of it held
-- dummy data only; removing a table removes its rows and events.

DEFINE TABLE OVERWRITE termsOfUseAgreement SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create WHERE $auth = service:api_admin,
  FOR update, delete NONE;
DEFINE FIELD OVERWRITE content      ON termsOfUseAgreement TYPE string
  ASSERT string::len(string::trim($value)) > 0 AND string::len($value) <= 100000;
DEFINE FIELD OVERWRITE release_date ON termsOfUseAgreement TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE publishedBy  ON termsOfUseAgreement TYPE option<record<user>> READONLY
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
DEFINE EVENT OVERWRITE termsOfUseAgreement_kept ON termsOfUseAgreement
  WHEN true THEN { fn::legal::check_version($event, $after) };

DEFINE TABLE OVERWRITE testimonyConsent SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create WHERE $auth = service:api_admin,
  FOR update, delete NONE;
DEFINE FIELD OVERWRITE content      ON testimonyConsent TYPE string
  ASSERT string::len(string::trim($value)) > 0 AND string::len($value) <= 100000;
DEFINE FIELD OVERWRITE release_date ON testimonyConsent TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE publishedBy  ON testimonyConsent TYPE option<record<user>> READONLY
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
DEFINE EVENT OVERWRITE testimonyConsent_kept ON testimonyConsent
  WHEN true THEN { fn::legal::check_version($event, $after) };

DEFINE TABLE OVERWRITE socialMediaSharingConsent SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create WHERE $auth = service:api_admin,
  FOR update, delete NONE;
DEFINE FIELD OVERWRITE content      ON socialMediaSharingConsent TYPE string
  ASSERT string::len(string::trim($value)) > 0 AND string::len($value) <= 100000;
DEFINE FIELD OVERWRITE release_date ON socialMediaSharingConsent TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE publishedBy  ON socialMediaSharingConsent TYPE option<record<user>> READONLY
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
DEFINE EVENT OVERWRITE socialMediaSharingConsent_kept ON socialMediaSharingConsent
  WHEN true THEN { fn::legal::check_version($event, $after) };

DEFINE TABLE OVERWRITE privacyNotice SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create WHERE $auth = service:api_admin,
  FOR update, delete NONE;
DEFINE FIELD OVERWRITE content      ON privacyNotice TYPE string
  ASSERT string::len(string::trim($value)) > 0 AND string::len($value) <= 100000;
DEFINE FIELD OVERWRITE release_date ON privacyNotice TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE publishedBy  ON privacyNotice TYPE option<record<user>> READONLY
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
DEFINE EVENT OVERWRITE privacyNotice_kept ON privacyNotice
  WHEN true THEN { fn::legal::check_version($event, $after) };

-- The four tables' one rule, whoever writes (events run for system users too): a version is only
-- ever created, as the next number (0 for the first), naming who published it (anyone but a
-- system user), and never changed or deleted. Runs after
-- the create, so the table already holds the new row: versions 0..id and nothing else. Two saves
-- of the same number conflict on the record; a save that skips one is refused.
DEFINE FUNCTION OVERWRITE fn::legal::check_version($event: string, $after: any) {
  IF $event != 'CREATE' {
    THROW 'legal_version_kept: a saved version of a legal text is never changed or deleted (plan 4e)';
  };
  LET $n = record::id($after.id);
  LET $count = array::len(SELECT VALUE id FROM type::table(record::tb($after.id)));
  IF !type::is_int($n) OR $n != $count - 1 {
    THROW 'legal_version_number: a new version is numbered one after the latest, from 0 (plan 4e)';
  };
  IF $after.publishedBy = NONE AND $auth != NONE {
    THROW 'legal_published_by: a new version names the admin who published it (R3)';
  };
};
-- The latest version of one of the four tables (the highest id), or NONE while it has none.
DEFINE FUNCTION OVERWRITE fn::legal::latest($table: string) {
  LET $n = math::max(SELECT VALUE record::id(id) FROM type::table($table));
  RETURN IF $n = NONE { NONE } ELSE { type::record($table, $n) };
};
-- The pointers (user.termsOfUse, user.testimonyConsent, story.socialMediaSharingConsent), each
-- with its agreed-at time; one rule for all three, called by the owning row's event:
--   * the pointer and its time travel together: both NONE or both set, changed in the same write
--     (the time's VALUE is the database's clock whenever a write sends one);
--   * only the person's own session moves a pointer ($owner: the user, or the story's
--     submitter), and only to the latest version: the page sends the version it showed, and a
--     newer one saved meanwhile is refused (agreement_version_changed: the page fetches it and
--     shows the redline). Being the latest, it is always forward;
--   * a pointer is cleared only when its user is erased ($clearing) or its story deleted (the
--     row goes);
--   * system users ($auth = NONE: the migrator, dev-seed's dummy people) load data as given.
DEFINE FUNCTION OVERWRITE fn::legal::check_pointer($table: string, $owner: any, $was: any, $now: any,
    $wasAt: any, $nowAt: any, $clearing: bool) {
  IF $was = $now {
    IF $wasAt != $nowAt {
      THROW 'agreement_time: an agreed-at time only changes with its version (plan 4e)';
    };
    RETURN NONE;
  };
  IF $now = NONE {
    IF !$clearing AND $auth != NONE {
      THROW 'agreement_kept: an agreement is only cleared when its account or story is deleted (plan 4e)';
    };
    RETURN NONE;
  };
  IF $nowAt = NONE OR $nowAt = $wasAt {
    THROW 'agreement_time: a new agreement is written with its agreed-at time (plan 4e)';
  };
  IF $auth = NONE { RETURN NONE };
  IF $auth != $owner {
    THROW 'agreement_not_own: only the person’s own session agrees, never a service or an admin (plan 4e)';
  };
  IF $now != fn::legal::latest($table) {
    THROW 'agreement_version_changed: a newer version was saved since the page showed this one (plan 4e)';
  };
};
-- Joel, 2026-11-01 (Q2): "agree first", enforced here on the person's own writes. A signed-in
-- write needs the terms of use at the latest version; a story write (create, edit, submit) and
-- an upload need the testimony consent at the latest version too. Messages start with a code
-- api-user answers 403 with, so the page shows the redline and asks again.
DEFINE FUNCTION OVERWRITE fn::legal::require_terms($user: any) {
  LET $u = (SELECT termsOfUse FROM ONLY $user);
  IF $u.termsOfUse = NONE OR $u.termsOfUse != fn::legal::latest('termsOfUseAgreement') {
    THROW 'terms_agreement_required: agree to the latest terms of use first (plan 4e)';
  };
};
DEFINE FUNCTION OVERWRITE fn::legal::require_testimony($user: any) {
  fn::legal::require_terms($user);
  LET $u = (SELECT testimonyConsent FROM ONLY $user);
  IF $u.testimonyConsent = NONE OR $u.testimonyConsent != fn::legal::latest('testimonyConsent') {
    THROW 'testimony_consent_required: agree to the latest testimony consent first (plan 4e)';
  };
};

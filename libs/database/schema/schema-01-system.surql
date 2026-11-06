-- schema-01-system.surql: the runner's bookkeeping, the service logins and the write fences.
-- The declarative schema is the schema-NN-*.surql files in this folder, applied in name order, in
-- one transaction, on every migration (D14; runner: migrate.py, next to them). Every statement is
-- OVERWRITE, so re-running is safe. Declarative means: what's here is defined; deleting a line
-- removes nothing (write an explicit REMOVE ... IF EXISTS, and drop it once every database has run
-- it). Data changes go in data/NNNN-*.surql (run once, recorded in _migration). DEFINE ACCESS clerk
-- is in access-clerk.surql (applied only when OpenTofu has Clerk's key). No top-level RETURN: inside
-- the transaction it would end it early. CI applies these files to SurrealDB 3.2.4 on every PR, so
-- any syntax 3.2.4 rejects is caught before merge. The 3.2.4 gotchas found in testing, which shape
-- much of what's here, are listed in docs/db-permissions.md ("SurrealDB 3.2.4 gotchas").

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
-- One row per dev database reset the runner carried out (params.json dev_database_reset, set
-- only by OpenTofu's dev root): the reset removed everything but these bookkeeping tables,
-- _identity and the service logins, so the schema and every data script ran again from scratch.
-- The row makes each reset run once. Kept by every reset.
DEFINE TABLE OVERWRITE _migrationReset SCHEMAFULL PERMISSIONS NONE;   -- id = the reset's name
DEFINE FIELD OVERWRITE at        ON _migrationReset TYPE datetime;
-- _identity:current is written by SurrealDB's startup init (init.surql.tmpl), last in its
-- transaction: the identity config the running server started with. _identity:verified is
-- written by the identity-check sidecar once it has signed in with the intended credentials;
-- the migrate Job waits for it. Same definition as in the init.
DEFINE TABLE OVERWRITE _identity SCHEMAFULL PERMISSIONS NONE;     -- id = _identity:current
DEFINE FIELD OVERWRITE hash      ON _identity TYPE string;
DEFINE FIELD OVERWRITE appliedAt ON _identity TYPE datetime;

-- Settings from OpenTofu's parameters, written by the runner in the settings step of every
-- migration (migrate.py, SETTINGS). Everyone may read them (functions run with the caller's
-- permissions); only system users write. A row, not DEFINE PARAM: inside a function a caller's
-- bound variable shadows a defined param (3.2.4, tested), so a person could set their own.
-- _setting:current.environment: which environment this database belongs to ('dev', ...), read by
-- dev-seed's guard and submitterLimits.devSeed.
DEFINE TABLE OVERWRITE _setting SCHEMAFULL PERMISSIONS
  FOR select FULL,
  FOR create, update, delete NONE;
DEFINE FIELD OVERWRITE environment       ON _setting TYPE option<string>;  -- e.g. 'dev'

-- ---------------------------------------------------------------- identities (D13 B, D27 B)
-- Services sign in as `service` records: service:api_public_read, :api_user, :api_admin,
-- :workflow, :housekeeping (the nightly Cloud Run Job, apps/housekeeping). SurrealDB's startup init writes their argon2 secret hashes from the Secret Manager
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

-- ---------------------------------------------------------------- fence (write fences, R5)
-- Transactions read a snapshot, so a check like "agreed to the latest terms" or "not erased" can pass
-- in one transaction while another commits the opposite (review round 2). Every write that
-- depends on or changes a person's state (or a theme's, or an erased Clerk id's) therefore also
-- writes that thing's fence record, so of two overlapping transactions the second to commit
-- fails with a retryable conflict, and its retry sees the other. One table (R5, Joel
-- 2026-11-04/05), its ids saying what they guard:
--   fence:person-<user id>     anything depending on or changing a person's state
--   fence:identity-<sha256>    a Clerk id being provisioned or erased (user_not_erased_identity)
--   fence:theme-<theme id>     a theme being deleted or added to a story (theme_delete)
-- Events run with elevated privileges (tested), so the fence is PERMISSIONS NONE: no session can
-- read or write it directly, and no table's permissions had to widen. A counter, nothing else.
DEFINE TABLE OVERWRITE fence SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE n ON fence TYPE int DEFAULT 0;
-- Bumps the fence of `$of` ('person', 'identity' or 'theme'): `$id` is the user or theme record,
-- or the fingerprint. NONE (a link that was never set) does nothing.
DEFINE FUNCTION OVERWRITE fn::fence::touch($of: string, $id: any) {
  IF $id != NONE {
    LET $key = IF type::is_record($id) { <string> record::id($id) } ELSE { <string> $id };
    UPSERT type::record('fence', $of + '-' + $key) SET n += 1 RETURN NONE;
  };
};

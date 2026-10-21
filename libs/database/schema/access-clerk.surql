-- access-clerk.surql: person sessions (D27 B). Applied with schema.surql, in the same
-- transaction, only when Terraform has Clerk's key (var.clerk_jwt_public_key, M0 task 0.5).
-- Without it the runner removes this access instead (REMOVE ACCESS IF EXISTS clerk), so no
-- token can open a person session: there is never a stand-in key whose private half exists.
-- $clerk_jwt_public_key is Clerk's PEM public key, pinned because GKE has no internet egress to
-- fetch the JWKS; it's public, so it can sit in tfvars. Tokens carry the ns/db/ac claims
-- SurrealDB needs (docs/db-permissions.md, "Clerk side").
-- An already-open person session outlives erasure (up to its 5m session), so every person write
-- in schema.surql also checks `$auth.gdprDeletedAt = NONE`. $auth is a record id, so this reads
-- the user row as of the transaction's snapshot (not as of sign-in); a transaction that overlaps
-- erasure is caught by the personFence conflict instead.
DEFINE ACCESS OVERWRITE clerk ON DATABASE TYPE RECORD
  WITH JWT ALGORITHM RS256 KEY $clerk_jwt_public_key
  AUTHENTICATE (SELECT VALUE id FROM user WHERE clerkUserId = $token.sub AND gdprDeletedAt = NONE LIMIT 1)[0]
  DURATION FOR SESSION 5m;

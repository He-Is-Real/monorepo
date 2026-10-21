# Delivery status

Where the build is against the delivery plan (`project` repo,
`context/future/delivery-plan.md`), and the high-level decisions made while implementing each
stage.

**Precedence:** the `project` repo holds the plan and the reasoning behind it. Where an
implemented stage below differs from it, **this file wins** for that stage. Decisions still
waiting to be made are in `project/context/research/required-decisions.html`.

Keep this file current: update it in the same PR that finishes a task or changes a decision
recorded here.

**Last updated:** 2026-10-20

## Milestones

| Milestone                     | Status         | Notes                                                                  |
| ----------------------------- | -------------- | ---------------------------------------------------------------------- |
| M0 Walking skeleton           | 🟡 In progress | 0.1, 0.2, contracts, rename, 0.3 done; 0.7 partly                      |
| M1 Browse & view (public MVP) | ⚪ Not started | Goes live and replaces Squarespace                                     |
| M2 Accounts & submission      | ⚪ Not started |                                                                        |
| M3 Moderation                 | ⚪ Not started |                                                                        |
| M4 Donations                  | ⚪ Not started |                                                                        |
| M5 Admin dashboard            | ⚪ Not started | A thin version can start after M1                                      |
| M6 Community vetting          | ⚪ Not started |                                                                        |
| M7 Async processing (AI)      | ⚪ Not started | Transcription worker prototyped in `project/src/workers/transcription` |
| M8 Embeddable widgets         | ⚪ Not started | Can start any time after M1                                            |

## M0: Walking skeleton

| Task                          | Status         | Where                                                                        |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------- |
| 0.1 Repo setup                | ✅ Done        | #1                                                                           |
| 0.2 Backend scaffold          | ✅ Done        | #1, CI fixes in #3, #10, #12                                                 |
| API contracts + conventions   | ✅ Done        | #28: `libs/contracts`, `docs/api-conventions.md` (D23)                       |
| Service rename (D33, D36)     | ✅ Done        | #29                                                                          |
| 0.3 Database schema v1        | ✅ Done        | #31 (schema), D14 migration Job (D24 step 4). First apply to dev by hand     |
| 0.8 Consent foundation (GDPR) | ⚪ Next        | Built alongside 0.3                                                          |
| 0.4 Frontend scaffold         | ⚪ To do       | `apps/web` is a placeholder (Next.js 16.3, #11)                              |
| 0.5 Auth (Clerk)              | ⚪ To do       | Clerk app exists, dev instance only (see below)                              |
| 0.6 Sentry + Umami            | ⏸ Deferred     | Out of the current phase (D5). GCP Cloud Logging / Error Reporting meanwhile |
| 0.7 Terraform                 | 🟡 Partly done | GCP done. Still to add: Bunny.net. Cloudflare DNS is out of this phase (D7)  |
| 0.9 Walking-skeleton page     | ⚪ To do       | Needs 0.3, 0.4 and 0.5. Served on Cloud Run's generated `*.run.app` URL (D7) |

### Decisions implemented in M0

These refine or replace what the plan says.

| #   | Decision                                                                                                                                                                                                                                            | Plan said                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | **One Nx + pnpm monorepo** for the site, all NestJS services, shared libs, Kubernetes manifests and Terraform.                                                                                                                                      | "Monorepo or two repos"                               |
| 2   | **Node 24 LTS only.** Node majors are bumped by hand, LTS releases only; Dependabot ignores them. NestJS runs on Express.                                                                                                                           | Not specified                                         |
| 3   | **All cloud changes go through Terraform, including proofs of concept.** There are four roots: `bootstrap`, `gcp`, `cluster`, `images`. Plans run automatically and applies are manual. Anything made by hand is adopted with `import` blocks.      | "Terraform for reproducible environments"             |
| 4   | **Secrets live only in GCP Secret Manager.** Config holds secret names, never values. Authentication is keyless everywhere (ADC, Workload Identity). External Secrets Operator supplies them on GKE, and Terraform state never holds secrets.       | "Env vars via Secret Manager / Cloud Run config"      |
| 5   | **SurrealDB v3.2.4, single node on RocksDB,** on GKE Autopilot Spot Pods in `europe-west2` (London). It's network-isolated to its own namespace plus the Cloud Run subnet, and the image is pinned by tag and digest.                               | Single node, EU/UK. Spot Pods are a dev cost choice   |
| 6   | **Backups:** a nightly `surreal export` to a UK bucket with a create-only uploader, plus on-demand backups via `-var backup_run=<id>`. **Restore drill passed on 2026-10-05.** There are no PVC snapshots.                                          | Export to GCS + PVC snapshots + tested restore        |
| 7   | **Database identities (D13 B):** each service signs in as its own `service` record through `DEFINE ACCESS svc`, limited by table and field permissions. `migrator` (OWNER) and `backup` (VIEWER) are the only system users.                         | Per-service users; `migrator` and `backup` were added |
| 8   | **`api-public-read` on Cloud Run is private in dev:** IAM invokers only, scales to zero, at most 2 instances, reaches GKE over Direct VPC egress. It becomes public at 0.9 (D31), behind its D13 database login.                                    | Public behind Cloudflare                              |
| 9   | **Image selection is declared in Terraform:** `live/<env>/gcp/images.auto.tfvars` says `main`, `snapshot` or a digest for each service. Tags are content hashes, and there are separate `apps` and `apps-scratch` registries.                       | "Build images and deploy to Cloud Run"                |
| 10  | **Budget guardrail:** £15 a month, with alert emails at £3, £7.50 and £15 (#20). Nothing stops automatically, billing is never unlinked and storage is always kept. Dev costs about £3–5 a month.                                                   | Not specified                                         |
| 11  | **Supply chain:** GitHub Actions come from an allowlist only, pnpm enforces a minimum release age, and dependency fixes use pnpm overrides.                                                                                                         | Not specified                                         |
| 12  | **`main` is protected by the `protect-main` ruleset.** It's a solo project, so gates mean "deliberate", not "needs a second person".                                                                                                                | "Branch protection, PR templates"                     |
| 13  | **The Clerk CLI is linked** to the "He Is Real" app (`app_3JuNErrA1fDnJI7SBa3Qx9iYkqU`) through the git remote; nothing is stored in the repo. Never `clerk env pull` keys into `.env` files: Clerk keys go in Secret Manager like everything else. | Not specified                                         |
| 14  | **The OpenAPI specs in `libs/contracts` are the source of truth (D23),** updated to the v1 API plan and linted by Redocly in `lint`. Rules: `docs/api-conventions.md`. #28                                                                          | OpenAPI drafts in the `project` repo                  |
| 15  | **Services renamed (D33, D36):** `api-read` → `api-public-read`, `api-write` → `api-user` in apps, Nx, images, CI and Terraform (`moved` blocks; Cloud Run service and its service account replaced). #29                                           | api-read / api-write / api-admin                      |
| D14 | **Schema migrations (D14):** a Job applied by the `cluster` root, named after the content hash of `libs/database/schema` (declarative schema + run-once data scripts) and its parameters. Migrate, then deploy, by hand.                            | "Used by CI/deploy" (no mechanism)                    |
| D42 | **Automatic cluster plan (D42):** `tf-cluster-planner` may only send dry runs (admission policy) to the overlay's kinds in `database`; usable only from the reviewer-approved `cluster-plan` environment.                                           | Read-only planner (#32 round 1)                       |

### Clerk state (2026-10-17)

The Clerk dev instance exists, but nothing is wired in. There are no Clerk secrets in Secret
Manager and no production instance.

The dev instance currently has:

- **Sign-in:** email code and Google, with Google on Clerk's shared dev credentials.
- **Passwords:** enabled for sign-in, and required for email sign-ups with a 15-character minimum.
- **Protection:** CAPTCHA, lockout and leaked-password (HIBP) checks are on.
- **Not set up:** the legal-consent checkbox is off, the session token has no custom claims, and
  multi-factor login is off.

### Decisions made, not yet implemented (2026-10-17, 2026-10-18)

These override the plan. D1–D12 were decided from `project/context/research/required-decisions.html`,
D13–D36 from `project/context/research/m0-schema-consent-decisions.html` (the reasoning, the draft
schema and the v1 API plan are there). Move each one into the table above once it's built.

| #   | Decision                                                                                                                                                                                                                                                                                                | Plan said                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| D1  | **Clerk is the source of truth for roles** (`publicMetadata.role`, exposed as a session-token claim). SurrealDB keeps no authoritative role.                                                                                                                                                            | Undecided (Clerk or SurrealDB)                                     |
| D2  | **Clerk sign-in: Google + email (optional password or email code), interchangeable on one account.** Passwords: 8-character minimum, leaked-password check on (free). Free Hobby plan. Passkeys and multi-factor login need Clerk Pro ($20–25/month): decide at M3. Applied to the Clerk config in 0.5. | Google SSO + email/password                                        |
| D3  | **No load balancer and no Cloudflare-only origin restriction.** Cloudflare manages `heisreal.today` DNS from the domain cutover (proxy/WAF optional). The GKE tier stays private by design: private nodes, no public Services or Ingress, workers outbound-only.                                        | Cloud Run ingress restricted to Cloudflare (needs a load balancer) |
| D4  | **`web` runs on Cloud Run,** with the same image and Terraform pattern as the APIs.                                                                                                                                                                                                                     | Cloud Run or Firebase App Hosting                                  |
| D6  | **Clerk's US hosting is accepted.** Clerk is listed as a sub-processor under its DPA with SCCs / the UK addendum.                                                                                                                                                                                       | Safeguards to be confirmed                                         |
| D7  | **No `heisreal.today` DNS in this phase.** The domain stays with the prototype; services use Cloud Run's generated `*.run.app` URLs. Clerk stays on its development instance, since production needs a domain we own.                                                                                   | Cloudflare DNS in 0.7; staging behind Cloudflare in 0.9            |
| D8  | **YouTube is a later feature,** out of the current phase. Bunny.net is the only video host for now.                                                                                                                                                                                                     | Open Question 10 parked                                            |
| D5  | **Sentry and Umami are out of the current phase,** to be scheduled later.                                                                                                                                                                                                                               | Wired in from day one (0.6)                                        |
| —   | **Project opinion: no Apple-specific technology.** No Sign in with Apple, no Apple-only services; Apple Pay is allowed when Stripe provides it, and open standards such as passkeys are fine. See `project/CLAUDE.md`.                                                                                  | Google + Apple social login; Apple Pay                             |
| D9  | **SurrealDB stays a single node, in production too.**                                                                                                                                                                                                                                                   | HA left open                                                       |
| D13 | **Service logins + table/row permissions for every service:** each service signs in as its own `service` record and every table has `PERMISSIONS` (matrix tested on 3.2.4). Only `migrator` and `backup` stay system users. Replaces decision 7's per-service system users.                             | Per-service system users (VIEWER/EDITOR)                           |
| D14 | **Migrations: a Kubernetes Job applied by Terraform.** Declarative `schema.surql` plus numbered data migrations recorded in `_migration`; migrate, then deploy, by hand; CI applies the schema to SurrealDB on every PR.                                                                                | Migrations "by CI/deploy" as OWNER, how unspecified                |
| D15 | **Minimal v1 schema:** user, story, publicStory, tag, dpaVersion, consent, moderationReview, auditLog, idempotencyKey, `_migration`. Later tables arrive with their milestone. No `story.tags[]` copy: fetch `tagRefs`.                                                                                 | All 14 tables in `data-model.md`; denormalised tags                |
| D16 | **Clerk holds email, name, country and roles;** the `user` record holds only `clerkUserId`. Emails are fetched from Clerk at send time. Account settings (`notificationPrefs`) live in Clerk `privateMetadata` (review of #28).                                                                         | Profile fields on the user record                                  |
| D17 | **Consent is per person:** each story derives it from its submitter's current ledger state (computed, never stored).                                                                                                                                                                                    | Consent also stored on each story                                  |
| D18 | **No `consentState` cache:** the latest ledger event is read through an index.                                                                                                                                                                                                                          | `user.consentState` cache                                          |
| D19 | **No IP address** in consent evidence.                                                                                                                                                                                                                                                                  | `ipAddress` in the ledger                                          |
| D20 | **DPA versions are draft or published.** Text in the repo, hash computed by Terraform; v1 seeded as a draft; the DB refuses consent against a draft and freezes published versions. Legal sign-off is an M2 blocker.                                                                                    | Seed DPA v1 (0.8)                                                  |
| D21 | **Fail-closed consent guard:** every api-user/api-admin route has `@RequiresConsent` or `@NoConsentRequired(reason)`; a route-listing test enforces it. Draft creation, edit and upload also require current Art 9 consent (review of #28; matches plan 2.3).                                           | A guard "on every write path from day one"                         |
| D22 | **Legacy consent for the 24 existing testimonies:** a published `dpaVersion:legacy-squarespace`; the people are imported as having granted it.                                                                                                                                                          | Not specified                                                      |
| D24 | **Rest of M0, in order:** conventions + contracts → rename (D33) → D13/D27 spike → migration Job + schema → `libs/consent` → 0.4 → 0.5 → 0.9 → Bunny.net.                                                                                                                                               | 0.3 + 0.8 → 0.4 → 0.5 → 0.9                                        |
| D25 | **CQRS-lite:** separate command and query handlers; read models updated in the same transaction; no event sourcing.                                                                                                                                                                                     | Process split only                                                 |
| D26 | **`publicStory` is the only read model;** anonymous queries read only read models.                                                                                                                                                                                                                      | Public reads from the story table                                  |
| D27 | **Personal reads run as the person** in api-user, with their Clerk token, so the database returns only their rows.                                                                                                                                                                                      | Personal reads on api-read's read-only user                        |
| D28 | **CRUD for plain resources, named commands for state changes;** `/review` split into four commands; relationships use `PUT`/`DELETE`; commands return `{ id, version }`.                                                                                                                                | Mixed styles (`/review` decision field, `PATCH …/role`)            |
| D29 | **`version` on every aggregate,** `If-Match` required on modifying commands, `Idempotency-Key` on non-idempotent POSTs, webhooks deduplicated on event ID.                                                                                                                                              | Not specified                                                      |
| D30 | **HTTP conventions:** RFC 9457 errors, `/v1` prefix, slugs for public queries (old slugs `301`), IDs for commands, cursors, camelCase, `Cache-Control` + `ETag`.                                                                                                                                        | Custom error envelope, no versioning, `{idOrSlug}`                 |
| D31 | **The browser calls the APIs directly** at their `*.run.app` URLs; `web` holds no DB access, secrets or tokens. api-public-read becomes public at 0.9 (changes decision 8).                                                                                                                             | `api.` / `admin-api.` subdomains behind Cloudflare                 |
| D32 | **`web` prerenders from api-public-read only,** on the server; never calls api-user/api-admin. Clerk runs in the browser only.                                                                                                                                                                          | Not specified                                                      |
| D34 | **Dapr stays in the worker tier;** the APIs publish CloudEvents to Pub/Sub with the GCP client.                                                                                                                                                                                                         | Same (confirmed)                                                   |
| D35 | **Every personal read lives in api-user** (stories, account, consents, favourites, feed); api-public-read is strictly anonymous.                                                                                                                                                                        | Personal reads on api-read                                         |

D23 is implemented (decision 14 above), and so are D33 and D36 (decision 15).

**Deferred until the milestone needs them:** D10 transcription engine, D11 worker queue, D12 Dapr
state store (all M7). **Still open:** nothing for the current phase.

## Resolved backlog notes

Items from `project/thingstoremember.txt` that the implementation has settled:

- **"TypeScript – Express":** NestJS on Express (decision 2).
- **"SurrealDB single node or HA for day one":** single node, in production too (decision 5, D9).

## Changelog

- **2026-10-17:** file created; M0 status and decisions 1–13 recorded. D1–D9 decided (D5 = deferred), Apple opinion added; D10–D12 deferred.
- **2026-10-18:** D13–D36 recorded from `m0-schema-consent-decisions.html`. D23 implemented (#28): `libs/contracts` and `docs/api-conventions.md` (decision 14). Decision 10 corrected to £15 (#20).
- **2026-10-18:** D33/D36 implemented (#29): services renamed to `api-public-read` and `api-user` (decision 15); decisions 7 and 8 updated. DB user names stay until the schema PR.
- **2026-10-19:** D13 + D27 spike (D24 step 3) done: schema and seeds in `libs/database/schema`, 217 integration tests on SurrealDB 3.2.4 (`database:test-integration`, run in CI). Fixes to the draft schema (including review rounds 1–4 and D37/D38/D41) and the per-request session pattern are in [db-permissions.md](db-permissions.md).
- **2026-10-20:** D14 implemented (D24 step 4): the migrate Job, runbook in [the SurrealDB README](../infra/k8s/surrealdb/README.md#schema-migrations-d14). The init now runs inside SurrealDB at startup (a restart is the cutover that ends old sessions): it makes only `migrator` and `backup`, removes the per-service system users and writes the `service` logins; services sign in through `svc` (decision 7), with secrets `surreal-api-public-read-password` and `surreal-api-user-password`. DPA v1's hash comes from `libs/legal/dpa/v1.md` (placeholder; v1 stays a draft, D20). Person sessions only once `clerk_jwt_public_key` is set (task 0.5).
- **2026-10-20:** D42–D45 decided (`project/context/research/m0-migration-decisions.html`). **D44 replaces D22's legacy-DPA approach:** seed 0002 (`dpaVersion:legacy-squarespace`) is removed; the M1 import (task 1.9) gets a one-off `legacy-migration` consent category instead (not built yet; the schema's D22 legacy-consent rules stay until then). D42 implemented (row above). D43 (restart SurrealDB whenever the login set changes) and D45 (accept `svc` key rotation per migration) match what's built. Startup init is one transaction, readiness is proven by the identity-check sidecar, and migrations use a database fencing token and a restricted grammar (#32 review round 2).

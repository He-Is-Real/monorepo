# Delivery status

Where the build is against the delivery plan (`project` repo,
`context/future/delivery-plan.md`), and the high-level decisions made while implementing each
stage.

**Precedence:** the `project` repo holds the plan and the reasoning behind it. Where an
implemented stage below differs from it, **this file wins** for that stage. Decisions still
waiting to be made are in `project/context/research/required-decisions.html`.

Keep this file current: update it in the same PR that finishes a task or changes a decision
recorded here.

**Last updated:** 2026-10-19

## Milestones

| Milestone                     | Status         | Notes                                                                  |
| ----------------------------- | -------------- | ---------------------------------------------------------------------- |
| M0 Walking skeleton           | 🟡 In progress | 0.1 and 0.2 done; 0.7 partly done                                      |
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
| 0.3 Database schema v1        | ⚪ Next        |                                                                              |
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
| 7   | **Database users:** `api_read` (VIEWER), `api_write`, `api_admin` and `workflow` (EDITOR), plus `migrator` and `backup` users. Services never call each other.                                                                                      | Per-service users; `migrator` and `backup` were added |
| 8   | **`api-read` on Cloud Run is private in dev:** IAM invokers only, scales to zero, at most 2 instances, reaches GKE over Direct VPC egress. It becomes public at 0.9, behind the edge decision.                                                      | Public behind Cloudflare                              |
| 9   | **Image selection is declared in Terraform:** `live/<env>/gcp/images.auto.tfvars` says `main`, `snapshot` or a digest for each service. Tags are content hashes, and there are separate `apps` and `apps-scratch` registries.                       | "Build images and deploy to Cloud Run"                |
| 10  | **Budget guardrail:** £10 a month, with alert emails at £2, £5 and £10. Nothing stops automatically, billing is never unlinked and storage is always kept. Dev costs about £3–5 a month.                                                            | Not specified                                         |
| 11  | **Supply chain:** GitHub Actions come from an allowlist only, pnpm enforces a minimum release age, and dependency fixes use pnpm overrides.                                                                                                         | Not specified                                         |
| 12  | **`main` is protected by the `protect-main` ruleset.** It's a solo project, so gates mean "deliberate", not "needs a second person".                                                                                                                | "Branch protection, PR templates"                     |
| 13  | **The Clerk CLI is linked** to the "He Is Real" app (`app_3JuNErrA1fDnJI7SBa3Qx9iYkqU`) through the git remote; nothing is stored in the repo. Never `clerk env pull` keys into `.env` files: Clerk keys go in Secret Manager like everything else. | Not specified                                         |

### Clerk state (2026-10-17)

The Clerk dev instance exists, but nothing is wired in. There are no Clerk secrets in Secret
Manager and no production instance.

The dev instance currently has:

- **Sign-in:** email code and Google, with Google on Clerk's shared dev credentials.
- **Passwords:** enabled for sign-in, and required for email sign-ups with a 15-character minimum.
- **Protection:** CAPTCHA, lockout and leaked-password (HIBP) checks are on.
- **Not set up:** the legal-consent checkbox is off, the session token has no custom claims, and
  multi-factor login is off.

### Decisions made, not yet implemented (2026-10-17)

These were decided from `project/context/research/required-decisions.html` and override the plan.
Move each one into the table above once it's built.

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
| —   | **Budget raised to £15/month** (alerts at £3, £7.50, £15), #20.                                                                                                                                                                                                                                         | £10                                                                |

**Deferred until the milestone needs them:** D10 transcription engine, D11 worker queue, D12 Dapr
state store (all M7). **Still open:** nothing for the current phase.

## Resolved backlog notes

Items from `project/thingstoremember.txt` that the implementation has settled:

- **"TypeScript – Express":** NestJS on Express (decision 2).
- **"SurrealDB single node or HA for day one":** single node, in production too (decision 5, D9).

## Changelog

- **2026-10-17:** file created; M0 status and decisions 1–13 recorded. D1–D9 decided (D5 = deferred), Apple opinion added; D10–D12 deferred.
- **2026-10-19:** D13 + D27 spike (D24 step 3) done: schema and seeds in `libs/database/schema`, 133 integration tests on SurrealDB 3.2.4 (`database:test-integration`, run in CI). Three fixes to the draft schema and the per-request session pattern are in [db-permissions.md](db-permissions.md).

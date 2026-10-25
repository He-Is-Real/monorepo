# M2 consent forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Reworked 2026-10-25 for D93 (Joel's answers):** no form version hides a story
> (`requiresReconsent` became `requiresAcceptanceForNewSubmissions`, gating only new drafts and
> submissions); 18+ is on the sign-up form only; the share columns moved to a third, optional
> `socialSharingFormVersion` with use columns too. Where this plan differs, `docs/db-permissions.md`
> items 28–33 and `docs/delivery-status.md` describe what was built.

**Goal:** Versioned sign-up and testimony consent forms (D84), the ledger bound to them
(evidence hash v2), the gate rules, a dev-only placeholder DPA and forms (D75) with D48 off in
dev, and the public/legal + grant endpoints.

**Architecture:** Two form tables in `schema.surql`; the migration copies each legal text and
its sha256 into the database (`dpa-sync.surql`, new `form-sync.surql`), so the words a person saw
are kept beside the ledger and api-public-read can serve them. Every gate goes through
`fn::consent::granted`, which now also checks the grant's form version. libs/consent binds grants
to the in-force form version; api-public-read serves the published DPA and forms.

**Tech Stack:** SurrealDB 3.2.4 (SurrealQL), NestJS 12, Vitest, OpenTofu 1.13, Python runner.

**Spec:** `project/context/research/m2-decisions.html` (D67, D73, D75, D77, D84, D86) and the
coordinator's brief for PR "consent forms".

## Global Constraints

- Sign-up versions: version (record id), status draft|published|retired, textRef, textHash,
  dpaVersion, publishedAt. Testimony versions: the same plus requiresReconsent,
  coversPublicPublishing, draftRetentionMonths, shareYouTube, shareInstagram, shareTikTok,
  shareFacebook (all `DEFAULT ALWAYS false`). Frozen once published (only → retired).
- Ledger append-only, kept through erasure; v1 rows (no form) stay valid and verifiable.
- Evidence hash `heisreal-consent-evidence/v2` covers form kind, form version, its text hash,
  DPA version and hash, statement, event, mechanism.
- Dev placeholders only where OpenTofu's `dev_legal_placeholders` is set (live/dev/cluster) and
  the database's `_setting:consent.environment = 'dev'`; D48 off in dev.
- 18+ wording on every form version; no parental-consent wording (D77).

## Review Focus

- A grant against an older still-published or retired version → 409 (API), refused by DB if not published.
- A platform column added after a version was published → that version reads false (NONE).
- Retiring a version after a new column was added → succeeds (DEFAULT ALWAYS).
- A dev database restored elsewhere → placeholder forms/DPA stop counting (setting off).
- Withdrawing a v1 (formless) grant → still possible (Art 7(3)).

---

### Task 1: Schema: form tables, ledger binding, gates, dev placeholder setting

**Files:** `libs/database/schema/schema.surql`, `form-sync.surql` (new), `dpa-sync.surql`,
`migrate.py`, `data/0005-dev-legal-placeholders.surql` (new), harness `support/harness.ts`

- Functions: `fn::legal::dev_placeholders()`, `fn::legal::counts($dpa)`,
  `fn::legal::dpa_in_force()`, `fn::form::counts($form)`, `fn::form::latest($kind)`,
  `fn::form::statements($form)`, `fn::form::reconsent_after($form)`,
  `fn::consent::valid($c)`, `fn::consent::granted` (now with `valid`),
  `fn::consent::signup_accepted($user)`, `fn::consent::may_share($user, $platform)`.
- Tests (`libs/database/integration/consent-forms.int-spec.ts`): stale/draft/retired form
  refused; latest sign-up gate; requiresReconsent supersedes; new column false; sharing helper;
  frozen versions; placeholder refused outside dev; v1 rows still count.

### Task 2: OpenTofu flag and params

**Files:** `infra/terraform/modules/db-migration/main.tf` (+tests), `modules/cluster`
(variables, migration.tf, tests), `live/dev/cluster/main.tf`, `local-migration.mjs`.

- `dev_legal_placeholders` (dev only), params `dpa_text`, `form_sha256`, `form_text`,
  `dev_legal_placeholders`; `dev_consent_relaxed` default false in dev.

### Task 3: libs/consent v2

**Files:** `consent.types.ts`, `consent-ledger.ts`, `account-consents.controller.ts`,
`consent-checker.ts`, integration `ledger.int-spec.ts`.

- `evidenceHash` v2 with fixed vector; `verifyEvidence(row)` for v1 and v2; grant input
  `{ form, formVersion, statement, mechanism }`; 409 `form_version_not_in_force` /
  `statement_not_on_form`; `ConsentChecker.callerHasSignupConsent`.

### Task 4: api-public-read legal endpoints + contracts

**Files:** `apps/api-public-read/src/app/legal/legal.controller.ts`, contracts yaml.

- `GET /v1/legal/dpa`, `GET /v1/legal/forms/{form}`.

### Task 5: dev-seed real consent + behavioural

**Files:** `apps/dev-seed/src/app/seed.ts`, `consent.ts` (new), behavioural `api.behaviour.ts`.

### Task 6: Docs

delivery-status, db-permissions, libs/legal README, api-conventions.

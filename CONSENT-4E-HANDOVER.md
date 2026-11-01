# Consent 4e: test clean-up handover

Delete this file before the consent 4e PR merges.

This branch (`feat/consent-4e`, from `origin/main` at 182715d) only **deletes tests** that cover the old consent machinery,
so the 4e work starts from a cleaner context. The plan is in `project/context/research/privacy-consent-architecture.html` (4e, 8b) and
`project/context/future/architecture/gdpr-consent.md` ("Consent, privacy and terms opinions"). There are no changes to
production code, schema, contracts or docs. `pnpm nx run-many -t typecheck lint` and `-t test` (unit) pass. The integration, e2e and
behavioural suites were **not run**. Kept tests that set up old consent still pass against today's schema, but they
will break once the old tables go.

## Deleted whole files

- `libs/consent/integration/ledger.int-spec.ts`: the consent ledger (grant/withdraw, versions, evidence hashes, mechanisms, fences).
- `libs/consent/integration/consent-guard.int-spec.ts`: the route consent guard against SurrealDB (`fn::consent::granted`).
- `libs/consent/integration/idempotency.int-spec.ts`: Idempotency-Key committed atomically with consent commands.
- `libs/consent/src/lib/consent.decorators.spec.ts`: `@RequiresConsent` / `@NoConsentRequired` and the `CONSENT_REQUIRED` table.
- `libs/consent/src/lib/consent.module.spec.ts`: ConsentModule's global guard (403 without consent, fail closed, refuse to start).
- `libs/consent/vitest.integration.config.mts` plus the `test-integration` target in `libs/consent/package.json` and its `tsconfig.spec.json` includes. No integration tests were left, and vitest fails when it finds no test files.
- `libs/database/integration/consent.int-spec.ts`: the consent table rules (append-only, own-session only, published DPA, legacy rules).
- `libs/database/integration/consent-forms.int-spec.ts`: the three form-version tables (D84/D114 statements, coversTerms, retention, frozen once published).
- `libs/database/integration/consent-gates.int-spec.ts`: `fn::consent::*` gates on drafts, submit, approve, and the computed `story.consent`.
- `libs/database/integration/dev-consent.int-spec.ts`: the dev-only "relaxed consent" switch (D48).
- `libs/database/integration/legal-documents.int-spec.ts`: `dpaVersion` / `termsVersion` numbering, immutability, and grants binding the documents in force.
- `apps/api-admin/integration/legal-documents.int-spec.ts`: api-admin's legal-document publish/list routes.
- `apps/api-user/integration/submit-sharing.int-spec.ts`: submit with the social-sharing grant in one transaction, replays.
- `apps/web/e2e/consent.e2e.ts`: `/consent/sign-up`, `/consent/testimony` and the re-consent banner.
- `apps/web/e2e/legal-documents.e2e.ts`: `/admin/legal` editor/preview/publish, plus `/privacy` and `/terms` versions pages.
- `apps/web/src/components/consent/consent-form.spec.tsx`: the consent form bound to the person who opened it.
- `apps/web/src/components/share/share-flow.spec.tsx`: the share flow's ConsentStep/ReviewStep boxes (fail closed without a box, and a privacy policy changed mid-review).

## Deleted cases in kept files

- `libs/database/integration/retention.int-spec.ts`: consent can't be deleted by anyone; the migrator can't prune too early (it.each); the 6-year nightly prune; updates refused.
- `libs/database/integration/service-permissions.int-spec.ts`: public-read can't see `consent` (one it.each row); api_user can't read/forge consent; api_admin can't write consent; api_admin manages DPA versions; workflow reads consent but can't write it; the whole "consent ledger is append-only" describe.
- `libs/database/integration/person-session.int-spec.ts`: can't read others' consent via `fn::consent::current`; sees `story.consent`; a draft needs current Art 9 consent.
- `libs/database/integration/erasure.int-spec.ts`: keeps the consent ledger as proof (and the stub's shape); erases after a consent withdrawal.
- `libs/database/integration/concurrency.int-spec.ts`: approval vs publish-consent withdrawal; submit vs consent withdrawal.
- `libs/database/integration/schema.int-spec.ts`: "still has every guard event" (the consent table's 11 events).
- `libs/database/integration/migration.int-spec.ts`: previous release "starts with a draft DPA and no forms"; the whole D114 statements-sync describe (3 cases) and its `BEFORE_STATEMENTS_RELEASE`; DPA file hash/text sync and frozen once published (D20/D84); seeded draft DPA without its file (P2-5).
- `libs/database/integration/favourites.int-spec.ts`: a heart needs the sign-up consent.
- `libs/database/integration/themes.int-spec.ts`: after Art 9 is withdrawn, the owner can't change themes (theme deletion is still covered by "deleting a theme takes it off every story…").
- `libs/database/integration/dev-seed.int-spec.ts`: refuses to migrate if `libs/legal/dpa/dev_seed.md` is missing.
- `libs/database/integration/support/harness.ts`: `LEGACY_SHA256` and `seedLegacyDpaFixture` (only `consent.int-spec.ts` used them).
- `apps/api-user/integration/account.int-spec.ts`: `signupConsent.accepted`; `testimonyConsent.acceptanceRequired` plus `POST /v1/account/consents`.
- `apps/api-user/integration/erasure.int-spec.ts`: withdrawing the testimony consent deletes the account; a withdrawal whose erasure fails still answers 202 and stays requested; withdrawing publish keeps the account.
- `apps/api-user/integration/favourites.int-spec.ts`: hearts need the sign-up consent (`consent_required`).
- `apps/api-user/integration/my-stories.int-spec.ts`: per-story sharing granted, listed and withdrawn (O4).
- `apps/api-user/integration/stories.int-spec.ts`: nothing stored without testimony consent or before sign-up is accepted.
- `apps/housekeeping/integration/housekeeping.int-spec.ts`: a testimony form version with longer `draftRetentionMonths`, published while a deletion is open.
- `apps/dev-seed/integration/seed.int-spec.ts`: every fixture person has real ledger consent with v4 evidence hashes.
- `apps/dev-seed/behavioural/api.behaviour.ts`: dev serves the placeholder privacy policy, terms and consent forms.
- `apps/web/e2e/contract.e2e.ts`: the legal routes fit the contract; the stub's consent grants fit the contract.
- `apps/web/e2e/share.e2e.ts`: 200% text consent boxes; refusing testimony consent; skipping the consent step with a newer privacy policy; the sharing box (unticked, already shared, lost answer resent, stop sharing on Review, an answer without sharing); no sign-up consent sends people to set up. Unused `enlargeText`, `SOCIAL` and the `consents()` helper went too.
- `apps/web/e2e/profile.e2e.ts`: share one story and stop; a lost grant/withdrawal answer (2 cases); a withdrawn shared story can stop sharing; no sharing yes/no isn't "only on heisreal.today". Also the unused `shared()` / `granted()` helpers.
- `apps/web/e2e/favourites.e2e.ts`: a heart refused for the sign-up consent kept on the device; device hearts not offered before sign-up; a heart taken off before the refusal stays off.
- `apps/web/e2e/text-zoom.e2e.ts`: `/consent/sign-up` and `/consent/testimony` in the 200% page list; `/admin/legal` at 200%.

## Kept tests that depend on old consent setup (rewire these)

Most of these only use `grantAll` / `publishDpa` / `consentEvent` / `shareStory` (`libs/database/integration/support/harness.ts`)
or the shared `buildWorld` (`support/world.ts`, which calls `publishDpa` and `grantAll`) as a precondition. Replacing those helpers with
4e versions (seed version 0 of each table, set the user's terms and testimony pointers) fixes most of the list in one place.

- `libs/database/integration/support/harness.ts`: `publishDpa`, `publishForm`, `legalParams` (used by `TestDatabase.params()`: dpa/form/terms params for the migration), `consentEvent`, `shareStory`, `grantAll`, `CONSENT_TYPES`, `FORM_*`, `DPA_V1_SHA256`. These need replacing; `MigrationParams` mirrors OpenTofu's db-migration variables.
- `libs/database/integration/support/world.ts` (`buildWorld`): publishes DPA v1 and grants everything to Ann and Bob.
- `libs/database/integration/service-permissions.int-spec.ts`: "reads publicStory and published DPA versions only"; api_admin "reads every story, the consent ledger…" (expects 8 consent rows); workflow "cannot see drafts DPA or reviews". Swap in the 4e tables' permissions.
- `libs/database/integration/person-session.int-spec.ts`: "sees their own consent, user record and published DPAs only".
- `libs/database/integration/person-linked.int-spec.ts`: `CLASSIFICATION` must list every schema table (`consent`, `dpaVersion`, `termsVersion`, the 3 form tables, `legalFence`, `_setting`), and `LINKED.consent` runs the erasure-race cases on `consent`. Update both with the schema.
- `libs/database/integration/schema.int-spec.ts`: the DDL-refusal it.each and "refuses schema changes in a person session" use `consent` / `consent_append_only` / `fn::consent::current` as targets. Point them at a 4e table/event.
- `libs/database/integration/migration.int-spec.ts`: `SEEDS` list (`0001-seed-dpa-v1`, `0005-dev-legal-placeholders`, `0007-dev-legal-documents`); "second run is a no-op" and public-read/backup checks read `dpaVersion`; previous-release upgrade "migrates to this release" asserts DPA text and the form tables; the cutover case runs `REMOVE EVENT consent_append_only ON consent`.
- `libs/database/integration/dev-seed.int-spec.ts`: params pass `dpa_sha256` with `dev_seed`; "went through the real rules" reads `story.consent` and `dpaVersion:dev_seed`.
- `libs/database/integration/retention.int-spec.ts`: the audit-row and backdated-gdprDeletedAt cases still set up DPA/consent; the backdated case ends with the consent prune.
- `libs/database/integration/erasure.int-spec.ts`: setup uses `shareStory`.
- `libs/database/integration/{concurrency,favourites,themes,images,media-processing,story-shape,submission-limits,uploads}.int-spec.ts`: `grantAll` / `publishDpa` setup only. `themes.int-spec.ts` also builds an upgrade fixture with `dpa_sha256`.
- `apps/api-user/integration/stories.int-spec.ts`: "refuses to submit without publish consent or 200 characters": drop the publish half, keep the 200-character check. The `person(who, grant)` helper uses `grantAll`.
- `apps/api-user/integration/erasure.int-spec.ts`: "deletes my account…; the ledger stays" asserts the ledger count; setup uses `grantAll`.
- `apps/api-user/integration/export.int-spec.ts`: "holds everything of mine" expects consent lines and a sharing grant in the export.
- `apps/api-user/integration/{account,my-stories,uploads}.int-spec.ts`: `publishDpa`/`grantAll` setup.
- `apps/api-public-read/integration/stories.int-spec.ts`: the health check expects `consentChecksRelaxed: false` (D48).
- `apps/housekeeping/integration/housekeeping.int-spec.ts`: setup uses `publishDpa`/`grantAll`/`consentEvent`; the erasure-request describe makes requests by consent withdrawal (see Surprises).
- `libs/database/integration/erasure.int-spec.ts`: "a withdrawal api-user never got to erase stays requested, and housekeeping deleting the request erases the person" creates the `erasureRequest` by withdrawing `account_data` (see Surprises).
- `apps/dev-seed/testing/index.ts` (`devDatabase`): `legalPlaceholders` / `dev_legal_placeholders` / `dev_consent_relaxed` params. `apps/dev-seed/integration/seed.int-spec.ts`: the suite title and the dev setup.
- `apps/dev-seed/behavioural/api.behaviour.ts`: the health check expects `consentChecksRelaxed: false`. `web.behaviour.ts`: no "Consent checks relaxed (dev)" footer note. `account.behaviour.ts`: sign-in lands on `/consent/sign-up` and expects `signupConsent` / `testimonyConsent` on `/v1/account`. `story-upload.developer.ts`: ticks the sign-up and testimony boxes.
- `apps/web/e2e/stub-api-user.mjs`, `apps/web/e2e/stub-api.mjs`: the stubs serve `/v1/account/consents`, `/v1/legal/*`, the admin legal-document routes, `signupAccepted` / `granted` session seeds and per-story `sharing`. Many e2e files depend on them.
- `apps/web/e2e/share.e2e.ts`: the whole flow ("the whole written flow fits every step") and `toWrite()` tick the Art 9 box on "Your story and your data" and `PUBLISH` on Review; `SIGNED_UP` seeds `signupAccepted`.
- `apps/web/e2e/{share-images,share-limits,share-media,profile}.e2e.ts`: seed `signupAccepted` / `granted`. `profile.e2e.ts` "download my data" expects `consents` in the file; "the one account-wide withdrawal is Delete my account" checks the delete card's "withdraw your consent" wording.
- `apps/web/e2e/contract.e2e.ts`: the account bootstrap check (the stub's `signupConsent` / `testimonyConsent` answer); the hearts check uses a `no-consent` session; the submit-flow check reads and posts `/v1/account/consents` (grants, the `share_socials` and other withdrawals).
- `apps/web/e2e/{pages,indexing}.e2e.ts`: the D48 "Consent checks relaxed (dev)" footer note (shown, and not shown).
- `apps/web/e2e/{alignment,static-pages,open-states,text-zoom,donate}.e2e.ts`: `/privacy` and `/terms` pages (`[data-legal-version]`, `[data-legal-text]`). They stay valid if 4e keeps those pages and attributes.
- `apps/web/e2e/admin-limits.e2e.ts`: the admin nav links to "Legal documents" at `/admin/legal`.
- `apps/web/src/lib/api-user.spec.ts`: uses `consent_required` as its sample 403 problem.
- `libs/auth/src/lib/role.guard.spec.ts`: builds its test app with `ConsentModule.forRoot` and `@NoConsentRequired`.
- `libs/auth/integration/clerk-session.int-spec.ts`: imports `PersonSessions` from `@heisreal/consent` (and `libs/consent/src/lib/person.spec.ts` tests it). Move it if `libs/consent` goes.
- `libs/database/src/lib/{idempotency,query}.spec.ts`: use `consent:*` ids and "consent ledger is append-only" only as sample strings. No rewiring needed unless you want tidier names.

## Behaviour the deleted tests covered that 4e still needs

Re-test these at the behaviour level, against the 4e design.

- **Version tables are immutable and admin-only:** only api-admin creates a version; nobody (the migrator included) updates or deletes one; `release_date` is the database's time; ids number from 0 and latest = highest (was: legal-documents, consent-forms, service-permissions "manages DPA versions").
- **The public reads the four texts and their past versions**, but never who published them (was: legal-documents "the public reads the documents").
- **Pointers:** only the person's own session sets or moves their terms/testimony pointers and their story's media pointer; no service or admin can; forward only; accepted only if still the latest; `…AgreedAt` set by the database; both null or both set (was: consent.int-spec own-session/forge cases, service-permissions forge cases).
- **A stale agree** (the page showed an older version) is refused, and the page shows the change instead of retrying the old version. The share flow keeps the draft (was: share-flow.spec privacy-policy-changed case; share.e2e newer privacy policy).
- **Account creation needs the terms** (one "I agree", 18+ in the terms). A person on older terms is sent to a redline + agree before using the account. Hearts and other account features wait for that, and a heart pressed before it is kept on the device and offered after (was: account.int-spec signupConsent, favourites api-user/db/e2e cases, consent.e2e, share.e2e "without the sign-up consent").
- **No draft or story data is stored before the testimony consent**, and a newer testimony version needs re-agreeing (redline + tick) before a new story. Refusing stops before anything is stored (was: person-session "needs current Art 9", stories.int-spec, share.e2e refusing, account.int-spec acceptanceRequired, consent.e2e banner).
- **Concurrency:** agreeing or moving a pointer racing an account deletion must fail safely; nothing lands for an erased person (was: concurrency consent-withdrawal cases, person-linked `consent`).
- **The social media sharing box** at the end of the upload: offered unticked, per story, names every platform, recorded with the submission (both or neither, replay-safe). It can't be withdrawn (4e), so the old stop-sharing UI goes (was: submit-sharing, share.e2e sharing cases, profile sharing cases).
- **Account deletion is the withdrawal:** after deletion nothing suggests ongoing consent. The pointers go with the user/story rows; the stub, tombstone and audit rows hold no consent (was: erasure "keeps the consent ledger as proof", which pinned the opposite; also its stub-shape check `createdAt, gdprDeletedAt, id` and "the stub can't be deleted", which 4e still wants).
- **The schema's guard events survive schema-change attempts** by services and people (was: schema "still has every guard event"). Re-point it at the 4e immutability events.
- **The migration seeds version 0 of each table**, idempotently, and a later run never changes a saved version (was: migration D20/D84/D114 file-sync cases, dev-seed DPA file case).
- **Dev-seed:** fixture people get pointers on the versions in force, so published stories pass the real rules (was: seed.int-spec "real consent on the forms in force").
- **The data export** includes the person's pointers/agreed versions (was: inside export.int-spec, kept).
- **Admin publish screen** (`/admin/legal` today): text box, redline, preview, save as next version, a stale save asks to reload, and it fits at 200% text on a 320 px phone (was: legal-documents.e2e, api-admin legal-documents, text-zoom).
- **Draft retention:** housekeeping's draft deletion used the testimony form version's `draftRetentionMonths` (6). If 4e drops form features, decide where the 6 months lives (was: housekeeping "a form published with a longer retention").

## Surprises

- **`erasureRequest` has only one writer: the consent-withdrawal event.** It is written only by `consent_withdrawal_requests_erasure` on `consent` (`libs/database/schema/schema.surql` ~line 1899 and the comment at ~2565). The plan keeps `erasureRequest`, but once `consent` goes nothing creates one, and "Delete my account" / Clerk's webhook erase directly. Ask Joel whether `erasureRequest` (and housekeeping's erasure-request chore) should go, or be written by the delete-account path. This is a data/behaviour decision. The kept tests that create requests by withdrawal are listed above.
- **The route-level consent machinery** (`libs/consent`: `@RequiresConsent` / `@NoConsentRequired`, the global guard, `CONSENT_REQUIRED`, D21) isn't named in 4e's "What goes" list, but it runs on `fn::consent::*`, which does go. I deleted its tests. 4e still needs some route gate ("terms agreed", "testimony consent on latest") or a database-level check. `libs/consent/src/testing.ts` (`listAppRoutePolicies`) was already unused before this branch; I left it, and it can go with the lib.
- **The D48 "relaxed consent" dev switch** (`dev_consent_relaxed`, `_setting`, `consentChecksRelaxed` on `/health`, the footer note) relaxes the old `fn::consent` gates, so it presumably goes too. Its test file is deleted; the health/footer assertions are listed above.
- **Docs still name deleted test files:** `docs/delivery-status.md` (`consent.e2e.ts`, `legal-documents.e2e.ts`, `consent-form.spec.tsx`) and `docs/db-permissions.md` (~line 720, the legal-documents int-specs). Left alone (no doc changes on this branch).
- **OpenTofu module fixtures for legal files were kept:** `infra/terraform/modules/db-migration/tests/fixtures/*/dpa/v1.md`, `dpa-sync.surql` and `dpa-changed/` test the db-migration module's packaging of `libs/legal`. They are tied to production infra, not to consent tests, so they change with the module.
- Pre-existing lint warnings (not mine): `apps/web/e2e/stub-api-user.mjs` unused `readBytes`; non-null assertions in `apps/web/src/components/stories/story-media.spec.ts`.

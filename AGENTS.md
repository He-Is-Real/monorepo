# He Is Real Today monorepo

Nx + pnpm workspace on Node 24 LTS: Next.js (`apps/web`), NestJS on Express (`apps/api-*`,
`apps/workflow`), shared libs (`libs/*`), and SurrealDB Kubernetes manifests
(`infra/k8s/surrealdb`). Read `README.md` first; CLIs and accounts are in `docs/tooling-and-accounts.md`.

Two docs record where we are and how the site behaves. Read both before starting a task:

- `docs/delivery-status.md`: progress only, written for the non-technical project owner. Each
  milestone is a heading with a checklist of its parts; a done part is a tick and a few words. Follow
  its "How to edit this file" section. Update it in the same PR when work starts or finishes.
- `docs/how-the-app-works.md`: the rules for how the app behaves, by area, plus the technical
  decisions that override the `project` repo's plan. A new or changed rule needs Joel's decision
  first (the ownership rule below); record it there in the same PR.

API work follows `docs/api-conventions.md`; the OpenAPI specs in `libs/contracts/openapi` are the
source of truth, so change them in the same PR as the code.

- **Joel's input is required for database, API and behaviour changes (Joel, 2026-11-01; made explicit
  2026-11-05).** Joel owns these levels. No agent (coding, reviewing or coordinating) decides them on its own:
  - **Database data structure:** tables, fields, types, indexes, record ids, permissions, events and
    functions that change what is stored or who may read or write it, and migrations or data scripts
    that reshape or delete data.
  - **API:** OpenAPI contracts, routes, request and response payloads, status and error codes.
  - **Behaviour:** what users, moderators and admins see and can do, including legal texts, limits and
    what is public.

  How it works:
  - Build only changes Joel has approved (a decision doc in `../project/context/research`, or his direct
    answer). The PR body names that approval for each such change.
  - If you find you need a change Joel hasn't approved (a new field, a changed route or payload, different
    user-visible behaviour), stop and report it as a question with a recommendation. Don't build it.
  - Reviewer agents have no authority at these levels. They may block a merge or deployment and make
    suggestions, but a finding that would change any of them is labelled "Needs Joel" and goes to Joel,
    not to the coding agent as an instruction. An unapproved change at these levels is a blocking finding.
  - Exempt: bug fixes that restore behaviour Joel already approved, tests, docs, and infrastructure that
    doesn't affect these levels. Say so in the PR.

- Services never call each other. Each API connects to SurrealDB as its own least-privilege user
  (api-public-read is read-only). Don't merge services or share DB users.
- Secrets come only from GCP Secret Manager: through `libs/secrets` (SDK, ADC) in our code, and
  through External Secrets Operator on clusters. Never commit secret values or add key files.
- **`.env` files are committed (Joel, 2026-11-14).** They hold config only: plain settings, and a
  secret's Secret Manager _name_ where code needs one (e.g. `SURREAL_PASSWORD_SECRET=…`), never its value,
  so every env file is safe to publish. gitleaks (pre-commit hook and CI) scans them.
- **Generated files and `.gitignore` (Joel, 2026-11-14).** Commit only source, config, env files and
  lock files; never build output, caches, test reports, OpenTofu state or plans, or logs.
  - A PR that adds a tool or target that writes files adds its `.gitignore` entry in the same PR.
  - If `git status` shows a generated file as untracked, fix `.gitignore`; don't leave it or commit it.
  - Deleting or renaming a project: also delete its old local folder (`dist`, `out-tsc`,
    `node_modules` stay behind as ignored files), e.g. `git clean -ndX apps/<old>` to preview, then `-fdX`.
- Nothing on GKE is reachable from the internet: private nodes only, and no `LoadBalancer` or
  `NodePort` Services and no Ingress/Gateway. Workers (Dapr workflow, inference workers) run
  off Google Cloud (Joel's machine, later church hardware) and connect outbound only, to Pub/Sub. Public entry points are Cloud Run services only.
- Testimonies are GDPR Article 9 data. New personal data must fit the consent and erasure model.
- **Responsive everywhere (Joel):** every page and view is mobile-first and works from 320 px phones through foldables, tablets (both orientations) and 1920 px+ desktops: no horizontal scroll, 44 px touch targets, readable line lengths, safe-area insets. Cover each new page in `apps/web/e2e` (device matrix in `devices.ts`): its "fits the screen" checks run on every device; whole flows and other behaviour run on `BEHAVIOUR_DEVICES` (one phone, one desktop) only.
- **Tests measure behaviour (Joel, 2026-10-24).**
  - What matters is the system's behaviour, checked by good, reliable tests. A bad test costs more than a failure that a behaviour test catches and we fix.
  - Test at the highest level that can see the behaviour:
    - Playwright in `apps/web/e2e`, across the device matrix;
    - the dev behavioural suite (`apps/dev-seed/behavioural`);
    - integration tests against a real SurrealDB, where the database is the behaviour (permissions, consent, publishing).
  - Avoid unit tests, unless something is hard to test from above or the logic is complex enough to need its own coverage. Backend changes reach the behaviour tests above them through the Nx `affected` graph.
  - Don't test an API route that no finished frontend feature uses yet.
  - Tests must give the same result locally and in CI: no dependence on timing, machine load, ports or shared state.
  - Remove a flaky test, or one that stubs away the behaviour it claims to check, or rebuild it at the right level. Deleting low-value tests is welcome.
  - TDD belongs at the behaviour level, at the point in our process where that behaviour is defined.
- **Performance and scale tests stay local and separate (Joel, 2026-11-06).** They run only on a
  developer's machine against a throwaway local SurrealDB in Docker: never in CI, and never against
  GCP or Bunny (budget). They live under `scale/*.scale-spec.ts` with their own Vitest config and Nx
  `scale-test` target, so CI's `test` and `test-integration` targets can't pick them up. Don't wire
  them into CI. Example: `pnpm nx run api-public-read:scale-test`.
- **All cloud deployments and modifications go through OpenTofu (`infra/terraform`; D54: never Terraform),
  including proofs of concept.** Run it with `tools/scripts/tf.sh <root> …` (locally it acts as the root's
  CI identity; `TF_SH_IDENTITY=self` uses yours). Never use console clicks, `gcloud … create/update`, or
  `kubectl apply` against GKE. Adopt anything made by hand with `import` blocks. Read-only commands are fine.
  Exceptions: the Clerk instance's settings (`infra/clerk/dev.json`, applied with
  `infra/clerk/clerk-config.mjs`, decision 17 in `docs/how-the-app-works.md`), and recovering a KMS key
  version (`infra/terraform/README.md`, "Break-glass").
- **Plans run on their own; every apply needs one approval.** An approval means "I read this plan and
  choose to apply it". It isn't access control, and approving your own run is expected. Claude may approve
  dev applies. Applies happen through the `dev` environment in `tofu-apply.yml` (it applies exactly the plan
  it saved) or a developer running `tf.sh <root> apply`. `bootstrap` is applied locally only.
  **One exception, dev only (Joel, 2026-10-30; D120):** a dev plan whose every change is a Cloud Run
  service or job moving to a new image digest from our own `apps` repository applies without the click
  (`tools/scripts/tf-image-only.mjs`, job `auto-approve-1`). Anything else (the database or cluster, IAM,
  secrets, Bunny, Stripe, any create, delete or replace) waits for the approval. Production never applies
  on its own; don't widen the check or remove the `dev` environment's required approval.
- **Local plans need no permission (Joel, 2026-11-05).** Any agent may run `tools/scripts/tf.sh <root> plan`
  (and `plan-summary`, `location-check`) locally without asking Joel first. A plan changes no cloud
  resource; it only takes the state lock while it runs and writes a plan file. Applies are different: see
  the rule above.
- State and saved plans are encrypted with Cloud KMS (`tofu-state`; `tofu-bunny` for bunny). Never disable
  or destroy those keys or their versions, and never revert bootstrap wholesale. State must still never hold
  secrets: write-only attributes for values, `ephemeral` for tokens. One approved exception (Joel,
  2026-10-21; D57): the `bunny` root's state holds the Bunny provider's computed keys. Only developers and
  `tf-bunny` can read or decrypt it; CI gets `tf-bunny` only on `main` (`tofu-apply.yml`, `tofu-drift.yml`),
  never in PRs; and the root refuses to plan if anything Bunny is public. Don't extend it to other
  resources or roots.
- **CI logs are public (public repo).** Never print secrets. Bunny jobs mask the Bunny keys and publish only
  `tf.sh … plan-summary`; raw output goes to `gs://heisreal-dev-tfstate/dev/bunny/logs/`. Never set
  `TF_LOG` or step debug for tofu (`tf.sh` refuses). Workflows start from `permissions: {}`; never use
  `pull_request_target`. Install the secret-scanning hook once per clone: `mise install && tools/scripts/install-hooks.sh`.
- **Logging (Joel, 2026-11-22).** Read `.claude/skills/writing-logs/SKILL.md` before adding or changing
  logging, error handling, request handlers, jobs or workers (decisions: `../project/context/research/logging.html`).
  Must-follow:
  - One wide event per request or job, built up during the work and written once at the end; fold
    facts into it as fields. No `console.*` and no mid-request "breadcrumb" lines (only start-up,
    background work, the immediate unexpected-error line and the separate search event stand alone).
  - Stable `snake_case` field names grouped by area (`http`, `user`, `story`, `db`, `external`, `error`…),
    units as suffixes (`_ms`, `_bytes`); time every SurrealDB and outside call.
  - Every event carries `ref`, the request's UUID v7 that is also the `traceparent` trace id and the
    "Reference" people see (except search events). One trace id goes browser → services → Pub/Sub job →
    the worker's `job` event; timings go in the wide event; no tracing library (LG-4 A).
  - No sampling: every event is kept for 30 days (LG-6 A).
  - Every entry carries deployment details, `service.name / version / revision / env` and on Cloud Run
    `region / instance` (LG-10); `libs/logging` adds them, `version` is the commit baked into the image.
    Request and job events also carry `process.cold_start / uptime_ms`, and api-public-read's
    `cache.hit / stale / age_ms / not_modified` (LG-12); don't write them by hand.
  - Every field has a data class: plain (incl. email, IP, browser user agent for bot detection, story title), keyed hash (HMAC, key from
    Secret Manager, `_hash` suffix), long text (hash unless error), or never (tokens, cookies, keys,
    secrets, card data). LG-1 to LG-10 and LG-12 are decided; ask Joel about anything new.
  - Long text: hashed unless the request ends in an error, a refusal or a rate limit. Story text,
    transcripts and request bodies are hashed by default and logged in full whenever the request or job
    ends in an error, an input refusal or a rate limit (LG-9b); not found and restarting stay hashed.
    No debug window or switch. That hashing only keeps log
    volume down for long, many-paragraph fields; it is not a privacy measure.
  - Search events: each search is its own `event: "search"` with no `ref` and no session or token hash;
    terms and filters plain; IP, email and user id only as keyed hashes with the search-only key
    (`log-search-hmac`), never plain, not on error. The route's own wide event never carries the terms;
    Cloud Run's request lines for search URLs are excluded in OpenTofu (LG-2g A).
  - Sensitive fields are never plain, not even on error; strip them from bodies. Only
    the session id and token are logged, as keyed hashes; cookies, API keys, passwords and auth headers
    are not logged at all (the session hash is enough).
    Log both `user.session_hash` (HMAC of Clerk's session id `sid`, for journeys) and `user.token_hash`
    (HMAC of the whole token, for "was this exact token used?") on every event except search events; never the raw token.
  - Errors are fields on the event (`outcome`, `error.type/code`); messages never quote request data.
    Server errors are logged by the servers only; the browser reports only its own failures: its
    crashes and requests that got no answer (sent once it can reach us again, memory only; LG-1c, LG-9a).
  - A failed log send must never fail, slow or change the request; same JSON on stdout locally, in CI and on Google.
  - Read logs in Axiom by default (`gcloud logging read` for Google's copy and Cloud Run's own lines, LG-5).
    Stats are Axiom queries only, grouped by route, service, outcome, action or day, never by person,
    story or address (LG-8).
- Budget guardrail: £15/month budget with alert emails at £3/£7.50/£15 (no automatic stop). Never
  unlink billing; storage is always kept.

## Working in the workspace

**Modules and tests (NestJS 12).** Nest 12 packages are ESM only; the services and their libs stay
CommonJS TypeScript (no `"type": "module"`, extensionless relative imports, `__dirname`), bundled by
webpack, and Node 24 loads Nest through `require(esm)`. So a dependency used by a service must not
contain top-level `await` (`ERR_REQUIRE_ASYNC_MODULE`), and service code can't use `import.meta`.
Tests in the Nest apps and libs use Vitest (`vitest.config.mts`; `vi.fn()`, globals on); the
real-SurrealDB suites use `vitest.integration.config.mts` with libs/database's global setup.
`apps/web` uses Jest.

**Web UI building blocks** live in `libs/web-ui` (`@heisreal/web-ui`): pages use them instead of their own
styled copies (`docs/how-the-app-works.md`, technical decisions; `libs/web-ui/README.md`). Every drop-down is
its `Select`, every text box its `Input`, every text area its `Textarea` (with `Field`, `FieldLabel`, `FieldHint`
and `FieldError` for the label, hint and error wiring), every bordered panel its `Card`, every pop-up menu panel
its `PopoverPanel`, every dialog its `Dialog`, headings, text and links its `Heading`, `Text`, `Quote` and
`TextLink` (a text colour, size or weight class in page code fails lint), and buttons whose words may wrap are
`Button wrap`. Pages pass layout classes only (width,
margins, padding, grid placement); a copied field class string fails lint. The library also owns the theme
(`libs/web-ui/src/styles/theme.css`: colours light and dark, font, radii, widths) and these lint checks
(`@heisreal/web-ui/eslint`). Colours are named by meaning (`danger`, `warning`, `success`, `info`, `brand`,
`media`…); a hex, rgb() or Tailwind palette colour (`red-600`, `bg-white`) in page code fails lint.

**Styling order (Joel, 2026-11-21).** When building or changing UI:

1. Use the library's pieces and its colours (named by meaning) as they are.
2. If no piece quite fits, prefer adjusting the design to use a common existing piece, accepting a small
   compromise, over adding something new.
3. If no existing piece can do the job, add a new piece to `libs/web-ui` (never a page-local styled copy).
4. Only as a last resort, style in `apps/web` page code, and say why in the PR.

Pages otherwise pass layout only (width, spacing, placement).

Run tasks through Nx with the package manager prefix (`pnpm nx run-many -t lint test build typecheck`, `pnpm nx affected -t ...`). Check `pnpm nx <target> --help` rather than guessing flags. Scaffold with the Nx generators (`pnpm nx g ...`).

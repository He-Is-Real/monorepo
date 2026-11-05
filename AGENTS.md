# He Is Real Today monorepo

Nx + pnpm workspace on Node 24 LTS: Next.js (`apps/web`), NestJS on Express (`apps/api-*`,
`apps/workflow`), shared libs (`libs/*`), and SurrealDB Kubernetes manifests
(`infra/k8s/surrealdb`). Read `README.md` first; CLIs and accounts are in `docs/tooling-and-accounts.md`.

Two docs record where we are and how the site behaves. Read both before starting a task:

- `docs/delivery-status.md`: progress only (done, in progress, next, known issues, what blocks
  Go live), in plain English. Update it in the same PR when work starts or finishes.
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
- Nothing on GKE is reachable from the internet: private nodes only, and no `LoadBalancer` or
  `NodePort` Services and no Ingress/Gateway. Workers (Dapr workflow, inference workers) run
  off Google Cloud (Joel's machine, later church hardware) and connect outbound only, to Pub/Sub. Public entry points are Cloud Run services only.
- Testimonies are GDPR Article 9 data. New personal data must fit the consent and erasure model.
- **Responsive everywhere (Joel):** every page and view is mobile-first and works from 320 px phones through foldables, tablets (both orientations) and 1920 px+ desktops: no horizontal scroll, 44 px touch targets, readable line lengths, safe-area insets. Cover each new page in `apps/web/e2e` (device matrix in `devices.ts`).
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

Run tasks through Nx with the package manager prefix (`pnpm nx run-many -t lint test build typecheck`, `pnpm nx affected -t ...`). Check `pnpm nx <target> --help` rather than guessing flags. Scaffold with the Nx generators (`pnpm nx g ...`).

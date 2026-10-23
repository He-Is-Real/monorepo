# He Is Real Today monorepo

Nx + pnpm workspace on Node 24 LTS: Next.js (`apps/web`), NestJS on Express (`apps/api-*`,
`apps/workflow`), shared libs (`libs/*`), and SurrealDB Kubernetes manifests
(`infra/k8s/surrealdb`). Read `README.md` first.

`docs/delivery-status.md` tracks progress against the delivery plan (`project` repo) and the
decisions that override it. Read it before starting a task, and update it in the same PR when a
task finishes or a recorded decision changes.

API work follows `docs/api-conventions.md`; the OpenAPI specs in `libs/contracts/openapi` are the
source of truth, so change them in the same PR as the code.

- Services never call each other. Each API connects to SurrealDB as its own least-privilege user
  (api-public-read is read-only). Don't merge services or share DB users.
- Secrets come only from GCP Secret Manager: through `libs/secrets` (SDK, ADC) in our code, and
  through External Secrets Operator on clusters. Never commit secret values or add key files.
- Nothing on GKE is reachable from the internet: private nodes only, and no `LoadBalancer` or
  `NodePort` Services and no Ingress/Gateway. Workers (Dapr workflow, inference workers) connect
  outbound only, to Pub/Sub. Public entry points are Cloud Run services only.
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
- **Browse loads at most 2 extra pages automatically,** then shows a "Show more stories" button
  (D55). It's the only exception to the design principle "no infinite scroll".
- **All cloud deployments and modifications go through OpenTofu (`infra/terraform`; D54: never Terraform),
  including proofs of concept.** Run it with `tools/scripts/tf.sh <root> …` (locally it acts as the root's
  CI identity; `TF_SH_IDENTITY=self` uses yours). Never use console clicks, `gcloud … create/update`, or
  `kubectl apply` against GKE. Adopt anything made by hand with `import` blocks. Read-only commands are fine.
  Exceptions: the Clerk instance's settings (`infra/clerk/dev.json`, applied with
  `infra/clerk/clerk-config.mjs`, decision 17 in `docs/delivery-status.md`), and recovering a KMS key
  version (`infra/terraform/README.md`, "Break-glass").
- **Plans run on their own; every apply needs one approval.** An approval means "I read this plan and
  choose to apply it". It isn't access control, and approving your own run is expected. Claude may approve
  dev applies. Applies happen through the `dev` environment in `tofu-apply.yml` (it applies exactly the plan
  it saved) or a developer running `tf.sh <root> apply`. `bootstrap` is applied locally only.
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

Run tasks through Nx with the package manager prefix (`pnpm nx run-many -t lint test build typecheck`, `pnpm nx affected -t ...`). Check `pnpm nx <target> --help` rather than guessing flags. Scaffold with the Nx generators (`pnpm nx g ...`).

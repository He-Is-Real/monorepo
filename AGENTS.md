# He Is Real Today monorepo

Nx + pnpm workspace on Node 24 LTS: Next.js (`apps/web`), NestJS on Express (`apps/api-*`,
`apps/workflow`), shared libs (`libs/*`), and SurrealDB Kubernetes manifests
(`infra/k8s/surrealdb`). Read `README.md` first. The table at the end says what to read for each kind of work.

Before starting a task, read `docs/delivery-status.md` (progress) and the behaviour rules for the area you
touch. Update `docs/delivery-status.md` in the same PR when work starts or finishes, following its "How to
edit this file" section. The rules in this repository override the plan in the `project` repository.

## The owner decides database, API and behaviour changes

No agent (coding, reviewing or coordinating) decides these on its own:

- Database data structure: tables, fields, types, indexes, record ids, permissions, events and functions
  that change what is stored or who may read or write it, and migrations or data scripts that reshape or
  delete data.
- API: OpenAPI contracts, routes, request and response payloads, status and error codes.
- Behaviour: what users, moderators and admins see and can do, including legal texts, limits and what is
  public.

How it works:

- Build only changes the owner has approved (a decision doc or a direct answer). The PR body names that
  approval for each such change, and the same PR records the new or changed rule in the reference.
- If you need a change the owner has not approved (a new field, a changed route or payload, different
  user-visible behaviour), stop and report it as a question with a recommendation. Do not build it.
- Reviewer agents may block a merge or deployment and make suggestions, but a finding that would change
  any of these levels is labelled "Needs Joel" and goes to the owner, not to the coding agent as an
  instruction. An unapproved change at these levels is a blocking finding.
- Exempt: bug fixes that restore approved behaviour, tests, docs, and infrastructure that does not affect
  these levels. Say so in the PR.

## Rules everywhere

- Services never call each other. Each API connects to SurrealDB as its own least-privilege user
  (api-public-read is read-only). Do not merge services or share DB users.
- Secrets come only from GCP Secret Manager: through `libs/secrets` (SDK, ADC) in our code, and through
  External Secrets Operator on clusters. Never commit secret values or add key files.
- `.env` files are committed. They hold config only: plain settings, and a secret's Secret Manager _name_
  where code needs one (e.g. `SURREAL_PASSWORD_SECRET=…`), never its value, so every env file is safe to
  publish. gitleaks (pre-commit hook and CI) scans them.
- Commit only source, config, env files and lock files; never build output, caches, test reports,
  OpenTofu state or plans, or logs.
  - A PR that adds a tool or target that writes files adds its `.gitignore` entry in the same PR.
  - If `git status` shows a generated file as untracked, fix `.gitignore`; do not leave it or commit it.
  - When deleting or renaming a project, also delete its old local folder (`dist`, `out-tsc`,
    `node_modules` stay behind as ignored files): `git clean -ndX apps/<old>` to preview, then `-fdX`.
- Nothing on GKE is reachable from the internet: private nodes only, and no `LoadBalancer` or `NodePort`
  Services and no Ingress/Gateway. Workers (Dapr workflow, inference workers) run off Google Cloud and
  connect outbound only, to Pub/Sub. Public entry points are Cloud Run services only.
- Testimonies are GDPR Article 9 data. New personal data must fit the consent and erasure model.
- Every page is mobile-first and works from 320 px phones to 1920 px+ desktops; the rule and its tests
  are in `apps/web/AGENTS.md`.
- Every cloud change goes through OpenTofu (`tools/scripts/tf.sh`), with two named exceptions. Read
  `infra/terraform/AGENTS.md` before any cloud or OpenTofu work.
- CI logs are public (public repo): never print secrets. Workflows start from `permissions: {}`; never
  use `pull_request_target`. Install the secret-scanning hook once per clone:
  `mise install && tools/scripts/install-hooks.sh`.
- Read the `writing-logs` skill before adding or changing logging, error handling, request handlers,
  jobs or workers. Its rules are must-follow; ask the owner about anything it does not cover.
- The cloud budget is £15/month with alert emails at £3, £7.50 and £15 (no automatic stop). Never
  unlink billing; storage is always kept.

## Tests

- Tests check the system's behaviour. A bad test costs more than a failure that a behaviour test catches
  and we fix.
- Test at the highest level that can see the behaviour: Playwright in `apps/web/e2e` across the device
  matrix; the dev behavioural suite (`apps/dev-seed/behavioural`); integration tests against a real
  SurrealDB where the database is the behaviour (permissions, consent, publishing).
- Write a unit test only when something is hard to test from above or the logic is complex enough to need
  its own coverage. Backend changes reach the behaviour tests above them through the Nx `affected` graph.
- Do not test an API route that no finished frontend feature uses yet.
- Tests give the same result locally and in CI: no dependence on timing, machine load, ports or shared
  state.
- Remove a flaky test, or one that stubs away the behaviour it claims to check, or rebuild it at the right
  level. Deleting low-value tests is welcome. TDD happens at the behaviour level, where that behaviour is
  defined.
- Performance and scale tests run only on a developer's machine against a throwaway local SurrealDB in
  Docker: never in CI, GCP or Bunny (budget). They live under `scale/*.scale-spec.ts` with their own
  Vitest config and Nx `scale-test` target (`pnpm nx run api-public-read:scale-test`); do not wire them
  into CI.

## Working in the workspace

Nest 12 packages are ESM only; the services and their libs stay CommonJS TypeScript (no
`"type": "module"`, extensionless relative imports, `__dirname`), bundled by webpack, and Node 24 loads
Nest through `require(esm)`. So a dependency used by a service must not contain top-level `await`
(`ERR_REQUIRE_ASYNC_MODULE`), and service code cannot use `import.meta`. Tests in the Nest apps and libs
use Vitest (`vitest.config.mts`; `vi.fn()`, globals on); the real-SurrealDB suites use
`vitest.integration.config.mts` with libs/database's global setup. `apps/web` uses Jest.

Run tasks through Nx with the package manager prefix (`pnpm nx run-many -t lint test build typecheck`,
`pnpm nx affected -t ...`). Check `pnpm nx <target> --help` rather than guessing flags. Scaffold with the
Nx generators (`pnpm nx g ...`).

## Where to read

| Working on                                  | Read                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Progress                                    | `docs/delivery-status.md`                                                                                  |
| Behaviour rules                             | `docs/product/behaviour/<area>.md`; areas not moved there yet are in `docs/how-the-app-works.md`           |
| Direction (technical choices for all code)  | `docs/system/direction.md`; until it exists, "Technical decisions" in `docs/how-the-app-works.md`          |
| Decisions and their ids                     | `docs/decisions/register.md`                                                                               |
| Any rule, opinion or term under `docs/`     | the `writing-the-reference` skill; then `pnpm docs:check`                                                  |
| Any text an agent reads                     | the `writing-for-agents` skill (AGENTS.md, skills, briefs, code comments, PR bodies, reports)              |
| Questions for the owner, answers to theirs  | the `writing-a-decision-doc` skill                                                                         |
| Logging, errors, handlers, jobs, workers    | the `writing-logs` skill                                                                                   |
| OpenTofu, any cloud change                  | `infra/terraform/AGENTS.md`, then `infra/terraform/README.md`                                              |
| The website and `libs/web-ui`               | `apps/web/AGENTS.md`; `libs/web-ui/README.md`                                                              |
| Database schema, queries, SurrealDB traps   | `libs/database/SURREALDB-NOTES.md`; `docs/db-permissions.md`                                               |
| API contracts                               | `libs/contracts/README.md` (specs are the source of truth, changed with the code); `docs/api-conventions.md` |
| Tests                                       | "Tests" above; the device matrix in `apps/web/e2e/devices.ts`                                              |
| CLIs, accounts, local set-up                | `docs/tooling-and-accounts.md`                                                                             |
| Reading logs, dashboards                    | `docs/runbooks/logs.md`                                                                                    |
| Media worker, Bunny, media ready            | `docs/runbooks/media.md`                                                                                   |
| Database restore and restore drill          | `docs/runbooks/restore.md`                                                                                 |

Skills live in `.agents/skills/<name>/SKILL.md`.

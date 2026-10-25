# He Is Real Today — monorepo

Platform monorepo for [heisreal.today](https://www.heisreal.today/): an Nx workspace holding the
Next.js site, the NestJS services and the SurrealDB Kubernetes configuration.

Architecture and decisions live in the separate `project` repository (`context/future/architecture/`),
notably `service-topology.md`, `stack-decisions.md` and `gdpr-consent.md`. Progress against the
plan, and the decisions that override it, are in [docs/delivery-status.md](docs/delivery-status.md).
The API contracts are in [`libs/contracts`](libs/contracts), and the rules they follow (CQRS-lite,
commands vs CRUD, errors, versioning, concurrency, consent guards) in
[docs/api-conventions.md](docs/api-conventions.md).

## Layout

| Path                   | What                                           | Notes                                                                    |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/web`             | Next.js (App Router) site                      | Tailwind v4 + shadcn/ui; reads api-public-read only (D32)                |
| `apps/api-public-read` | Anonymous public read API (NestJS/Express)     | DB user `api_read` (until the schema PR), **VIEWER** (read-only)         |
| `apps/api-user`        | The signed-in person's reads and commands      | DB user `api_write` (until the schema PR), EDITOR                        |
| `apps/api-admin`       | Moderation/admin API (restricted hostname)     | DB user `api_admin`, EDITOR                                              |
| `apps/workflow`        | Dapr worker, off Google Cloud (D78)            | Pulls from Pub/Sub, outbound only; no DB access (see below)              |
| `apps/dev-seed`        | Dev-only Job: resets dev to dummy data (D49)   | System user `dev_seed` (dev only); [README](apps/dev-seed/README.md)     |
| `libs/secrets`         | Reads GCP Secret Manager via the SDK           | Fetched once at startup; missing secret = clear failure                  |
| `libs/database`        | SurrealDB client (surrealdb.js)                | Own user per service; startup fails after 15 s if DB is down             |
| `libs/health`          | `GET /health` → `{ status, service, db }`      | 503 when the DB is down; `/testing` boots an app in tests                |
| `libs/consent`         | Consent ledger, fail-closed consent guard      | D17–D21; `/v1/account/consents` for api-user; `/testing` lists routes    |
| `libs/auth`            | Clerk sign-in for api-user and api-admin       | Networkless JWT check, `user` row on first use, role guard; `/testing`   |
| `libs/http`            | CORS allowlist and RFC 9457 problem responses  | `CORS_ALLOWED_ORIGINS` (D31); `ProblemFilter` (D30)                      |
| `libs/roles`           | The role set and role decorators (D1)          | `@RequiresRole` / `@NoRoleRequired` on every api-user/api-admin route    |
| `libs/contracts`       | OpenAPI 3.1 specs, the API source of truth     | `pnpm nx run contracts:lint-openapi`; [README](libs/contracts/README.md) |
| `infra/k8s/surrealdb`  | SurrealDB on Kubernetes (Kustomize)            | [README](infra/k8s/surrealdb/README.md)                                  |
| `infra/terraform`      | All cloud infrastructure (GCP, GKE, Cloud Run) | [README](infra/terraform/README.md)                                      |
| `infra/clerk`          | Clerk instance settings as code (Clerk CLI)    | [README](infra/clerk/README.md); the non-OpenTofu cloud config           |
| `tools/docker`         | Dockerfiles: NestJS services, Next.js site     | `pnpm nx run <service>:container` (also `web`)                           |

Services never call each other; each API only talks to SurrealDB (and, later, queues).

**Background work (D78: Dapr off Google Cloud).** The Dapr workers in `apps/workflow` run off
Google Cloud, on Joel's machine and later on church hardware, never on GKE. They pull work from
Pub/Sub and connect outbound only, so they can't reach the database. Their results go back through
a results topic to a private Cloud Run result writer, which writes them to SurrealDB. The result
writer is to be built in M2; whether it's its own app or part of `apps/workflow` is decided then.

## Getting started

Every CLI and account you need, and a new-developer checklist, are in
[docs/tooling-and-accounts.md](docs/tooling-and-accounts.md).

Needs **Node.js 24 LTS** (`.nvmrc`), **pnpm 11** (`packageManager`), and **gcloud** logged in with
`gcloud auth application-default login` (plus `gcloud auth login`, same account, for the local
`images` OpenTofu root). `kubectl` and kubeconform (`mise install`, pinned in
`mise.toml`) only for the database manifests.

```bash
pnpm install
pnpm nx dev web                   # http://localhost:3000
cp apps/api-public-read/.env.example apps/api-public-read/.env   # GCP_PROJECT=heisreal-dev
pnpm nx serve api-public-read            # http://localhost:3001/health (needs a local SurrealDB)

pnpm nx run-many -t lint test build typecheck   # everything
pnpm nx affected -t lint test build typecheck   # only what your branch changed
pnpm nx validate surrealdb-k8s                   # render the Kubernetes manifests
pnpm nx run database:test-integration            # schema + permission tests on SurrealDB (needs Docker)
pnpm nx run consent:test-integration             # consent ledger + endpoints on SurrealDB (needs Docker)
pnpm nx run auth:test-integration                # Clerk sign-in → person session on SurrealDB (needs Docker)
pnpm nx run api-public-read:test-integration     # the public read API over the dev dataset on SurrealDB (needs Docker)
pnpm nx run api-user:test-integration            # api-user's account bootstrap on SurrealDB (needs Docker)
pnpm exec playwright install chromium && pnpm nx e2e web   # responsive device matrix, light + dark
# Ports 4300–4303 (web: dev, Go live, API down, signed in) and 4310–4313 (stub APIs); if one
# is busy, move them all: E2E_PORT_BASE=4400 pnpm nx e2e web. No internet needed: the real
# Clerk is checked on dev (dev-seed:behavioural).
pnpm nx run terraform:test                        # `tofu test` of every OpenTofu module (offline, mock providers)
```

## Secrets

**Google Cloud Secret Manager is the only place secrets live** — not git, `.env` files, CI
settings or OpenTofu state. Config holds only a secret's _name_ (e.g.
`SURREAL_PASSWORD_SECRET=surreal-api-read-password`). Authentication is keyless everywhere
(Application Default Credentials: your gcloud login, the Cloud Run service account, Workload
Identity on GKE and in GitHub Actions); never create key files. Programs we don't write (SurrealDB
and its Jobs) get secrets from External Secrets Operator, or `local-secrets.mjs` on local developer machines.

## Cloud and CI

All cloud changes go through OpenTofu (D54, run with `tools/scripts/tf.sh`); see [infra/terraform/README.md](infra/terraform/README.md).
Dev runs in GCP project `heisreal-dev` (London): `api-public-read` and `web` (public since 0.9) and
`api-user` and `api-admin` (since M2's start; a Clerk token on every route but `/health`) on Cloud
Run (scale to zero, max 2 instances each; https://web-jbxp6odnsa-nw.a.run.app, not indexed) and SurrealDB on
GKE Autopilot Spot Pods, about £3–5/month.

- **`ci.yml`** (every PR, the required check): format check, then `lint test build typecheck validate`
  (`test` includes `terraform:test`, the OpenTofu modules' `tofu test`), `test-integration`
  (`libs/database`, `libs/consent`, `libs/auth`, `api-public-read` and `api-user` against a SurrealDB container, see
  [docs/db-permissions.md](docs/db-permissions.md)) and container builds for affected projects (`validate`
  includes kubeconform on the Kubernetes manifests). Beside those, when web is affected, the
  Playwright device matrix runs in parallel shards from one build of the site (each shard runs like
  a local `web:e2e`: 4 workers, no retries); screenshots land in one `web-e2e-screenshots` artifact,
  and a failure adds one merged `web-e2e-report` (HTML, with traces). The required check is the
  `main` job, which passes only when all of these do. The Nx cache, the pnpm store and Playwright's
  browser are kept between runs in the Actions cache. Both api-public-read's integration tests and web's e2e stub are checked against
  `libs/contracts/openapi/api-public-read.yaml`, and api-user's integration tests and the stub's api-user half against
  `api-user.yaml`, so the stubs can't drift from the APIs.
- **`images.yml`** ("Release Images", pushes to `main` that affect a service) and
  **`snapshot-images.yml`** (manual, any branch): build the services whose code changed and push
  them to `apps` / `apps-scratch`. Which build each
  environment runs is committed in `infra/terraform/live/<env>/gcp/images.auto.tfvars`.
- **`tofu-plan.yml`**: automatic, read-only OpenTofu plans of the roots a PR touches (never bunny).
- **`tofu-apply.yml`**: the only CI path that changes the cloud. Every push to `main` (and every
  Release Images run) plans every root unattended; each apply waits for one approval in the `dev`
  environment, then applies exactly the saved plan. Dispatch it to recover from anything. After a
  successful apply it dispatches **`dev-behavioural-tests.yml`** (reset dev, then test the real site,
  API and Bunny together).
- **`tofu-drift.yml`**: weekly full-refresh plans; fails on drift.
- **`reset-dev-data.yml`** and **`dev-behavioural-tests.yml`** (manual, `main`; D50): reset dev to
  the dummy dataset with the `dev-seed` Job, then (tests) check the dev URLs against it
  ([apps/dev-seed](apps/dev-seed/README.md)).

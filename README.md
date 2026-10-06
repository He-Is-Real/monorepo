# He Is Real Today — monorepo

Platform monorepo for [heisreal.today](https://www.heisreal.today/): an Nx workspace holding the
Next.js site, the NestJS services and the SurrealDB Kubernetes configuration.

Architecture and decisions live in the separate `project` repository (`context/future/architecture/`),
notably `service-topology.md`, `stack-decisions.md` and `gdpr-consent.md`.

## Layout

| Path                  | What                                           | Notes                                                        |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `apps/web`            | Next.js (App Router) site                      | Tailwind + shadcn/ui arrive in M0 task 0.4                   |
| `apps/api-read`       | Public read API (NestJS/Express)               | DB user `api_read`, **VIEWER** (read-only)                   |
| `apps/api-write`      | Authenticated write API                        | DB user `api_write`, EDITOR                                  |
| `apps/api-admin`      | Moderation/admin API (restricted hostname)     | DB user `api_admin`, EDITOR                                  |
| `apps/workflow`       | Dapr Workflow orchestrator (M7, GKE)           | DB user `workflow`, EDITOR                                   |
| `libs/secrets`        | Reads GCP Secret Manager via the SDK           | Fetched once at startup; missing secret = clear failure      |
| `libs/database`       | SurrealDB client (surrealdb.js)                | Own user per service; startup fails after 15 s if DB is down |
| `libs/health`         | `GET /health` → `{ status, service, db }`      | 503 when the DB is down; `/testing` boots an app in tests    |
| `infra/k8s/surrealdb` | SurrealDB on Kubernetes (Kustomize)            | [README](infra/k8s/surrealdb/README.md)                      |
| `infra/terraform`     | All cloud infrastructure (GCP, GKE, Cloud Run) | [README](infra/terraform/README.md)                          |
| `tools/docker`        | Shared Dockerfile for the NestJS services      | `pnpm nx run <service>:container`                            |

Services never call each other; each API only talks to SurrealDB (and, later, queues).

## Getting started

Needs **Node.js 24 LTS** (`.nvmrc`), **pnpm 11** (`packageManager`), and **gcloud** logged in with
`gcloud auth application-default login` (plus `gcloud auth login`, same account, for the local
`images` Terraform root). `kubectl` and kubeconform (`mise install`, pinned in
`mise.toml`) only for the database manifests.

```bash
pnpm install
pnpm nx dev web                   # http://localhost:3000
cp apps/api-read/.env.example apps/api-read/.env   # GCP_PROJECT=heisreal-dev
pnpm nx serve api-read            # http://localhost:3001/health (needs a local SurrealDB)

pnpm nx run-many -t lint test build typecheck   # everything
pnpm nx affected -t lint test build typecheck   # only what your branch changed
pnpm nx validate surrealdb-k8s                   # render the Kubernetes manifests
```

## Secrets

**Google Cloud Secret Manager is the only place secrets live** — not git, `.env` files, CI
settings or Terraform state. Config holds only a secret's _name_ (e.g.
`SURREAL_PASSWORD_SECRET=surreal-api-read-password`). Authentication is keyless everywhere
(Application Default Credentials: your gcloud login, the Cloud Run service account, Workload
Identity on GKE and in GitHub Actions); never create key files. Programs we don't write (SurrealDB
and its Jobs) get secrets from External Secrets Operator, or `local-secrets.mjs` on local developer machines.

## Cloud and CI

All cloud changes go through Terraform; see [infra/terraform/README.md](infra/terraform/README.md).
Dev runs in GCP project `heisreal-dev` (London): `api-read` on Cloud Run (private, scales to zero,
max 2 instances) and SurrealDB on GKE Autopilot Spot Pods, about £3–5/month.

- **`ci.yml`** (every PR): format check, then `lint test build typecheck validate` and container
  builds for affected projects (`validate` includes kubeconform on the Kubernetes manifests). The Nx
  cache is kept between runs in the Actions cache.
- **`images.yml`** ("Release Images", pushes to `main` that affect a service) and
  **`snapshot-images.yml`** (manual, any branch): build the services whose code changed and push
  them to `apps` / `apps-scratch`. Which build each
  environment runs is committed in `infra/terraform/live/<env>/gcp/images.auto.tfvars`.
- **`terraform-plan.yml`**: automatic, read-only plans.
- **`terraform-apply.yml`**: the only CI path that changes the cloud. Manual, on `main`; shows the
  plan, then applies it once you approve.

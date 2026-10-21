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
- **All cloud deployments and modifications go through Terraform (`infra/terraform`), including
  proofs of concept.** Never use console clicks, `gcloud … create/update`, or `kubectl apply` against
  GKE. Adopt anything made by hand with `import` blocks. Read-only commands are fine. Never
  auto-apply: plans may run automatically, applies are manual (local developer machine or `terraform-apply.yml`).
  Solo project: gates mean "deliberate", never "needs a second person".
- Terraform state must never hold secrets: write-only attributes for values, `ephemeral` for tokens.
  One approved exception (Joel, 2026-10-21): the `bunny` root's state holds the Bunny provider's
  computed keys (`bunnynet_stream_library.api_key`/`api_key_readonly`,
  `bunnynet_storage_zone.password`/`password_readonly`, `bunnynet_pullzone.token_auth_key`), which
  have no write-only alternative. It's acceptable only because that prefix (`dev/bunny/`) is
  readable by developers, and by Google-managed service agents acting for their own services. No
  CI identity can read it, `tf-deployer` can't change the state bucket's or any `bunny-*` secret's
  IAM, and the bunny root checks this before every plan. CI never plans or applies it, nothing
  reads it via `terraform_remote_state` and plans are never saved (`infra/terraform/README.md`,
  "Bunny.net"). Don't extend it to other resources or roots.
- Budget guardrail: £15/month budget with alert emails at £3/£7.50/£15 (no automatic stop). Never
  unlink billing; storage is always kept.

## Working in the workspace

Run tasks through Nx with the package manager prefix (`pnpm nx run-many -t lint test build typecheck`, `pnpm nx affected -t ...`). Check `pnpm nx <target> --help` rather than guessing flags. Scaffold with the Nx generators (`pnpm nx g ...`).

# He Is Real Today monorepo

Nx + pnpm workspace on Node 24 LTS: Next.js (`apps/web`), NestJS on Express (`apps/api-*`,
`apps/workflow`), shared libs (`libs/*`), and SurrealDB Kubernetes manifests
(`infra/k8s/surrealdb`). Read `README.md` first.

`docs/delivery-status.md` tracks progress against the delivery plan (`project` repo) and the
decisions that override it. Read it before starting a task, and update it in the same PR when a
task finishes or a recorded decision changes.

- Services never call each other. Each API connects to SurrealDB as its own least-privilege user
  (api-read is read-only). Don't merge services or share DB users.
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
- Budget guardrail: £10/month budget with alert emails at £2/£5/£10 (no automatic stop). Never
  unlink billing; storage is always kept.

## Working in the workspace

Run tasks through Nx with the package manager prefix (`pnpm nx run-many -t lint test build typecheck`, `pnpm nx affected -t ...`). Check `pnpm nx <target> --help` rather than guessing flags. Scaffold with the Nx generators (`pnpm nx g ...`).

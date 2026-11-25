# Infrastructure

Who: the cloud, the cluster and the people who change them. Data: `infra/terraform/README.md`.
Next id: REQ-INF-016

## OpenTofu

- **REQ-INF-001** Every cloud change goes through OpenTofu (`infra/terraform`), never Terraform. [D54]
- **REQ-INF-002** OpenTofu state and saved plans are encrypted. [D57]
- **REQ-INF-003** Every apply needs one approval. [D57]
- **REQ-INF-004** A dev plan whose every change moves a Cloud Run service or job to a new image from our own repository applies without an approval. [D120]
- **REQ-INF-005** Clerk's settings are code (`infra/clerk/dev.json`), applied with the Clerk CLI: the one exception to every change going through OpenTofu (`infra/clerk/README.md`). [DEC-17]
- **REQ-INF-006** Dashboards are made in OpenTofu only. [J-2026-11-08-INF]

## Network

- **REQ-INF-007** Nothing on GKE is reachable from the internet; the public entry points are Cloud Run services only. [D4]
- **REQ-INF-008** There is no load balancer in front of Cloud Run. [D3]

## Database

- **REQ-INF-009** The database is self-hosted SurrealDB on private GKE, a single node in production too, with nightly backups (`infra/k8s/surrealdb/README.md`). [D9]
- **REQ-INF-010** Schema changes run as a migration Job, from one schema file per area. [D14]
- **REQ-INF-011** Before production, dev's database can be wiped and rebuilt through the migration Job instead of migrating its test data, by a one-off switch in OpenTofu's dev settings that nothing else can use. [J-2026-11-05-INF]
- **REQ-INF-012** The database runs on Spot nodes in dev and production, and so do the cluster's helpers (External Secrets, the backup Job). [J-2026-11-07-INF]
- **REQ-INF-013** The database runs SurrealDB v3.2.4 built with the upstream fix that accepts Clerk's tokens, until an official release has the fix. [D111]

## Budget and dependencies

- **REQ-INF-014** The monthly cloud budget is £15, with alert emails at £3, £7.50 and £15 and no automatic stop. [DEC-10]
- **REQ-INF-015** Dependencies update through Renovate. [D106]

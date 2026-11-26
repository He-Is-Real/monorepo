# infra/terraform (OpenTofu)

Rules for every cloud change. The root `AGENTS.md` still applies. How the roots are laid out and run is
in `README.md` beside this file.

## Every cloud change goes through OpenTofu

- All cloud deployments and modifications, proofs of concept included, go through OpenTofu in
  `infra/terraform` (never Terraform). Run it with `tools/scripts/tf.sh <root> …`; locally it acts as the
  root's CI identity, and `TF_SH_IDENTITY=self` uses yours.
- Never change the cloud by console clicks, `gcloud … create/update`, or `kubectl apply` against GKE.
  Adopt anything made by hand with `import` blocks. Read-only commands are fine.
- Two exceptions: the Clerk instance's settings (`infra/clerk/dev.json`, applied with
  `infra/clerk/clerk-config.mjs`), and recovering a KMS key version (`README.md`, "Break-glass").

## Plans and applies

- Any agent may run `tools/scripts/tf.sh <root> plan` (and `plan-summary`, `location-check`) locally
  without asking the owner. A plan changes no cloud resource; it only takes the state lock while it runs
  and writes a plan file.
- Plans run on their own, and dev applies run on their own after merge. Dev applies happen through
  `tofu-apply.yml` (it applies exactly the plan it saved, signing in only as `heisreal-dev` identities) or
  a developer running `tf.sh <root> apply`; read the plan first. `bootstrap` is applied locally only.
- An apply to production needs one manual approval. Outside dev, `tf-deployer` and `tf-bunny` reach
  `tofu-apply.yml` only in the `production` GitHub environment
  (`modules/bootstrap/production_approval.cel.tftpl`), which must require a reviewer. Never weaken that
  gate or the `cluster-plan` one; the `cluster-plan` gate keeps pull-request code from cloud credentials
  until someone approves it.

## State and secrets

- State and saved plans are encrypted with Cloud KMS (`tofu-state`; `tofu-bunny` for bunny). Never
  disable or destroy those keys or their versions, and never revert bootstrap wholesale.
- State never holds secrets: write-only attributes for values, `ephemeral` for tokens. One approved
  exception: the `bunny` root's state holds the Bunny provider's computed keys. Only developers and
  `tf-bunny` can read or decrypt it; CI gets `tf-bunny` only on `main` (`tofu-apply.yml`,
  `tofu-drift.yml`), never in PRs; and the root refuses to plan if anything Bunny is public. Do not extend
  the exception to other resources or roots.

## Public CI logs

- Bunny jobs mask the Bunny keys and publish only `tf.sh … plan-summary`; raw output goes to
  `gs://heisreal-dev-tfstate/dev/bunny/logs/`.
- Never set `TF_LOG` or step debug for tofu (`tf.sh` refuses), because the logs are public.

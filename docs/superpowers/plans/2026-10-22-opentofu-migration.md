# OpenTofu Migration (D54 B, D57 C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every OpenTofu root runs the same way from a developer's machine and from GitHub Actions, on OpenTofu 1.13.2. State and saved plans are encrypted with Cloud KMS. A merge to `main` is planned without anyone waiting, then each apply waits for one approval and applies exactly the saved plan. Terraform is gone from the repo.

**Architecture:**
- **One entry script.** `tools/scripts/tf.sh <root> <tofu args>` is used by CI and locally. Locally it acts as the root's CI identity by default.
- **bootstrap stays local-only.** It owns the CI identities, including the new `tf-bunny`, and a KMS keyring with two keys: `tofu-state` (bootstrap, gcp, images, cluster) and `tofu-bunny` (bunny).
- **A separate key holder for Bunny, no fence (D57 C).** Only `tf-bunny` and developers can use `tofu-bunny`, the `bunny-*` secrets and `dev/bunny/` state. CI can get `tf-bunny` only on `main`, in `tofu-apply.yml` or `tofu-drift.yml`. `tf-deployer` simply gets no grants there. It could grant itself access through its service-account roles; that is accepted.
- **A "never public" guard** runs before every bunny plan. It fails if `allUsers` or `allAuthenticatedUsers` holds any role on the state bucket, a `bunny-*` secret, the keyring or either key.
- **Encryption in two steps.** Every root gets an `encryption.tf` with an `unencrypted` fallback. The fallback is removed once every state is encrypted.
- **Three workflows replace `terraform-*.yml`.** `tofu-plan.yml` (PRs, read-only), `tofu-apply.yml` (any push to main, a finished image release, or dispatch → plan every root that is behind `main` → one approval per apply → apply the saved plan) and `tofu-drift.yml` (weekly).
- **Correct by construction, no retirement logic.** Each apply run targets the `main` HEAD it sees at its start. Per-root "last applied commit" markers decide what is behind, so any later run picks up whatever an earlier run didn't apply. An apply refuses itself if `main` has moved on since its run started (the newer run plans again). There is no workflow-level concurrency group, so an old run waiting for approval never blocks a newer one; state locks and OpenTofu's stale-plan check keep applies safe.

**Tech Stack:**
- OpenTofu 1.13.2, set up with `opentofu/setup-opentofu` v2.0.2.
- GCS backend; Cloud KMS through the `gcp_kms` key provider with `aes_gcm`.
- Providers: hashicorp/google 8.5.0 (8.7.0 in bunny), BunnyWay/bunnynet 0.19.2, kbst/kustomization 0.9.8 (unsigned in the OpenTofu registry, pinned by lock-file hashes).
- GitHub Actions with Workload Identity Federation.
- gitleaks 8.30.1 (CI and a local pre-commit hook).
- bash, plus `node --test` with `@marcbachmann/cel-js` and `yaml` (both already dependencies).

**Spec:**
- D54: `/home/joel/Documents/GitHub/HeIsReal/project/context/research/m1-dev-data-decisions.html` (founder box "Decided: B", 2026-10-22).
- D57: `/home/joel/Documents/GitHub/HeIsReal/project/context/research/opentofu-access-model-decision.html` ("Decided: C", 2026-10-22).
- Repo rules: `AGENTS.md`, `infra/terraform/README.md`.

## Decisions applied (founder, 2026-10-22)

| Decision | What it means for this plan |
| --- | --- |
| **D57 = C: separate key holder, no fence** | Keep `tf-bunny` and the `tofu-bunny` key. tf-bunny's sign-in gate allows only `refs/heads/main` and `tofu-apply.yml` / `tofu-drift.yml`. PRs never plan bunny. Developers can impersonate tf-bunny, so `tf.sh bunny plan|apply` works locally from any branch. |
| **Dropped with A** | Moving the 5 app SAs to bootstrap, the `removed {}` blocks in gcp, per-SA deployer grants, removing the deployer's project-level SA roles, the `org` root and org-admin login, the impersonator guard, the transitional bunny guard, `--stage=l1\|final`, and the "tf-deployer has no route to Bunny" probes. |
| **Never-public guard** | Replaces the fence guard. Org-level checks live only in the local `check-bunny-fences.sh`. tf-bunny needs no org permission. |
| **Approval = read the plan, then apply** | It isn't access control. Plans run unattended (bunny too, on `main`, as tf-bunny). Every apply needs exactly one approval in the `dev` environment. Claude may approve dev applies. Bunny uses the same single approval and has no gate before its plan. Bunny joins the weekly drift check. bootstrap stays local-only. |
| **Logs stay public** | The repo stays public and on GitHub Actions. No private logs, private repo or Cloud Build. Kept: redacted Bunny summaries (raw output goes to the private bucket), refusing `TF_LOG` and step debug, no Bunny plans as artifacts. Added: masking the Bunny keys in Bunny jobs, `permissions: {}` in every workflow plus a CI check (also bans `pull_request_target`), gitleaks in CI and as a pre-commit hook, root `.gitignore` additions. |
| **Not doing** | Narrow per-job Bunny keys, a key-rotation runbook, shorter raw-log retention, a soft-delete guard. |
| **Break-glass** | The only change allowed outside OpenTofu is recovering a KMS key version with `gcloud` (runbook below). Clerk config stays the other standing exception. |

## Global Constraints

**OpenTofu, names and paths**
- OpenTofu **1.13.2** everywhere. Pin it in three places: `mise.toml` (`opentofu = "1.13.2"`), `opentofu/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4 # v2.0.2` with `tofu_version: 1.13.2`, and `tf.sh`'s version check.
- When finished, no `terraform` binary, no `hashicorp/setup-terraform`, and no `registry.terraform.io` lock entries remain.
- HCL constructs keep their names: `terraform {}`, `terraform_remote_state`, `terraform_data`, `*.tftest.hcl`, `.terraform.lock.hcl` and `.terraform/`.
- The directory stays `infra/terraform`.
- State stays in `gs://heisreal-dev-tfstate` (europe-west2, versioned, 30-day noncurrent lifecycle, 7-day soft delete), under `dev/<root>`.

**KMS keys**
- Encryption uses `key_provider "gcp_kms"` with `key_length = 32` and `method "aes_gcm"`.
- One keyring, `tofu`, in `europe-west2`, with two keys:
  - `tofu-state`: bootstrap, gcp, images and cluster. Users: developers, tf-deployer, tf-planner, tf-cluster-planner.
  - `tofu-bunny`: bunny. Users: developers, tf-bunny.
- Every principal that reads encrypted state needs `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key, because OpenTofu calls `Encrypt` on every run (S5).
- Both keys: yearly rotation (`31536000s`), `destroy_scheduled_duration = "10368000s"` (120 days, the maximum), SOFTWARE protection. About $0.06/month per active version.
- **Never disable or destroy any key version.** Rotation doesn't re-encrypt old states, plans or object generations, so every version must stay enabled.
- Keyring, keys and key IAM policies carry `lifecycle { prevent_destroy = true; destroy = false }`. OpenTofu stores `destroy = false` as `skip_destroy`, so removing the block later makes OpenTofu forget the resource instead of destroying it.
- `roles/owner` includes KMS encrypt, decrypt, disable and destroy (checked 2026-10-22). Developers are owners, so they can always decrypt, and they must follow the "never disable or destroy" rule by hand.
- After Task 9 has started, never revert bootstrap wholesale.

**Approvals and identities**
- Never auto-apply. Plans may run unattended. An apply happens only after one approval in the `dev` environment, or when a developer deliberately runs `tf.sh <root> apply`.
- One approval per apply. A merge that changes gcp and cluster asks twice, because cluster is planned only after gcp is applied.
- `bootstrap` is local-only. CI plans it read-only (weekly drift as tf-planner) and never applies it.
- `tf-bunny` covers the bunny root only: `dev/bunny/` state, the `bunny-*` secrets and `tofu-bunny`. CI can use it only on `main`, in `tofu-apply.yml` or `tofu-drift.yml`.
- `tf-deployer` gets no grants on `tofu-bunny`, the `bunny-*` secrets or `dev/bunny/`. Its existing conditions (`not-bunny-secrets`, `not-state-bucket`, `!dev/bunny/`) stay as they are.

**Public logs and git hygiene**
- The repo is **public**, so Actions logs, step summaries and artifacts are world-readable.
- Bunny plan and apply output never goes to the public log. Only `tf.sh … plan-summary` output (addresses, actions, counts) and an error class do.
- Bunny jobs mask the Bunny keys (`::add-mask::`) before they plan or apply. It's a backstop: masking misses encoded or split values.
- `tf.sh` refuses `TF_LOG*` and GitHub step debug (`RUNNER_DEBUG=1`), and always unsets `TF_ENCRYPTION` (S8).
- No Bunny plan is ever uploaded as a GitHub artifact.
- Every workflow starts with `permissions: {}`. Each job asks for only what it needs. `pull_request_target` is banned. Both are checked in CI.
- Fork PRs already need approval before any workflow runs (`all_external_contributors`, read 2026-10-22). No change.
- GitHub secret scanning and push protection are already on. Generic-pattern scanning isn't on the Free plan, so gitleaks covers Bunny keys.

**Process**
- Pin third-party actions by SHA. The repo Actions allowlist is set by hand with `gh api -X PUT repos/He-Is-Real/monorepo/actions/permissions/selected-actions`.
- Sign commits (`git commit -S`), use conventional messages, and end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: `feat/opentofu` (PR 1), then `feat/opentofu-pipeline` (PR 2).
- Steps marked **[LIVE]** change dev infrastructure or GitHub settings. Don't run them out of order. All other steps are code-only or read-only.
- Solo project: approving your own run is expected.
- Budget guardrail: £15/month.

## Review Focus

1. **Bunny secrets in public CI output.** This covers sensitive attributes and provider error text, which redaction doesn't cover. CI writes only addresses, actions, counts and an exit class publicly. Pinned in Task 2 (`plan-summary`, `bunny-mask` tests) and Task 10 (bunny jobs never print raw output).
2. **Bunny keys only on `main`.** tf-bunny's gate is tested with claim fixtures (Task 5). PRs never plan bunny (Task 10). The never-public guard is tested offline (Task 6).
3. **Failed, rejected, stale or superseded stages, and lost roots.** Any of these upstream stops every later stage. "Not selected" and "no changes" stop nothing. A root that isn't applied stays pending until a later run applies it, whatever triggered that run. A run never plans one commit and applies over a newer one. Pinned in Task 10 (`tf-roots.sh pending` and `tf-stage.sh` tests, and the dry run).
4. **Wrong credentials picked up by `tf.sh`.** Defaults: the root's CI identity locally, ambient credentials in CI, your own with `self`, never impersonation for `bootstrap`. Pinned in Task 2.
5. **Half-migrated encryption.** A reader with enforced encryption must never meet an unencrypted state, and `TF_ENCRYPTION` must never override the code. Pinned in Tasks 2, 9 and 11.
6. **Workflow hygiene.** `permissions: {}`, no `pull_request_target`, gitleaks. Pinned in Task 4.

---

## PR strategy and live order (read first)

There are two PRs. Each live step keeps `main` and dev consistent.

| # | Where | Live step | Why this order, and how `main` keeps working |
|---|---|---|---|
| L0 | local + GitHub | Spike (done 2026-10-22, no blockers). Still to do by hand: add `opentofu/setup-opentofu@*` to the Actions allowlist (Task 3 Step 1). | PR 1's CI needs the action. Adding an entry breaks nothing. |
| L1 | PR 1 branch, after Task 6 | `tf.sh bootstrap apply` (Task 7). Additive only: KMS API, keyring, 2 keys, key IAM, `tf-bunny` and its grants, tf-planner bucket read, new sign-in gates (old gate clauses kept), bucket lifecycle rules. No destroys. | Keys and grants must exist before PR 1's encryption code runs in CI. `main`'s gcp/cluster CI and `terraform-apply.yml` keep working: CI bucket bindings are unchanged and the old gate clauses stay. **`main`'s old bunny guard now refuses to plan** (see note below). |
| L2 | GitHub | Merge PR 1 (squash). | `main` now runs OpenTofu, with encryption and the fallback. Live bootstrap equals `main` again. |
| L3 | `main`, local | Encrypt each root with `apply -refresh-only`, oldest generation recorded as the backup (Task 9). Then the first real gcp apply (S1b). | The fallback reads both plaintext and encrypted state, so every reader keeps working during the switch. |
| L4 | GitHub | Merge PR 2: new pipeline, old workflows deleted, fallback removed (enforced). | All states are encrypted at L3; Task 11 Step 1 checks it before the commit. |
| L5 | `main`, local + GitHub | `tf.sh bootstrap apply`: drop the old `terraform-*.yml` gate clauses. Remove `hashicorp/setup-terraform@*` from the allowlist. Cancel old waiting runs. End-to-end checks (Task 13). | Old workflows are already gone, so their gate clauses are dead. |

**Why `main`'s bunny guard may fail between L1 and L2.** Today's guard requires every binding on the state bucket to carry exactly `bunny_fences.state_condition`. tf-bunny's new binding on `dev/bunny/` can't carry it, and L1 also removes the `bunny_fences` output. So from L1 until L2, a bunny plan **from `main`** refuses with "still lets a CI identity read dev/bunny/". That's the safe direction (it fails closed). It doesn't matter in practice:
- CI never plans or applies bunny on `main` today.
- The window is a few hours. Don't make bunny changes in it.
- Bunny can still be planned from the PR 1 branch, which has the new guard. That's also how L1 is verified.

If you'd rather keep `main`'s guard green, move tf-bunny's two bucket bindings and the output removal into a second bootstrap apply from `main` right after L2. It costs one more live step.

**Rule between L1 and L2:** don't apply bootstrap from `main`. If someone does, the KMS resources are only forgotten (`skip_destroy`), but the new gates and tf-bunny would be removed.

Before starting:
- Branch from `main` at or after `ca572ab` (PR #46).
- Close Dependabot PRs #23–#26 with a comment (Task 3).
- Bump providers only after the migration.

---

### Task 1: Spike — OpenTofu 1.13.2 against copies of all five states (done 2026-10-22, no commit)

**Files:** none in the repo. Findings are in the table at the end of this plan. Copy them into the PR 1 description.

**Interfaces:**
- Produces: findings S1–S12 (plus S13–S15 added in this revision), used by Tasks 2, 3, 5, 6, 8, 9 and 10.

- [x] Steps 1–13 (as first written): install tofu 1.13.2, plan copies of all five states with a local backend, compare with Terraform 1.15.9, rehearse encryption offline with `pbkdf2`, probe credentials and `TF_ENCRYPTION`, check the action SHA, Dependabot and the bunny schema. The temp dir and worktree were removed afterwards.
- [ ] **Step 14 (left over):** `ls /tmp | grep tofu-spike` must print nothing. If anything is left, `rm -rf` it (a bunny copy holds keys).

---

### Task 2: `tools/scripts/tf.sh` with tests

**Files:**
- Create: `tools/scripts/tf.sh`, `tools/scripts/tests/tf-sh.test.mjs`
- Modify: `.github/workflows/ci.yml` (after the existing `node --test infra/terraform/modules/bootstrap/tests/*.test.mjs`, add `node --test tools/scripts/tests/*.test.mjs`)

**Interfaces:**
- Consumes: S4, S8.
- Produces:
  - **`tools/scripts/tf.sh <root> <tofu args...>`.** Roots: `bootstrap|gcp|images|cluster|bunny`. Each maps to `infra/terraform/live/dev/<root>`. It execs `tofu -chdir=<dir> <args>`.
  - **`tf.sh <root> plan-summary <planfile>`.** Prints only allowlisted data:
    - one line per change, `<action(s)> <address>`, from `tofu show -json <planfile> | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(",")) \(.address)"'`;
    - then `changes: <n>`.
    - It never prints raw tofu output. If `tofu show` fails it prints `plan-summary: could not read plan (exit N)` and exits 1.
  - **`tf.sh bunny-cli <args...>`.** Runs the bunny CLI with `BUNNYNET_API_KEY` for that one process. The key is read with `gcloud secrets versions access` (impersonating tf-bunny unless `self`). Nothing is written to disk.
  - **`tf.sh bunny-mask secrets|state`.** CI only (refuses unless `GITHUB_ACTIONS=true`). Prints only `::add-mask::<line>` lines, one per non-empty line of each value. Prints nothing else, and on any error prints `bunny-mask: failed (<step>)` and exits 1.
    - `secrets`: every secret whose ID starts with `bunny-` (`gcloud secrets list --format='value(name.basename())'`, filtered in bash), latest version.
    - `state`: needs a prior `init`. `tofu show -json` (current state) piped to `jq` that picks the 5 sensitive attributes (S11): `bunnynet_stream_library.api_key`/`api_key_readonly`, `bunnynet_storage_zone.password`/`password_readonly`, `bunnynet_pullzone.token_auth_key`. No state yet → no output, exit 0.
  - **`TF_SH_IDENTITY`:** unset, `self`, or a service-account email.
  - **Identity map:** `bootstrap → self` (always); `gcp|images|cluster → tf-deployer@heisreal-dev.iam.gserviceaccount.com`; `bunny → tf-bunny@heisreal-dev.iam.gserviceaccount.com`.
  - **Precedence:** an explicit `TF_SH_IDENTITY` wins (`bootstrap` refuses anything but `self`). Otherwise `GITHUB_ACTIONS=true` means ambient credentials. Otherwise the map.
  - **When impersonating (S4):** exports `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` (gcs backend, `gcp_kms`, google provider) and `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT` (gcloud, e.g. `image-state.sh`). Unsets `GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT`, because it would win over the first (S4). Prints `tf.sh: <root> as <email>` on stderr.
  - **Always** unsets `TF_ENCRYPTION` (S8: it replaces the code's config).
  - **Refuses (exit 1):**
    - when `tofu version -json` ≠ `mise.toml`'s `opentofu` pin;
    - locally, without ADC;
    - when any `TF_LOG`, `TF_LOG_CORE`, `TF_LOG_PROVIDER` or `TF_LOG_PATH` is set, or `RUNNER_DEBUG=1` (GitHub step debug). Message: `debug logs can print secrets into public CI logs; run tofu directly for debugging (never for bunny)`;
    - for `bunny`: `state pull`, `show -json` and `output -json` (`plan-summary` is the safe path).
  - **Exit codes:** 64 usage, 1 refusal, otherwise tofu's.

- [ ] **Step 1: Write the failing tests.** Use node:test with stub `tofu`, `gcloud` and `bunny` on `PATH`.
  - The stub `tofu` answers `version -json` with `{"terraform_version":"1.13.2"}` (overridable via `STUB_TOFU_VERSION`). For `show -json` it prints `$STUB_SHOW_JSON`. Otherwise it prints `{argv, env: pick(GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT, CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, TF_ENCRYPTION)}`.
  - The stub `gcloud` answers `secrets list` with `$STUB_SECRETS` and `secrets versions access` with `stub-<secret>`.

  The tests:
  - **Identity defaults**
    - `gcp defaults to tf-deployer locally`: `-chdir=…/infra/terraform/live/dev/gcp`; both impersonation variables are tf-deployer; `GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT` is absent even if the caller set it.
    - `bunny defaults to tf-bunny locally`.
    - `bootstrap never impersonates`: the variables are absent.
  - **Identity overrides**
    - `bootstrap refuses another identity`: exit 1, `/runs with your own credentials/`.
    - `TF_SH_IDENTITY=self uses own credentials`.
    - `CI uses ambient credentials`: with `GITHUB_ACTIONS=true` the variables are absent and no `gcloud auth` call is made.
    - `explicit email wins`.
    - `bad identity refused` (`deployer`): exit 64.
  - **Environment hygiene and refusals**
    - `env encryption cleared`: `TF_ENCRYPTION` is absent in the stub's env.
    - `debug logs refused`: each of `TF_LOG=trace`, `TF_LOG_PROVIDER=debug`, `RUNNER_DEBUG=1` → exit 1 for `gcp plan` and `bunny plan`.
    - `unknown root refused`: exit 64; the message lists the five roots.
    - `version mismatch refused`: `/expected 1.13.2/`.
    - `no ADC refused locally`: `/gcloud auth login --update-adc/`.
    - `bunny refuses state pull and json`: `state pull`, `show -json x` and `output -json` each exit 1. `plan -out=x` passes.
  - **plan-summary**
    - `prints only addresses, actions and count`: with `STUB_SHOW_JSON` holding a change whose `after` has `api_key: "SECRET"` plus a no-op, stdout is exactly `update module.bunny.bunnynet_stream_library.media\nchanges: 1\n` and has no `SECRET`.
    - `hides show errors`: a stub `show` that prints `Error: key SECRET` to stderr and exits 1 → combined output has no `SECRET`, exit 1.
  - **bunny-mask**
    - `refused outside CI`: exit 1 without `GITHUB_ACTIONS=true`.
    - `secrets`: with `STUB_SECRETS="bunny-account-api-key\nbunny-stream-api-key"`, stdout is exactly `::add-mask::stub-bunny-account-api-key\n::add-mask::stub-bunny-stream-api-key\n`.
    - `state`: with a state JSON holding all 5 keys (one with an embedded newline), stdout is only `::add-mask::` lines, one per non-empty line of each value.
    - `state, no state yet`: empty `values` → no output, exit 0.
    - `errors stay quiet`: a failing `show` that prints `SECRET` → output is exactly `bunny-mask: failed (state)`, exit 1.
  - **bunny-cli**
    - `passes key to one process`: stdout is `stub-bunny-account-api-key`; gcloud gets `--impersonate-service-account=tf-bunny@…` (absent with `self`).

  Run `node --test tools/scripts/tests/`: FAIL.
- [ ] **Step 2: Implement `tf.sh`.** `set -euo pipefail`, a usage header, repo root `$(cd "$(dirname "$0")/../.." && pwd)`. Read the pin with `sed -n 's/^opentofu = "\(.*\)"/\1/p' mise.toml`. Make it executable.
- [ ] **Step 3: Verify.** `node --test tools/scripts/tests/` PASS; `shellcheck tools/scripts/tf.sh` reports nothing.
- [ ] **Step 4: Commit.**
```bash
git add tools/scripts/tf.sh tools/scripts/tests/tf-sh.test.mjs .github/workflows/ci.yml
git commit -S -m "feat(infra): tf.sh, one OpenTofu entry point for CI and laptops (D54)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Switch tooling to OpenTofu (same workflow file names, no encryption yet)

**Files:**
- Modify: `mise.toml`, `infra/terraform/live/dev/*/.terraform.lock.hcl` (all 5), `.github/dependabot.yml`
- Modify: `.github/workflows/terraform-plan.yml`, `.github/workflows/terraform-apply.yml`. Keep the names: the live gates pin them until L5.
- Modify: `infra/terraform/modules/db-migration/tests/job_name.tftest.hcl`, `infra/terraform/modules/db-identity/tests/identity.tftest.hcl` (S3)
- Delete: `tools/scripts/tf-bunny.sh`
- Modify: its references in `infra/terraform/README.md`, `infra/terraform/live/dev/bunny/main.tf:2-9` and `AGENTS.md`

**Interfaces:**
- Consumes: Task 2, S2, S3, S10.
- Produces: workflows that run `tools/scripts/tf.sh`; lock files with `registry.opentofu.org` entries only.

- [ ] **Step 1 [LIVE: GitHub, L0]: Allow the OpenTofu action.** (Not done yet: the allowlist read on 2026-10-22 has four patterns.)
```bash
gh api -X PUT repos/He-Is-Real/monorepo/actions/permissions/selected-actions \
  -F github_owned_allowed=true -F verified_allowed=false \
  -f 'patterns_allowed[]=pnpm/action-setup@*' -f 'patterns_allowed[]=nrwl/nx-set-shas@*' \
  -f 'patterns_allowed[]=google-github-actions/auth@*' -f 'patterns_allowed[]=hashicorp/setup-terraform@*' \
  -f 'patterns_allowed[]=opentofu/setup-opentofu@*'
```
  Expected `--jq .patterns_allowed`: the five patterns.
- [ ] **Step 2:** add `opentofu = "1.13.2"` to `mise.toml`, then `mise install && tofu version`.
- [ ] **Step 3: Regenerate the lock files without version changes** (S2). Per root:
  1. Create a temporary `versions_override.tf` pinning: google `8.5.0` (bunny `8.7.0`), random `3.9.1`, helm `3.3.0`, kubernetes `3.3.0`, kustomization `0.9.8`, external `2.4.2`, bunnynet `0.19.2`.
  2. `rm .terraform.lock.hcl && tofu init -backend=false -input=false`. A plain init writes h1 and zh hashes for every platform (S2).
  3. Delete the override.

  Expected: `grep -c registry.terraform.io` is 0 everywhere, and the versions are unchanged.
- [ ] **Step 4: Check the unsigned provider.** kbst/kustomization 0.9.8 has no signing keys in the OpenTofu registry (S2: "signature validation was skipped"). Its trust comes from the lock-file hashes, so confirm it is the same binary Terraform verified: the new `h1:` hash for linux_amd64 in `live/dev/cluster/.terraform.lock.hcl` must equal the old Terraform lock's `h1:sfTMNlekbd3K2A/jWoOmaIIgKAWOIZ0+6UgdaXYqQtc=`. Add a comment above the entry: `# Unsigned in registry.opentofu.org; pinned by these hashes (h1 matched Terraform's signed lock, 2026-10-2x).`
- [ ] **Step 5: Fix the two module tests (S3).** OpenTofu rejects `run.<name>.<output>` inside `assert`.
  - In `job_name.tftest.hcl`, give `run "a"` `command = apply` (no providers or resources, so it stays offline). In each later run that compares with it, pass the value in, as in the spike's repro: `variables { base_job_name = run.a.job_name }` (and `base_dpa_sha256 = run.a.params.dpa_sha256.v1` where used). Assert on `var.base_job_name` etc.
  - Same for `identity.tftest.hcl` with `run "base"` and `run.base.hash`.
  - `tofu -chdir=infra/terraform/modules/db-migration test` and `… db-identity test` must pass (9/9 and 6/6, as on Terraform).
- [ ] **Step 6: Rewrite the two workflows to run tofu.**
  - Use the setup-opentofu SHA with `tofu_version: 1.13.2` and `tofu_wrapper: false`.
  - `tofu fmt`; root commands become `tools/scripts/tf.sh <root> …`; module tests become `tofu -chdir=… test`.
  - Keep plan files under `$RUNNER_TEMP`.
- [ ] **Step 7: Dependabot (S10).** Change the `terraform` entry to `package-ecosystem: opentofu` (version updates only; OpenTofu has no Dependabot security updates). Close #23–#26 with `gh pr close <n> -c "Superseded by the OpenTofu migration (D54)."`.
- [ ] **Step 8:** delete `tf-bunny.sh` and point its references to `tf.sh bunny …` / `tf.sh bunny-cli …`. In `AGENTS.md`, replace "Moving to OpenTofu (D54); until that PR lands, the Terraform rules apply as written." with "Run every root through `tools/scripts/tf.sh <root> …` (OpenTofu, D54)." `git grep -n tf-bunny.sh` must print nothing.
- [ ] **Step 9: Verify (read-only).**
  - `tofu fmt -check -recursive infra/terraform` → exit 0.
  - For each root: `tools/scripts/tf.sh <r> init -input=false && tools/scripts/tf.sh <r> plan -lock=false -detailed-exitcode`. Use `TF_SH_IDENTITY=self` for bunny (tf-bunny doesn't exist yet).
  - Expected: exit 0, or exactly the change set in S1 (gcp: the 7 S1b updates; images: new prune tags).
- [ ] **Step 10: Commit and open draft PR 1.** The body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Expected CI: `main`, `validate`, `plan (gcp)` green; approve `plan-cluster`, which should say "No changes".
```bash
git add -A mise.toml infra/terraform .github tools/scripts AGENTS.md
git commit -S -m "build(infra): run every root on OpenTofu 1.13.2 (D54)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/opentofu && gh pr create --draft --title "feat(infra): OpenTofu with KMS-encrypted state and tf-bunny (D54, D57; 1/2)" --body-file <(…)
```

---

### Task 4: Repo hygiene — `.gitignore`, gitleaks, workflow permissions

**Files:**
- Modify: `.gitignore`, `infra/terraform/.gitignore`, `mise.toml`, `.github/workflows/{ci,terraform-plan,terraform-apply,images,_images,snapshot-images}.yml`, `AGENTS.md`
- Create: `.gitleaks.toml`, `tools/scripts/install-hooks.sh`, `tools/scripts/tests/gitleaks-bunny.test.mjs`, `tools/scripts/tests/workflows.test.mjs`

**Interfaces:**
- Produces:
  - `.gitleaks.toml`, used by CI and the hook.
  - `tools/scripts/install-hooks.sh`, which writes `.git/hooks/pre-commit`.
  - `workflows.test.mjs`, which Task 10's new workflows must pass.

**Hook tooling choice:** a ~20-line `install-hooks.sh` that writes `.git/hooks/pre-commit`. It adds no dependency and nothing runs on `pnpm install`. lefthook would add a package and a config file for a single hook. gitleaks itself comes from `mise.toml`.

**CI install choice:** download the pinned gitleaks release and check its SHA-256, like kubeconform in `ci.yml`. `gitleaks/gitleaks-action` needs a licence key for organisation-owned repos (its README, read 2026-10-22), and it would need an allowlist entry. If you'd still rather use the action, pin it by SHA and add `gitleaks/gitleaks-action@*` to the allowlist by hand (Task 3 Step 1's command).

- [ ] **Step 1: Root `.gitignore`.** Add a block:
```gitignore
# OpenTofu: plans, state and crash logs never belong in git (state lives in GCS).
*.tfplan
*.tfplan.json
tfplan
*.tfstate
*.tfstate.*
crash.log
crash.*.log
.terraform/
.terraform.tfstate.lock.info
```
  Extend the existing env block to `.env`, `.env.*`, `!.env.example`, `!**/.env.example`.
- [ ] **Step 2: `infra/terraform/.gitignore`.** Keep only what the root file doesn't cover: `.build/` and `!.terraform.lock.hcl` (lock files are committed), with a comment pointing to the root file.
- [ ] **Step 3: Check no tracked file becomes ignored.** `git ls-files -ci --exclude-standard` must print nothing. (Checked 2026-10-22 against the new patterns: nothing. The five `apps/*/.env.example` files stay tracked.)
- [ ] **Step 4: Write the failing gitleaks tests.** `gitleaks-bunny.test.mjs` writes fixtures into a temp dir (never into the repo, so the repo holds no fake keys) and runs `gitleaks dir <tmp> --config .gitleaks.toml --no-banner --exit-code 1`. Use a made-up UUID-like value `K` built at runtime.
  - Bunny keys come in two shapes, and both need fixtures:
    - `U`: UUID-like, 36 characters, hex groups 8-4-4-4-12.
    - `L`: 41 characters, hex groups **8-4-4-12-4-4**. This is how 4 of the 5 real keys look (Codex round 3).
  - Flagged (exit 1), each with `U` and with `L`: `BUNNY_STREAM_API_KEY=K` in `x.env`; `"AccessKey": "K"` in `a.json`; `curl -H "AccessKey: K"` in `run.sh`; `bunny_password = "K"` in `main.tf`; and a Bunny label with no key or password word, `bunny="K"` in `a.sh` and `"bunny": "K"` in `b.json`.
  - Not flagged (exit 0): `id: U` and `id: L` in `a.yaml` (no Bunny context); a `package-lock`-style `"integrity"` line; `BUNNY_STREAM_API_KEY=L` in `apps/web/.env.example`.
  - The default rules still work: a fake `ghp_` token in `a.txt` is flagged.

  Run: FAIL (no config yet).
- [ ] **Step 5: `.gitleaks.toml`.**
```toml
# Default gitleaks rules plus Bunny.net keys, which GitHub secret scanning doesn't know.
# Bunny keys are hex in groups 8-4-4-4-12 (UUID-like) or 8-4-4-12-4-4 (41 chars),
# so the rule needs Bunny context nearby to avoid matching every UUID.
[extend]
useDefault = true

[[rules]]
id = "bunny-key"
description = "Bunny.net API key, storage password or token key"
regex = '''(?i)(?:accesskey|bunny[a-z0-9_.-]*)["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-(?:[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{4}))\b'''
secretGroup = 1
keywords = ["accesskey", "bunny"]

[[allowlists]]
description = "Example env files hold placeholders only"
paths = ['''(^|/)\.env\.example$''']
```
  Tests PASS. If the `[[allowlists]]` table isn't supported by 8.30.1, use the older `[allowlist]` form and note it.
- [ ] **Step 6: Scan the full history once (local, read-only).** `gitleaks git --config .gitleaks.toml --redact --no-banner`. Expected: no findings. Any finding is a real leak until shown otherwise: stop and tell Joel (rotate first, then decide on history).
- [ ] **Step 7: Pre-commit hook.**
  - Add `gitleaks = "8.30.1"` to `mise.toml`.
  - `tools/scripts/install-hooks.sh` writes `.git/hooks/pre-commit` (into `git rev-parse --git-common-dir`, so worktrees share it) containing: `exec gitleaks git --pre-commit --staged --redact --no-banner --config "$(git rev-parse --show-toplevel)/.gitleaks.toml"`. If `gitleaks` is missing, the hook fails with `gitleaks not found: run mise install`. The installer refuses to overwrite an existing hook it didn't write.
  - Verify: stage a temp file holding a fake Bunny line; `git commit` is refused; unstage it.
- [ ] **Step 8: gitleaks in CI.** In `ci.yml`'s `main` job (it already checks out with `fetch-depth: 0`):
```yaml
env:
  GITLEAKS_VERSION: 8.30.1
  # From gitleaks_8.30.1_checksums.txt (read 2026-10-22).
  GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
# ...
- name: Install gitleaks
  run: |
    curl -fsSLo "$RUNNER_TEMP/gitleaks.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    echo "$GITLEAKS_SHA256  $RUNNER_TEMP/gitleaks.tgz" | sha256sum -c -
    tar xzf "$RUNNER_TEMP/gitleaks.tgz" -C "$RUNNER_TEMP/bin" gitleaks
- name: Scan new commits for secrets
  run: gitleaks git --config .gitleaks.toml --redact --no-banner --log-opts="${{ github.event.pull_request.base.sha || github.event.before }}..${{ github.sha }}"
```
  Put the install step after "Install kubeconform" (it creates `$RUNNER_TEMP/bin` and adds it to `PATH`) and before the `node --test tools/scripts/tests/` step, which needs gitleaks. (On the first push to a new branch `github.event.before` is all zeros: fall back to `--log-opts=-1`.)
- [ ] **Step 9: Write the failing workflow test.** `workflows.test.mjs` parses every `.github/workflows/*.yml` with `yaml` and asserts:
  - the top-level `permissions` exists and is exactly `{}`;
  - no trigger is `pull_request_target`;
  - every job that uses `google-github-actions/auth`, or a local action that does, has `id-token: write` in its own `permissions`.

  Run: FAIL on today's files.
- [ ] **Step 10: Fix every workflow.** Top-level `permissions: {}`; per job, only what it uses:
  - `ci.yml` `main`: `contents: read`.
  - `terraform-plan.yml` jobs and `terraform-apply.yml` jobs: `contents: read`; add `id-token: write` to the jobs that authenticate.
  - `images.yml`: `changes` keeps `contents: read, actions: read`; `images` (calls `_images.yml`) gets `contents: read, id-token: write`.
  - `_images.yml` (reusable): top-level `permissions: {}`, job `push`: `contents: read, id-token: write`. A called workflow can only lower the caller's grant, so the caller must grant both.
  - `snapshot-images.yml`: same as `images.yml`'s `images` job.

  Tests PASS. `actionlint .github/workflows/*.yml` is clean.
- [ ] **Step 11: AGENTS.md.** Add after the secrets bullet: "Install the secret-scanning hook once per clone: `mise install && tools/scripts/install-hooks.sh` (gitleaks, `.gitleaks.toml`)."
- [ ] **Step 12: Commit.**
```bash
git add .gitignore infra/terraform/.gitignore mise.toml .gitleaks.toml tools/scripts .github/workflows AGENTS.md
git commit -S -m "chore(repo): ignore plans and state, gitleaks with a Bunny rule, least-privilege workflow permissions (D57)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bootstrap code — KMS, tf-bunny, gates (one commit, applied at L1)

**Files:**
- Create: `infra/terraform/modules/bootstrap/{kms.tf,tf_bunny.tf,deploy_gate.cel.tftpl,bunny_gate.cel.tftpl}`, `tests/{claims.mjs,deploy-gate.test.mjs,bunny-gate.test.mjs}`
- Modify: `modules/bootstrap/{main.tf,ci_identity.tf,state.tf,bunny.tf,outputs.tf,cluster_plan_gate.cel.tftpl}`, `tests/cluster-plan-gate.test.mjs`

**Interfaces:**
- Consumes: S5, S12, S13.
- Produces (outputs of `module.bootstrap`):
  - `kms_state_key` = `projects/heisreal-dev/locations/europe-west2/keyRings/tofu/cryptoKeys/tofu-state`
  - `kms_bunny_key` = `…/cryptoKeys/tofu-bunny`
  - `tf_bunny_email`
  - **Removed:** `bunny_fences` (the bunny root no longer reads bootstrap; Task 6).

This commit must keep `main`'s gcp/cluster CI and `terraform-apply.yml` working, so the old gate clauses stay until L5.

- [ ] **Step 1: Write the failing gate tests.**
  - Shared fixtures go in `tests/claims.mjs`: `repository`, `claims(overrides)` and `gate(templateFile, claims)`. `gate` substitutes `${repository}` and evaluates with cel-js. Move the existing helper code out of `cluster-plan-gate.test.mjs`.
  - `deploy-gate.test.mjs` (tf-deployer):
    - Allowed on `refs/heads/main`: `push`, `workflow_dispatch` and `workflow_run` for `tofu-apply.yml@refs/heads/main`; `schedule` and `workflow_dispatch` for `tofu-drift.yml@refs/heads/main`; and, until L5, `workflow_dispatch` for `terraform-apply.yml@refs/heads/main`.
    - Denied: `pull_request`; a non-main ref; `tofu-apply.yml` from a feature branch; `tofu-plan.yml`; `tofu-drift.yml` on `push`; `terraform-apply.yml` on `push`; another repository.
  - `bunny-gate.test.mjs` (tf-bunny):
    - Allowed on `refs/heads/main`: `tofu-apply.yml@refs/heads/main` with `push` or `workflow_dispatch`; `tofu-drift.yml@refs/heads/main` with `schedule` or `workflow_dispatch`. With or without an `environment` claim.
    - Denied: `pull_request` (ref `refs/pull/1/merge`); a feature-branch ref; `tofu-apply.yml@refs/heads/feature`; `workflow_run`; `tofu-plan.yml`; `terraform-apply.yml`; `ci.yml`; another repository.
  - `cluster-plan-gate.test.mjs`: keep the existing cases. Add `tofu-plan.yml` on `pull_request` in env `cluster-plan` as allowed, and `tofu-plan.yml` on `push` as denied.

  Run `node --test infra/terraform/modules/bootstrap/tests/`: FAIL.
- [ ] **Step 2: Write the templates** (each under 2048 characters, the attribute-mapping limit).
  - `deploy_gate.cel.tftpl`: `assertion.ref == 'refs/heads/main'` AND one of:
    - `job_workflow_ref == '${repository}/.github/workflows/tofu-apply.yml@refs/heads/main'` and event in `['push','workflow_dispatch','workflow_run']`;
    - `…/tofu-drift.yml@refs/heads/main` and event in `['schedule','workflow_dispatch']`;
    - `…/terraform-apply.yml@refs/heads/main` and event `workflow_dispatch` (removed at L5).

    Result `? 'allowed' : 'denied'`. `job_workflow_ref`, like today's deploy gate.
  - `bunny_gate.cel.tftpl`: ref main AND (`tofu-apply.yml@refs/heads/main` with `push`/`workflow_dispatch`, or `tofu-drift.yml@refs/heads/main` with `schedule`/`workflow_dispatch`).
  - `cluster_plan_gate.cel.tftpl`: also accept `tofu-plan.yml@` on `pull_request`.

  Wire them through `templatefile` in `ci_identity.tf`, adding `attribute.bunny_gate`. Update the header table of identities. Tests PASS.
- [ ] **Step 3: `kms.tf`.**
  - Add `"cloudkms.googleapis.com"` to `local.services`.
  - `google_kms_key_ring.tofu`; `google_kms_crypto_key.state` (`tofu-state`) and `.bunny` (`tofu-bunny`), with the Global Constraints settings and `lifecycle { prevent_destroy = true; destroy = false }`.
  - Authoritative `google_kms_crypto_key_iam_policy` per key, same lifecycle. Role `roles/cloudkms.cryptoKeyEncrypterDecrypter`:
    - `tofu-state`: `var.developers`, tf-deployer, tf-planner, tf-cluster-planner.
    - `tofu-bunny`: `var.developers`, tf-bunny.
  - Header comment: why two keys (only tf-bunny and developers can open Bunny state; a key per root costs more and adds nothing, since bucket IAM already separates the other states). Never disable or destroy a version. Recovery: README "Encryption".
- [ ] **Step 4: `tf_bunny.tf`.**
  - Service account `tf-bunny` ("OpenTofu bunny root (CI on main, developers)").
  - `roles/iam.workloadIdentityUser` for `${local.pool}/attribute.bunny_gate/allowed`.
  - Developers get Token Creator on tf-bunny. Today's `developers_impersonate` (`ci_identity.tf:312-321`) picks the account with `each.value.sa == "planner" ? tf_planner : tf_deployer`, so just adding `"bunny"` to the `setproduct` would make a **second deployer grant** (Codex round 3). Instead:
    - add `local.impersonation_targets = { planner = google_service_account.tf_planner.name, deployer = google_service_account.tf_deployer.name, bunny = google_service_account.tf_bunny.name }`;
    - use `setproduct(keys(local.impersonation_targets), var.developers)` and `service_account_id = local.impersonation_targets[each.value.sa]`.
    - The keys stay `planner/<member>` and `deployer/<member>`, so existing addresses don't change and no `moved` block is needed. The plan must show exactly one new `developers_impersonate["bunny/user:joel@heisreal.today"]` on tf-bunny and no change to the other two.
    - This grant is needed: developers hold only `roles/owner` and `roles/storage.admin` (read 2026-10-22), and Owner has no `iam.serviceAccounts.getAccessToken`.
  - Project `roles/iam.securityReviewer` for the never-public guard. Verified 2026-10-22 (S13): it holds `storage.buckets.getIamPolicy`, `secretmanager.secrets.list`, `secretmanager.secrets.getIamPolicy`, `cloudkms.keyRings.getIamPolicy`, `cloudkms.cryptoKeys.getIamPolicy` and `resourcemanager.projects.getIamPolicy`. It does **not** hold `storage.buckets.get` or `secretmanager.secrets.get`; the guard doesn't need them.
  - Custom role `bunnyParent` with `secretmanager.secrets.create`. Create is checked on the project and can't be limited by name. Creating a secret gives no access to existing ones.
  - The existing `tf_secrets` custom role, bound to tf-bunny with condition `only-bunny-secrets`: Secret/SecretVersion types whose name starts with `projects/<number>/secrets/bunny-` or `projects/heisreal-dev/secrets/bunny-` (the exact opposite of the deployer's `not-bunny-secrets`; reuse `local.bunny_secret_prefixes`).
  - `roles/secretmanager.secretAccessor` with the same `only-bunny-secrets` condition. The bunny root reads the account key; `tf.sh bunny-mask` reads every `bunny-*` secret.
  - Add the new `google_project_iam_member` resources to `legacy_cloudbuild_builder`'s `depends_on` in `bunny.tf` (it must run after every project IAM write).
- [ ] **Step 5: `state.tf`.** Keep the two existing bindings exactly as they are. Add (`O = projects/_/buckets/heisreal-dev-tfstate/objects/`):

  | Role | Members | Condition |
  | --- | --- | --- |
  | `roles/storage.objectAdmin` | tf-bunny | `resource.type == 'storage.googleapis.com/Bucket' \|\| resource.name.startsWith(O + 'dev/bunny/') \|\| resource.name == O + 'applied/bunny'` |
  | `roles/storage.bucketViewer` (BETA; `storage.buckets.get`, `.list`) | tf-planner | none (S12: the bootstrap drift plan refreshes the bucket) |

  - The bucket-type clause lets tf-bunny list object names (the backend lists workspaces). Object contents elsewhere stay closed, because object permissions are checked on the object.
  - `applied/bunny` is bunny's "last applied commit" marker for the pipeline (Task 10). It holds only a commit SHA. tf-deployer writes `applied/gcp` and `applied/cluster` through its existing `!dev/bunny/` binding; tf-planner reads all three through its existing binding. tf-deployer could also overwrite `applied/bunny`; the worst case is that a bunny change waits for the next run or the weekly drift shows it. Accepted, like its other escalation paths.
  - Add one lifecycle rule: delete objects under `dev/bunny/plans/` and `dev/bunny/logs/` after 7 days. It's cleanup only. Real retention is about 14 days with versioning and soft delete; accepted.
  - Update the comments: CI identities other than tf-bunny get nothing under `dev/bunny/`.
- [ ] **Step 6: `outputs.tf`.** Add `kms_state_key`, `kms_bunny_key`, `tf_bunny_email`. Remove `bunny_fences`. Keep `local.ci_state_condition` and `local.deployer_fences`: they still build the existing bindings.
- [ ] **Step 7: Plan (read-only).** `tools/scripts/tf.sh bootstrap plan -detailed-exitcode` → exit 2.
  - Adds: the cloudkms service, keyring, 2 keys, 2 key IAM policies, tf-bunny, its WIF binding, **one** developer Token Creator binding on tf-bunny (`developers_impersonate["bunny/…"]`), the `bunnyParent` role, tf-bunny's 4 project bindings.
  - `developers_impersonate["planner/…"]` and `["deployer/…"]`: no change.
  - In-place: the WIF provider's `attribute_mapping`; the bucket IAM policy (2 bindings added, 2 unchanged); the bucket's lifecycle rules.
  - **No destroy, no replace.**

  Commit:
```bash
git add infra/terraform/modules/bootstrap
git commit -S -m "feat(infra): KMS keys for state, tf-bunny and its main-only gate (D54, D57 C)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Bunny root — the "never public" guard

**Files:**
- Modify (rewrite in place, keeping the name): `infra/terraform/modules/bunny-state-guard/{main.tf,tests/guard.tftest.hcl}`
- Modify: `infra/terraform/live/dev/bunny/{main.tf,backend.tf}`, `tools/scripts/check-bunny-fences.sh`

**Decision:** simplify `bunny-state-guard` in place rather than add a new module. It keeps one job (guard the Bunny root) and its path in CI and `tf-roots.sh`. The old object-reader logic, the service-agent list and `roles_to_check` go.

**Interfaces:**
- Produces:
  - Module input `policies`: map of name → list of bindings `{role, members, condition?}`.
  - Module output `public_grants`: list of `"<name>: <member> (<role>)"` for every member equal to `allUsers` or `allAuthenticatedUsers`, conditions or not. Must be empty.
  - The bunny root reads no remote state. tf-bunny needs no `dev/bootstrap/` read and no `tofu-state` access.

- [ ] **Step 1: Write the failing tests** (offline, `command = plan`, no `run.<x>` references, so S3 doesn't apply).
  - `clean_policies_pass`: bucket, project, keyring, two keys and two secrets with only developer and service-account members → `[]`.
  - `all_users_on_bucket_fails` → exactly `["bucket: allUsers (roles/storage.objectViewer)"]`.
  - `all_authenticated_on_secret_fails`, with a conditional binding → 1.
  - `public_on_keyring_fails` → 1.
  - `empty_policy_is_fine`: a policy with no bindings → `[]`.

  `tofu -chdir=infra/terraform/modules/bunny-state-guard test`: FAIL.
- [ ] **Step 2: Implement the module.** Tests PASS.
- [ ] **Step 3: Rewrite `live/dev/bunny/main.tf`.**
  - Header: applied with `tools/scripts/tf.sh bunny init|plan|apply` (as tf-bunny; `TF_SH_IDENTITY=self` for your own login). CI plans it only on `main` (`tofu-apply.yml`, `tofu-drift.yml`), never in PRs. State and saved plans are encrypted with `tofu-bunny`.
  - Remove `data.terraform_remote_state.bootstrap`, `data.google_organization_iam_policy.org`, `data.google_iam_role.other`, the service-agent list and the `deployer_is_fenced` / `state_is_private` locals.
  - Add data sources (all exist in google 8.7.0, checked 2026-10-22):
    - `google_storage_bucket_iam_policy.tfstate` (kept) and `google_project_iam_policy.project` (kept; a cheap extra, because project grants reach everything);
    - `google_secret_manager_secrets.all`, then `local.bunny_secrets = [for s in data.google_secret_manager_secrets.all.secrets : s.secret_id if startswith(s.secret_id, "bunny-")]`;
    - `google_secret_manager_secret_iam_policy.bunny` (`for_each = toset(local.bunny_secrets)`);
    - `google_kms_key_ring_iam_policy.tofu`;
    - `google_kms_crypto_key_iam_policy.key` (`for_each = toset(["tofu-state", "tofu-bunny"])`).
  - Each `policy_data` becomes `try(jsondecode(x).bindings, [])`.
  - `terraform_data.never_public` with two preconditions, plus `moved { from = terraform_data.state_is_private  to = terraform_data.never_public }`:
    - `length(module.never_public.public_grants) == 0`. Error: "Public access found: <list>. Remove it through OpenTofu (bootstrap or this root) before planning Bunny."
    - `contains(local.bunny_secrets, "bunny-account-api-key")`. This fails closed if the listing is wrong. Error: "Couldn't list the bunny-* secrets; refusing to plan."
  - `module.bunny` keeps `depends_on = [terraform_data.never_public]`.
  - `backend.tf` comment: "only developers and tf-bunny can read it; encrypted with tofu-bunny".
- [ ] **Step 4: Update `check-bunny-fences.sh`** (local, run by a developer; read-only).
  - Keep today's tf-deployer checks: they check "no grants", which still holds.
  - Add for tf-deployer: on key `tofu-bunny`, `testIamPermissions` for `cloudkms.cryptoKeyVersions.useToDecrypt,useToEncrypt` → `""`.
  - Add a tf-bunny token (`generateAccessToken`, 300 s; developers hold Token Creator after L1):
    - `dev/bunny/default.tfstate` metadata → 200; `dev/gcp/default.tfstate` → 403;
    - `bunny-account-api-key` access → 200 (output to `/dev/null`); `surreal-root-password` access → 403;
    - on `tofu-bunny`: `useToDecrypt,useToEncrypt`; on `tofu-state`: `""`.
  - Add the org-level check, as the developer (org `securityReviewer`): `gcloud organizations get-iam-policy 463617123121 --format=json | jq '[.bindings[].members[] | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length'` → `0`.
  - Update the header: what it checks and that it needs no stage flag.
  - `shellcheck` clean.
- [ ] **Step 5: Validate.** `tofu fmt -check -recursive infra/terraform`; `tools/scripts/tf.sh bunny init -backend=false && tools/scripts/tf.sh bunny validate`.
- [ ] **Step 6: Commit.**
```bash
git add infra/terraform/modules/bunny-state-guard infra/terraform/live/dev/bunny tools/scripts/check-bunny-fences.sh
git commit -S -m "feat(infra): bunny root refuses to plan if anything Bunny is public (D57 C)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: [LIVE, L1] Apply bootstrap from the PR 1 branch; verify

- [ ] **Step 1: Apply.** On `feat/opentofu` at the Task 6 commit (record the SHA in the PR):
  1. `tools/scripts/tf.sh bootstrap init && tools/scripts/tf.sh bootstrap apply`. Read the plan: it must match Task 5 Step 7.
  2. `tools/scripts/tf.sh bootstrap plan -detailed-exitcode` → exit 0.
  3. `gcloud storage cat gs://heisreal-dev-tfstate/dev/bootstrap/default.tfstate | jq '[.resources[] | select(.type|startswith("google_kms")) | .instances[].skip_destroy]'` → all `true`. (Bootstrap state is still plaintext and holds no secrets.)
- [ ] **Step 2: Verify (read-only).**
  - **First, Token Creator on tf-bunny** (the probes below depend on it): `gcloud iam service-accounts get-iam-policy tf-bunny@heisreal-dev.iam.gserviceaccount.com --format=json | jq -c '.bindings'` shows `roles/iam.serviceAccountTokenCreator` for `user:joel@heisreal.today` and `workloadIdentityUser` for `…/attribute.bunny_gate/allowed`, nothing else. Also `gcloud iam service-accounts get-iam-policy tf-deployer@…` still shows exactly one Token Creator member (no second grant). Then `gcloud auth print-access-token --impersonate-service-account=tf-bunny@heisreal-dev.iam.gserviceaccount.com > /dev/null` succeeds.
  - Two keys `ENABLED`: `gcloud kms keys list --keyring tofu --location europe-west2 --project heisreal-dev --format='value(name,primary.state)'`.
  - `tools/scripts/check-bunny-fences.sh` → only `ok` lines, exit 0.
  - On the branch: `tools/scripts/tf.sh bunny init -reconfigure && tools/scripts/tf.sh bunny plan -detailed-exitcode` as **tf-bunny** (the default) → exit 0 and the guard passes. This is the first real proof that tf-bunny has enough access.
  - gcp and cluster plans as tf-deployer from the branch → same results as Task 3 Step 9.
  - `main` is unaffected for gcp and cluster. On a checkout of `main`, a bunny plan now refuses ("still lets a CI identity read dev/bunny/"), as explained under the live table. Don't change bunny until L2.
- [ ] **Step 3: Push the branch.** PR 1 CI green.
- [ ] **Rollback (selective; never remove the KMS part).** To undo L1, revert Task 5's changes **except** `kms.tf` and the cloudkms service, then apply bootstrap. The KMS resources stay. If they ever leave the config they're only forgotten (`skip_destroy`); an unused key costs about $0.06/month.

---

### Task 8: Encryption with `unencrypted` fallback in every root (code; merge PR 1 = L2)

**Files:**
- Create: `infra/terraform/live/dev/{bootstrap,gcp,images,cluster,bunny}/encryption.tf`
- Modify: `.github/workflows/terraform-plan.yml` (validate job: the bunny sensitive-schema check, S11, and the key-name check)

**Interfaces:**
- Produces:
  - Key providers `gcp_kms.state` (alias `tofu-state`) or `gcp_kms.bunny` (alias `tofu-bunny`).
  - Methods `aes_gcm.state` / `aes_gcm.bunny` and `unencrypted.migration`. Task 11 deletes `migration` and every `fallback`.

- [ ] **Step 1: Write `encryption.tf`.** gcp, images and cluster use the block below. bootstrap omits `remote_state_data_sources` (it reads no remote state). bunny uses `gcp_kms.bunny` / `aes_gcm.bunny` with key `tofu-bunny`, and omits `remote_state_data_sources`.
```hcl
# State and saved plans encrypted with Cloud KMS (D54). Losing tofu-state loses these states.
terraform {
  encryption {
    key_provider "gcp_kms" "state" {
      kms_encryption_key       = "projects/heisreal-dev/locations/europe-west2/keyRings/tofu/cryptoKeys/tofu-state"
      key_length               = 32
      encrypted_metadata_alias = "tofu-state"
    }
    method "aes_gcm" "state" {
      keys = key_provider.gcp_kms.state
    }
    method "unencrypted" "migration" {} # removed in Task 11

    state {
      method = method.aes_gcm.state
      fallback { method = method.unencrypted.migration }
    }
    plan {
      method = method.aes_gcm.state
      fallback { method = method.unencrypted.migration }
    }
    remote_state_data_sources {
      default {
        method = method.aes_gcm.state
        fallback { method = method.unencrypted.migration }
      }
    }
  }
}
```
- [ ] **Step 2: Validate offline.** `tofu fmt -check -recursive infra/terraform`, then `init -backend=false && validate` for all five roots without credentials. This passes but **doesn't check the encryption block** (S6: a typo or `key_length = 0` still validates).
- [ ] **Step 3: Add static CI checks** in the validate job:
  - S11: `tools/scripts/tf.sh bunny providers schema -json | jq -e '<filter for the 5 attributes> | [.. | booleans] | all'` → `true`.
  - Key names: `grep -q 'cryptoKeys/tofu-bunny"' live/dev/bunny/encryption.tf` and, for the other four, `grep -q 'cryptoKeys/tofu-state"'` and no `tofu-bunny`.
- [ ] **Step 4: Test the encryption block for real (S6).** Plans against the real backend are the only real test. Writing doesn't happen in a plan, so this is safe:
  - `tools/scripts/tf.sh <r> init -reconfigure && tools/scripts/tf.sh <r> plan -lock=false -detailed-exitcode` for all five roots, default identities (bunny as tf-bunny). Expected: same results as Task 7 Step 2. A broken encryption block fails here with an error such as "Missing required argument".
  - In CI, PR 1's `plan (gcp)` (tf-planner) and `plan-cluster` (tf-cluster-planner) run the gcp and cluster blocks against the real backend and KMS on every PR.
  - bootstrap, images and bunny encryption changes are tested by these local plans, and later by drift (bootstrap, bunny) and the post-merge plan. A broken block fails a plan; it can't write state without an approved apply.
- [ ] **Step 5: Commit, mark ready, merge (L2).** Push only after L1 (CI's plans need the keys).
```bash
git add infra/terraform/live .github/workflows/terraform-plan.yml
git commit -S -m "feat(infra): KMS state and plan encryption for every root, with migration fallback (D54)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push && gh pr ready && gh pr merge --squash
```

---

### Task 9: [LIVE, L3] Encrypt every state, from `main` (no commit)

**Interfaces:**
- Consumes: S1b, S7.
- Produces: all five state objects encrypted. Task 11 requires this.

- [ ] **Step 1:** `git switch main && git pull`. For each root, `tools/scripts/tf.sh <r> init -reconfigure`.
- [ ] **Step 2: Back up, encrypt and verify, one root at a time**, in this order: bootstrap → gcp → images → cluster → bunny.
  1. **Backup.** The bucket is versioned, so the current generation is the backup. Record it: `gcloud storage ls -a gs://heisreal-dev-tfstate/dev/<r>/default.tfstate` (newest generation) into the PR 2 description. Restore if ever needed: `gcloud storage cp 'gs://heisreal-dev-tfstate/dev/<r>/default.tfstate#<gen>' gs://heisreal-dev-tfstate/dev/<r>/default.tfstate`. Don't copy state to disk: the bunny state holds keys.
  2. **Before.** `gcloud storage cat gs://…/dev/<r>/default.tfstate | jq -c '{serial,lineage}'`. It prints only those two fields, so it's safe for bunny too.
  3. **Encrypt (S7).** `tools/scripts/tf.sh <r> apply -refresh-only`. Read the plan; it should show no changes, or only refreshed attributes. For images, run `pnpm nx run-many -t prune -p api-public-read api-user api-admin workflow web` first (its data sources hash the build output). bunny runs as tf-bunny.
  4. **After.** `gcloud storage cat … | jq -c 'keys'` → `["encrypted_data","encryption_version","lineage","meta","serial"]`. `jq -c '{serial,lineage}'` → the **same lineage**, serial ≥ before.
  5. `tools/scripts/tf.sh <r> plan -lock=false -detailed-exitcode` → same result as before.
- [ ] **Step 3: First real gcp apply (S1b).** The 7 sensitivity-only updates on `module.gcp.google_secret_manager_secret_version.surreal[*]` are accepted (dev only, no real data).
  1. Before: `for s in $(gcloud secrets list --project heisreal-dev --filter='name~/secrets/surreal-' --format='value(name.basename())'); do echo "$s $(gcloud secrets versions list "$s" --project heisreal-dev --format='value(name)' | sort -n | tr '\n' ' ')"; done > /tmp/surreal-versions-before.txt`.
  2. `tools/scripts/tf.sh gcp apply`. The plan must show exactly those 7 updates in place (plus any known image digest change). Nothing else.
  3. After: the same loop into `…-after.txt`. `diff` must print nothing: no new versions were created.
  4. `tools/scripts/tf.sh gcp plan -detailed-exitcode` → exit 0.
- [ ] **Step 4: Readers work.** gcp (reads bootstrap), images and cluster (read gcp) plan with the same exit codes as in Step 2. Trigger "Terraform apply (manual)" → gcp once: its plan job must succeed against encrypted state. Cancel at approval if it shows changes.
- [ ] **Step 5: Old plaintext generations.** Generations from before Step 2 stay plaintext until the 30-day noncurrent lifecycle rule deletes them, plus 7 days of soft delete (about 37 days). Their readers are the same as today, so nothing new is exposed. Note the date in the PR 2 description. It's checked once in Task 13.

---

### Task 10: Pipeline — `tofu-plan.yml`, `tofu-apply.yml`, `tofu-drift.yml`

**Branch:** `git switch -c feat/opentofu-pipeline main` (after L3).

**Files:**
- Create: `tools/scripts/tf-roots.sh`, `tools/scripts/tf-stage.sh`, `tools/scripts/tests/{tf-roots,tf-stage}.test.mjs`
- Create: `.github/actions/tofu/action.yml`, `.github/workflows/{tofu-plan,tofu-apply,tofu-drift}.yml`
- Delete: `.github/workflows/terraform-plan.yml`, `.github/workflows/terraform-apply.yml`
- Modify: `modules/bootstrap/{deploy_gate,cluster_plan_gate}.cel.tftpl` and their tests (drop the `terraform-*.yml` clauses; applied at L5)

**Interfaces:**
- Consumes: `tf.sh` (`plan-summary`, `bunny-mask`), the gates, S6, S12.
- Produces:

  **`tf-roots.sh changed <base> <head>`** prints roots in apply order `gcp images cluster bunny`, then `bootstrap` (notice only). **`tf-roots.sh all`** prints `gcp cluster bunny`; images is never part of "all".

  **`tf-roots.sh pending <target> gcp=<sha|-> cluster=<sha|-> bunny=<sha|-> [force=<root>...]`** prints the roots `tofu-apply.yml` must plan, in apply order:
  - a root is pending if its marker is `-` (missing), isn't an ancestor of `<target>` (`git merge-base --is-ancestor`), or `tf-roots.sh changed <marker> <target>` lists it;
  - each `force=<root>` is added (a finished image release forces gcp; a dispatch forces its input root, the only way to get images);
  - cluster is added whenever gcp is in the list (same rule as `changed`).

  **Markers:** `gs://heisreal-dev-tfstate/applied/{gcp,cluster,bunny}`, each holding the last commit that root was applied at (or planned with no changes). Written by the job that just applied it, or by its plan job when the plan shows no changes. Never moved backwards: write only if the current marker is an ancestor of the new commit. images has no marker (dispatch only).

  | Root | Selected by |
  | --- | --- |
  | gcp | `live/dev/gcp/**`, `modules/gcp/**` |
  | cluster | `live/dev/cluster/**`, `modules/{cluster,db-migration,db-identity}/**`, `infra/k8s/surrealdb/**`, `libs/database/schema/**`, `libs/legal/dpa/**`; also whenever gcp is selected |
  | bunny | `live/dev/bunny/**`, `modules/{bunny,bunny-state-guard}/**` |
  | images | PR plans only: `live/dev/images/**`, `tools/scripts/image-tag.sh`. The apply pipeline runs images only on `workflow_dispatch`. |
  | bootstrap | `live/dev/bootstrap/**`, `modules/bootstrap/**` |
  | gcp, cluster and bunny | `tools/scripts/tf*.sh`, `.github/actions/tofu/**`, `.github/workflows/tofu-*.yml`, `mise.toml` |

  **`tf-stage.sh <prev> <selected> <plan_result> <changes> <apply_result>`** prints `ok` or `blocked: <reason>` (Codex #3):
  - `blocked: upstream` if `prev` isn't `ok`;
  - else `ok` (not selected) if `selected` is `false`;
  - else `blocked: plan <result>` unless `plan_result` is `success`;
  - else `ok` (no changes) if `changes` is `false`;
  - else `ok` only if `apply_result` is `success`; otherwise `blocked: apply <result> (failed, rejected, stale or superseded)`.

  GitHub reports a rejected approval, a stale saved plan and a superseded run all as a failed or cancelled apply job, so the reason names all of them. A blocked root keeps its old marker, so the next run of any trigger plans it again. Any value other than `success` (`failure`, `cancelled`, `skipped`, empty) blocks.

  **Composite action `.github/actions/tofu`:** input `service_account` (empty: no auth). Runs setup-opentofu (pinned SHA, `tofu_version: 1.13.2`, `tofu_wrapper: false`), then `google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3` with the existing provider path.

  **Plan objects:** `gs://heisreal-dev-tfstate/plans/<root>/<run_id>-<attempt>.tfplan` (gcp, images, cluster; tf-deployer) and `gs://heisreal-dev-tfstate/dev/bunny/plans/<run_id>-<attempt>.tfplan` (tf-bunny). All are KMS-encrypted plan files.

  **Bunny raw logs:** `gs://heisreal-dev-tfstate/dev/bunny/logs/<run_id>-<attempt>-<job>.log`. Readable by developers and tf-bunny. Google-managed encryption.

- [ ] **Step 1: Failing tests.**
  - `tf-roots.test.mjs` (temp git repo):
    - `modules/gcp/x.tf` → `gcp\ncluster`; `libs/legal/dpa/v2.md` → `cluster`; `modules/bunny-state-guard/main.tf` → `bunny`; `modules/bootstrap/kms.tf` → `bootstrap`; `tools/scripts/tf.sh` → `gcp\ncluster\nbunny`; `live/dev/images/main.tf` → `images`; `apps/web/x.ts` → empty; gcp + bunny → `gcp\ncluster\nbunny`; `all` → `gcp\ncluster\nbunny`; bad subcommand → exit 64.
    - `pending`: all markers at target → empty; gcp marker one commit behind with a `modules/gcp` change → `gcp\ncluster`; bunny marker behind with only an `apps/` change → empty; marker `-` → that root; marker not an ancestor (rewritten history) → that root; `force=gcp` with all markers current → `gcp\ncluster`; `force=images` → `images`; a cluster change at commit B, then a docs commit C, cluster marker at A, target C → `cluster` (the root isn't lost when a later run has nothing new for it).
  - `tf-stage.test.mjs`:
    - not selected → `ok`;
    - plan `failure` → `blocked: plan failure`;
    - plan `skipped` while selected → blocked;
    - plan `success`, no changes → `ok`;
    - changes, apply `success` → `ok`;
    - changes, apply `failure` (failed, rejected, stale or superseded) → blocked;
    - changes, apply `cancelled` → blocked;
    - changes, apply `skipped` → blocked;
    - prev `blocked: …` → `blocked: upstream`, even if not selected.

  Both FAIL.
- [ ] **Step 2: Implement both scripts.** Tests PASS; `shellcheck` clean.
- [ ] **Step 3: `tofu-plan.yml`** (`pull_request` only; paths: `infra/**`, `libs/database/schema/**`, `libs/legal/**`, `tools/scripts/tf*.sh`, `tools/scripts/image-tag.sh`, `.github/actions/tofu/**`, `.github/workflows/tofu-*.yml`, `mise.toml`). Top-level `permissions: {}`.
  - `validate` (`contents: read`): the old job (fmt, validate 5 roots, `tofu test` of the 3 modules, kubeconform, the dry-run policy test, S11 and key-name checks).
  - `roots` (`contents: read`): `tf-roots.sh changed <base.sha> <head.sha>`.
  - `plan-gcp` (`contents: read, id-token: write`): tf-planner, `-refresh=false -lock=false`.
  - `plan-images` (same): tf-planner, after `pnpm install --frozen-lockfile` and the prune. Only if selected.
  - `plan-cluster` (same): env `cluster-plan`, tf-cluster-planner (D42, unchanged).
  - **No bunny plan, ever.** The summary says: "bunny: planned after merge on main (tofu-apply.yml); bootstrap: plan and apply locally".
  - Fork guard as today (forks get no OIDC token).
- [ ] **Step 4: `tofu-apply.yml`.**
  - Triggers: `push` to main with **no paths filter** (every new `main` gets a run, so a superseded apply always has a successor; a run with nothing pending stops after `roots`); `workflow_run` (`[Release Images]`, completed, main, only when `conclusion == 'success'`); `workflow_dispatch` (input `root`: `pending|gcp|images|cluster|bunny|all`, default `pending`).
  - Top-level `permissions: {}`. Per job: `contents: read` and `id-token: write`.
  - **No concurrency group** (Codex round 3, #2 and #4). A workflow-level group serialises whole runs and cancels a *pending* run when a newer one queues, which can drop roots and lets an old run waiting for approval block newer ones. Instead, safety comes from:
    - plans use `-lock=false`, so runs plan in parallel;
    - applies take the state lock with `-lock-timeout=10m`; OpenTofu refuses a saved plan if the state changed after it was made (stale);
    - the superseded check below;
    - markers, so nothing a cancelled, blocked or rejected run leaves undone is ever lost.
  - Nothing is cancelled automatically. A run in `waiting` can have another job executing (bunny runs in parallel with the gcp chain), so cancelling runs could stop a running apply. An old run left waiting does no harm: if approved, its superseded check refuses it. Reject it, or let GitHub expire it (30 days).
  - **One target commit per run (Codex round 3, #1).** The `roots` job checks out `main` (`ref: main`, `fetch-depth: 0`) and sets `target=$(git rev-parse HEAD)`. That's the `main` HEAD when the run starts, whatever the trigger. `$GITHUB_SHA` and `workflow_run.head_sha` are never used. Every later job checks out `ref: ${{ needs.roots.outputs.target }}` (`fetch-depth: 0`) and prints the target in its summary.
  - **`roots`** (tf-planner, read-only):
    1. Read the three markers (`gcloud storage cat gs://heisreal-dev-tfstate/applied/<root>`; missing → `-`).
    2. Forced roots: `workflow_run` → `force=gcp`; dispatch `<root>` → `force=<root>`; dispatch `all` → force gcp, cluster and bunny; dispatch `pending` and push → none.
    3. `tf-roots.sh pending "$target" gcp=… cluster=… bunny=… force=…`. Output one boolean per root and `target`.
  - **Images on the gcp plan.** `images.auto.tfvars` entries set to `"main"` resolve at plan time to the newest image in `apps` (`data.google_artifact_registry_docker_image.newest`, no tag), not to anything tied to a commit. Release Images pushes only from `main`, so planning at HEAD picks up the newest released image whatever triggered the run. Pinned digests come from `images.auto.tfvars` at the target. If HEAD's own release is still building, the plan uses the previous image, and that release's `workflow_run` later forces gcp again.
  - **Superseded check** (first step of every apply job): `git fetch origin main`; if `origin/main` isn't `target`, fail with `superseded: main is now <sha>; the run for it plans again` (no apply). Strict on purpose: no reasoning about which paths changed. The push that moved `main` started its own run, which recomputes everything pending.
  - **Marker write** (last step of every apply job, and of every plan job whose plan shows no changes): `gcloud storage cat` the current marker; if it's missing or `git merge-base --is-ancestor <current> "$target"`, write `target` to it. bunny's marker is written by tf-bunny, the others by tf-deployer.
  - **Stage gcp: `plan-gcp` → `apply-gcp` → `stage-gcp`.**
    - `plan-gcp` (tf-deployer, only if gcp is selected): `tf.sh gcp init`; `tf.sh gcp plan -input=false -lock=false -detailed-exitcode -out="$RUNNER_TEMP/tfplan" -no-color`, output to the log (gcp and cluster plans hold no secrets). Exit 0: write the marker. Exit 2: upload to the plan object, `changes=true`. Summary: target and `tf.sh gcp plan-summary`.
    - `apply-gcp`: `if: needs.plan-gcp.outputs.changes == 'true'`, `environment: dev` (the one approval), tf-deployer.
      1. Superseded check.
      2. Download the plan, `tf.sh gcp apply -input=false -lock-timeout=10m "$RUNNER_TEMP/tfplan"`, delete the object.
      3. Write the marker.
    - `stage-gcp`: `if: always()`, `needs: [roots, plan-gcp, apply-gcp]`. Runs `tf-stage.sh` with `prev = ok` if `needs.roots.result == 'success'`. Outputs `result`; writes the reason to the summary.
  - **Stage images: `plan-images` → `apply-images` → `stage-images`.**
    - `plan-images` and `apply-images` run only if `needs.stage-gcp.outputs.result == 'ok'` and images is selected (`if: always() && …`).
    - `stage-images` **always runs** (`if: always()`), with `needs: [roots, stage-gcp, plan-images, apply-images]` and `prev = needs.stage-gcp.outputs.result`. "Not selected" gives `ok`, so cluster isn't blocked (Codex #3).
    - **Build once in `plan-images` (Codex #6):** `pnpm install --frozen-lockfile`, the prune, then `tar -cpzf "$RUNNER_TEMP/images-dist.tgz" apps/{api-public-read,api-user,api-admin,workflow,web}/dist`. tar keeps hidden files (`apps/web/dist/apps/web/.next/static`), symlinks and modes; `upload-artifact` would drop `.next`. Upload that one file with `actions/upload-artifact` as `images-dist-${{ github.run_id }}`, `retention-days: 7`. App source is public; the dist holds no secrets.
    - **`apply-images`:**
      1. Superseded check.
      2. `actions/download-artifact`, then `tar -xpzf images-dist.tgz -C "$GITHUB_WORKSPACE"`. No rebuild.
      3. For every service, `tools/scripts/image-tag.sh <svc>` must equal the planned tag from `tf.sh images show -json tfplan | jq -r '.resource_changes[] | select(.address=="terraform_data.image[\"<svc>\"]") | .change.after.triggers_replace.tag'` (images isn't bunny, so `-json` is allowed). Any mismatch fails.
      4. Apply.
    - This is the existing snapshot root (`apps-scratch`, content tags, `apps/<svc>/dist` build context) run in CI on request. Releases to `apps` stay with `images.yml`.
  - **Stage cluster: `plan-cluster` → `apply-cluster` → `stage-cluster`.** Same shape, gated on `needs.stage-images.outputs.result == 'ok'`. tf-deployer.
  - **Stage bunny (independent, parallel): `plan-bunny` → `apply-bunny`.** tf-bunny. Both jobs, in this order:
    1. Checkout; the composite action with `service_account: tf-bunny@heisreal-dev.iam.gserviceaccount.com`.
    2. `tools/scripts/tf.sh bunny-mask secrets` (masks every `bunny-*` secret value, before any tofu step).
    3. `tools/scripts/tf.sh bunny init -input=false > "$RUNNER_TEMP/bunny.log" 2>&1`.
    4. `tools/scripts/tf.sh bunny-mask state` (masks the 5 keys from state; 3 of them exist only there).
    5. plan job (only if bunny is selected): `tf.sh bunny plan -input=false -lock=false -detailed-exitcode -out="$RUNNER_TEMP/tfplan" -no-color >> "$RUNNER_TEMP/bunny.log" 2>&1`; exit 0 → write `applied/bunny`; exit 2 → upload to `dev/bunny/plans/…`. apply job (`environment: dev`): superseded check, download, `tf.sh bunny apply -lock-timeout=10m … >> bunny.log 2>&1`, delete the plan object, write `applied/bunny`.
    6. Always: `gcloud storage cp "$RUNNER_TEMP/bunny.log" gs://heisreal-dev-tfstate/dev/bunny/logs/<run_id>-<attempt>-<job>.log`.
    7. **Nothing from the log is echoed.** The summary and log get only `tf.sh bunny plan-summary` output, the exit code, and `plan failed (exit N), log: gs://heisreal-dev-tfstate/dev/bunny/logs/<file>`.
    - No Bunny file is ever passed to `upload-artifact`.
  - **Approvals:** one per apply with changes, all in `dev`. A merge touching one root asks once. gcp + cluster asks twice. Bunny asks once.
- [ ] **Step 5: `tofu-drift.yml`.** `schedule: '17 6 * * 1'` and `workflow_dispatch` (root: `gcp|cluster|bootstrap|bunny|all`). `permissions: {}`; jobs `contents: read, id-token: write`. Each job runs `plan -lock=false -detailed-exitcode` with a full refresh. Exit 2 fails the job; the summary is `plan-summary` output.
  - gcp and cluster: tf-deployer.
  - bootstrap: tf-planner (ambient in CI), using the bucket read from L1 (S12). If Task 13's S12 re-run fails, remove this job in a follow-up.
  - bunny: tf-bunny, with the bunny job steps above (masking, private log, summary only).
  - images: never (its plan compares local build output).
  - Header comment: a Cloud Run image diff means `main` has an unapproved build.
- [ ] **Step 6: Delete the old workflows; drop the transitional gate clauses.** Delete `terraform-plan.yml` and `terraform-apply.yml`. Remove the `terraform-*.yml` clauses from the two templates and flip those tests to denied. Run `node --test infra/terraform/modules/bootstrap/tests/ tools/scripts/tests/` (includes `workflows.test.mjs`), `tofu -chdir=infra/terraform/modules/bunny-state-guard test` and `actionlint .github/workflows/*.yml`. All clean.
- [ ] **Step 7: Job-graph dry run.** On a test branch, push `tofu-apply-dryrun.yml`: a copy of `tofu-apply.yml` with `workflow_dispatch` only, plan and apply steps replaced by `sleep ${{ inputs.sleep_<job> }}; exit ${{ inputs.fail_<job> }}`, no Google auth, markers in a temp file under `$RUNNER_TEMP` instead of GCS, and the real target and superseded logic against the test branch's HEAD. Apply jobs keep `environment: dev` (harmless without auth) so the timing case can wait. Run these cases and record them in the PR body:
  1. plan-gcp fails → images and cluster blocked;
  2. apply-gcp fails → images and cluster blocked;
  3. gcp not selected, cluster selected → cluster runs;
  4. gcp no changes → cluster runs;
  5. **timing (Codex round 3, #4):** start run A with `sleep_plan_gcp=90`; while A is still planning, push a commit to the test branch and start run B. Expected: B plans and reaches its approval without waiting for A; A reaches its approval later; approving A fails with `superseded`; approving B applies.

  A real rejected approval is checked in Task 13. Delete the test branch afterwards.
- [ ] **Step 8: Commit and open PR 2.**
```bash
git add .github tools/scripts infra/terraform
git commit -S -m "feat(ci): merge, plan, approve, apply: OpenTofu pipeline with encrypted saved plans and weekly drift (D54, D57)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Enforce encryption (PR 2)

**Files:** modify `infra/terraform/live/dev/*/encryption.tf`.

- [ ] **Step 1: Precondition.** For all five objects, `gcloud storage cat gs://heisreal-dev-tfstate/dev/<r>/default.tfstate | jq -e 'has("encrypted_data")'` must print `true`. If not, go back to Task 9.
- [ ] **Step 2: Remove the fallback.** Delete `method "unencrypted" "migration"` and every `fallback`, and add `enforced = true` to `state` and `plan`. `git grep -n unencrypted infra/terraform` must print nothing.
- [ ] **Step 3: Verify.** Local plans of all five roots (bunny as tf-bunny; it works from any branch) give the same exit codes as Task 9. A saved plan isn't a zip: `file "$RUNNER_TEMP/p"` must not say `Zip archive`.
- [ ] **Step 4: Commit.**
```bash
git commit -S -am "feat(infra): enforce encrypted state and plans in every root (D54)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs — AGENTS.md, infra README (with break-glass runbook), root README, delivery status

**Files:** `AGENTS.md`, `infra/terraform/README.md`, `README.md`, `docs/delivery-status.md`, `docs/db-permissions.md`, `infra/k8s/surrealdb/README.md`, `infra/clerk/README.md`, and tool-name comments in `infra/**`, `libs/**`, `apps/**`, `tools/**`.

**AGENTS.md changes, by PR:**
- PR 1 (done in Tasks 3 and 4): `tf.sh` replaces `tf-bunny.sh` and the "Moving to OpenTofu" line; the gitleaks hook install line.
- PR 2 (this task): the final text below. It shortens the Bunny exception and documents `tf.sh`, the approval meaning, public logs with masking, and the hook.

- [ ] **Step 1: AGENTS.md.** Replace the two infra bullets (and the hook line from Task 4) with exactly:
```markdown
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
```
- [ ] **Step 2: `infra/terraform/README.md`.** It must contain:
  - Layout and identity table (tf-planner, tf-cluster-planner, tf-deployer, tf-bunny, the two image pushers) with what each can reach. A plain note: "tf-deployer could grant itself access to Bunny through its service-account roles. That's accepted (D57)."
  - `tf.sh` usage, including `plan-summary`, `bunny-cli` and `bunny-mask`.
  - CI table: tofu-plan, tofu-apply (approval rule: one per apply), tofu-drift (which roots and why), images and snapshot-images. How a run picks its target and roots (markers under `applied/`), the superseded check, and why there's no concurrency group. "A run ended blocked: re-run it, or dispatch `pending`."
  - D42, renamed to `tofu-plan.yml`.
  - Bunny.net: `tf.sh bunny`/`bunny-cli`, saved plans encrypted, raw logs under `dev/bunny/logs/` (cleanup after 7 days; about 14 days with versioning and soft delete), the never-public guard, `check-bunny-fences.sh`.
  - "Bootstrapping a new environment": first apply without `encryption.tf`, then add it with the fallback, apply `-refresh-only`, then enforce.
  - "Encryption": two keys, who can use them, never disable or destroy, rotation keeps old versions.
  - **"Break-glass: recover a KMS key version"**, the text in the section below this task list.
- [ ] **Step 3: Root README, delivery status and sweep.** README rows name OpenTofu and the three workflows. The D54 row moves to the implemented table; add D57 (C) with a link to its decision record; decision 3 says OpenTofu; add a changelog line. Then:
  - `git grep -n -i -w terraform -- . ':!*.lock.hcl' ':!docs/superpowers' | grep -v -E 'terraform_(remote_state|data)|terraform \{|infra/terraform|\.terraform|tftest|D54|Terraform \(0\.7\)|2026-10-(0|1|20|21)'` → nothing.
  - `git grep -n -E 'setup-terraform|terraform-(plan|apply)\.yml|tf-bunny\.sh|bunny_fences|state_condition'` → nothing.
- [ ] **Step 4: Format, commit, mark PR 2 ready.**
```bash
pnpm nx format:check
git add -A AGENTS.md README.md docs infra tools .github libs apps
git commit -S -m "docs: OpenTofu rules, approvals, public-log hygiene and KMS break-glass (D54, D57)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push && gh pr ready
```

---

### Task 13: [LIVE, L4 + L5] Merge PR 2 and clean up

- [ ] **Step 1 [L4]: Merge PR 2 and watch the merge run.** No markers exist yet, so gcp, cluster and bunny are all pending and planned. Afterwards `gcloud storage ls gs://heisreal-dev-tfstate/applied/` lists `gcp`, `cluster` and `bunny`, each holding the merge commit. Expected: every plan runs without waiting; gcp, cluster and bunny say "No changes" and ask for no approval. The bunny summary shows only addresses and counts.
- [ ] **Step 2 [L5]: Apply bootstrap from `main`.** Expected plan: only `attribute_mapping` changes (old clauses gone). Then `tf.sh bootstrap plan -detailed-exitcode` → 0 and `check-bunny-fences.sh` → exit 0.
- [ ] **Step 3 [L5, GitHub]:** cancel old waiting runs: `gh run list --workflow terraform-apply.yml --status waiting --json databaseId --jq '.[].databaseId' | xargs -r -n1 gh run cancel`. Then remove `hashicorp/setup-terraform@*` from the allowlist (Task 3 Step 1's command without it). Expected `--jq .patterns_allowed`: four patterns.
- [ ] **Step 4: Re-run S12 for the bootstrap drift job.** Run "OpenTofu drift" by hand with root `bootstrap`. Exit 0 or a list of addresses you recognise → keep the job. A permission error → remove the job in a follow-up PR and update the README.
- [ ] **Step 5: Drift and end-to-end.** Run "OpenTofu drift" with `all`. Make one trivial gcp change through a PR. On merge, reject `apply-gcp` once: `stage-gcp` says `blocked: apply failure …` and `plan-cluster` is skipped. Re-run, approve once: `Apply complete!`, and the plan object is deleted.
- [ ] **Step 6: Plaintext expiry check.** On the date noted in Task 9 Step 5: `gcloud storage ls -a 'gs://heisreal-dev-tfstate/dev/**/default.tfstate'` lists only generations written after Task 9, and `gcloud storage ls --soft-deleted -r gs://heisreal-dev-tfstate/dev/` lists none older. Record the result in `docs/delivery-status.md`.
- [ ] **Step 7 (optional):** `sudo pacman -R terraform` on Joel's machine.

---

## Break-glass: recover a KMS key version

This is the only change allowed outside OpenTofu (Clerk config is the other standing exception). Key versions aren't OpenTofu resources, so there's nothing to import.

**When:** a version of `tofu-state` or `tofu-bunny` is `DESTROY_SCHEDULED` (you have 120 days) or `DISABLED`. Symptom: plans fail with a KMS decrypt error.

**Who:** a developer (project owner; `roles/owner` holds `cloudkms.cryptoKeyVersions.restore` and `.update`). Tell Joel first.

**Steps:**
1. Find the version:
```bash
gcloud kms keys versions list --key tofu-state --keyring tofu --location europe-west2 --project heisreal-dev \
  --format='table(name.basename(),state,destroyTime)'
```
2. If it is `DESTROY_SCHEDULED`, restore it. A restored version comes back `DISABLED`:
```bash
gcloud kms keys versions restore <v> --key <key> --keyring tofu --location europe-west2 --project heisreal-dev
```
3. Enable it (also the fix for a plain `DISABLED` version):
```bash
gcloud kms keys versions enable <v> --key <key> --keyring tofu --location europe-west2 --project heisreal-dev
```
4. Confirm there is no drift: `tools/scripts/tf.sh bootstrap plan -detailed-exitcode` → 0, then plan every root (`tf.sh <r> plan -lock=false -detailed-exitcode`, bunny as tf-bunny) with the same results as before.
5. Record what happened and why in `docs/delivery-status.md`.

Anything else (key IAM, key settings, a key dropped from config) goes through OpenTofu: fix the code and apply bootstrap. A key removed from config is only forgotten (`skip_destroy`); adopt it again with an `import` block. A corrupted state object is restored from its previous generation (Task 9 Step 2.1).

---

## Spike findings (Task 1, 2026-10-22; S13–S15 added in this revision; not committed)

| # | Question | Finding | Used by |
| --- | --- | --- | --- |
| S1 | tofu reads 1.15.9 state; plans equal Terraform's; fields dropped? | Rerun 2026-10-22. tofu reads all five 1.15.9 states. bootstrap, cluster, bunny: `No changes.` in both tools. images: identical to Terraform apart from the product name (5 add / 4 destroy, new prune tags). gcp: Terraform `No changes.`, tofu 7 sensitivity-only updates (accepted, see S1b). bootstrap `apply -refresh-only` on the local copy: lineage unchanged, serial 70→71. Provider addresses rewritten `registry.terraform.io`→`registry.opentofu.org`. `identity_schema_version` removed only on the 3 instances that have no `identity` (identity data kept on all 59). Per-instance attribute key sets, `identity` and `sensitive_attributes` are identical. Value changes are only refreshed `etag`/`updated` and `null`→`{}` for `annotations`/`version_aliases`. **No attributes dropped** | 3, 9 |
| S1b | gcp sensitivity-only diff (accepted 2026-10-22: dev only, no real data) | Exactly 7 changes, all `module.gcp.google_secret_manager_secret_version.surreal[*]`, all `["update"]`, `before == after`, no unknowns, no replacements. The only delta is `before_sensitive {secret_data}` → `after_sensitive {secret_data, secret_data_wo}`. Refresh-only apply does **not** clear it. Provider v8.5.0 Update finds no `HasChange` and only calls Read; it never adds a version (`addVersion` happens only in Create). **Verify after the first real gcp apply with `gcloud secrets versions list` that no version was added (Task 9 Step 3).** | 9 |
| S2 | Providers on registry.opentofu.org at locked versions; lock method | All present at the pinned versions. All signed except kbst/kustomization 0.9.8 ("signature validation was skipped": no GPG keys in the registry); pin it by lock-file hashes and match its h1 with Terraform's signed lock (Task 3 Step 4). A plain `tofu init` (lock deleted) writes h1 and zh hashes for every platform | 3 |
| S3 | `fmt`/`validate`/`test` clean | `fmt` and `validate` clean. `test`: bunny-state-guard 6/6; **db-migration (2 pass, 1 fail, 6 skip) and db-identity (1 pass, 1 fail, 4 skip) fail**: tofu rejects `run.<name>.<output>` in `assert`. Workaround proven in a repro: `command = apply` in the referenced run, pass the value through the later run's `variables {}`, assert on `var.<x>`. Task 3 Step 5 | 3 |
| S4 | Env vars honoured | gcs backend and `gcp_kms` honour `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` (`GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT` wins if set). **gcloud ignores it**; it needs `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT`. `tf.sh` exports both and unsets the backend one | 2 |
| S5 | KMS calls per run | `Provide()` always calls `Encrypt`, and `Decrypt` when reading. Every reader needs EncrypterDecrypter | 5 |
| S6 | Remote state decrypts; validate without credentials | `remote_state_data_sources.default` decrypts. `init -backend=false && validate` passes with no credentials, **but doesn't evaluate the encryption block** (typos and `key_length = 0` pass). Test encryption with plans against the real backend (Task 8 Step 4) | 8 |
| S7 | Forcing an encrypted rewrite | `apply -refresh-only` writes encrypted state even with no changes. Top-level keys: `encrypted_data`, `encryption_version`, `lineage`, `meta`, `serial` (`lineage` and `serial` stay readable). Lineage unchanged; serial kept or +1 | 9 |
| S8 | `TF_ENCRYPTION` overrides code | It **replaces** the code's config: from a plaintext copy it wrote plaintext. `tf.sh` unsets it | 2 |
| S9 | setup-opentofu v2.0.2 SHA | `a1320f892987e89d278cc92dc5adc984fb93aca4` (matches) | 3, 10 |
| S10 | Dependabot `opentofu` | Supported for version updates only, not security updates | 3 |
| S11 | Bunny key attributes sensitive | All 5 are `sensitive: true` in bunnynet 0.19.2 | 2, 8 |
| S12 | bootstrap plan as tf-planner | The budget refreshes fine. The plan fails on `google_storage_bucket.tfstate` with 403 on `storage.buckets.get`. Fix: tf-planner gets `roles/storage.bucketViewer` on the state bucket (Task 5 Step 5); re-checked by Task 13 Step 4. *(Corrected 2026-10-22: the earlier note that `roles/iam.securityReviewer` includes `storage.buckets.get` and `secretmanager.secrets.get` was wrong, see S13.)* | 5, 10, 13 |
| S13 | What `roles/iam.securityReviewer` holds (gcloud, 2026-10-22) | Holds `storage.buckets.getIamPolicy`, `storage.buckets.list`, `secretmanager.secrets.list`, `secretmanager.secrets.getIamPolicy`, `secretmanager.versions.list`, `cloudkms.keyRings.getIamPolicy`, `cloudkms.cryptoKeys.getIamPolicy`, `resourcemanager.projects.getIamPolicy`, `iam.roles.get`. Does **not** hold `storage.buckets.get` or `secretmanager.secrets.get`. Enough for the never-public guard | 5, 6 |
| S14 | Data sources for the guard in google 8.7.0 | `google_secret_manager_secrets` (attrs `filter`, `project`, `secrets`), `google_secret_manager_secret_iam_policy`, `google_kms_key_ring_iam_policy`, `google_kms_crypto_key_iam_policy`, `google_storage_bucket_iam_policy` all exist (`tofu providers schema`, 2026-10-22) | 6 |
| S15 | Repo and tools (2026-10-22) | Repo public. Secret scanning and push protection on; non-provider patterns off. Fork PR approval `all_external_contributors`. Allowlist has 4 patterns (no setup-opentofu yet). `dev` env: reviewers team `developers` (id 19750209), protected branches. `cluster-plan` env: reviewer Stegi56. gitleaks v8.30.1 linux_x64 SHA-256 `551f6fc8…f2470eb`. `gitleaks-action` needs a licence for organisations. `roles/owner` includes KMS encrypt/decrypt/destroy/restore | 4, 13 |
| — | `lifecycle { destroy = false }` in 1.13.2 | Yes: managed-resource lifecycle attribute, stored as `skip_destroy` | 5, 7 |
| — | State bucket soft delete | 604800 s | 9 |

## Codex round 2 findings: where they went

| # | Finding | Status |
| --- | --- | --- |
| 1 | L1 gives tf-deployer a temporary path to the Bunny key | Gone as a finding: under D57 C the path is permanent and accepted |
| 2 | Selective rollback could delete the 5 app SAs | Gone: the app SAs stay in gcp |
| 3 | A skipped images stage blocks cluster | Fixed: stage-result jobs always run; `tf-stage.sh` separates not-selected and no-changes from failed, rejected, stale and superseded (Task 10) |
| 4 | Impersonator guard rejects existing service agents | Gone: no impersonator guard |
| 5 | Org role lacks `iam.roles.get` | Gone: no org root; tf-bunny has no org permission |
| 6 | `upload-artifact` drops `.next` | Fixed: tar before upload, untar after download (Task 10) |
| 7 | retire-stale can't run inside the concurrency group | Replaced in round 3: no concurrency group and no retirement at all (see below) |

**Codex round 3**

| # | Finding | Fix |
| --- | --- | --- |
| 1 | On `workflow_run`, `$GITHUB_SHA` (main HEAD) and the checked-out `head_sha` differ, so the superseded check compared the wrong commits | One target per run: `main` HEAD resolved in `roots`, used by every checkout and check; strict `origin/main == target` before apply (Task 10 Step 4) |
| 2 | The concurrency group cancels pending runs, so roots of a cancelled push are lost; a docs push could retire a waiting bunny run | No concurrency group, no retirement. Per-root markers under `applied/`; every run of every trigger plans all roots behind its target (`tf-roots.sh pending`) |
| 3 | Adding `"bunny"` to the Token Creator `setproduct` makes a second deployer grant | Explicit `planner/deployer/bunny` map with unchanged keys; plan and Task 7 check exactly one new grant on tf-bunny (Task 5 Step 4, Task 7 Step 2) |
| 4 | Retirement misses runs that reach "waiting" later; an obsolete waiting run blocks newer ones | No concurrency group, so nothing blocks; obsolete approvals fail the superseded check; nothing is auto-cancelled (never stops an executing apply); timing case in the dry run (Task 10 Step 7) |
| 5 | 4 of 5 real Bunny keys are 41-character hex 8-4-4-12-4-4, not UUIDs | Regex accepts both shapes; fixtures for both, including `bunny="…"` labels (Task 4 Steps 4–5) |
| 8 | Raw Bunny logs recoverable beyond 7 days | Not doing (founder): the 7-day rule is cleanup only; the README states about 14 days |

## Self-review

1. **Spec coverage:**
   - OpenTofu everywhere: Tasks 3, 10–13.
   - KMS for state and plans: Tasks 5, 8, 9, 11.
   - Local and CI: Task 2; CI for gcp, images (dispatch), cluster and bunny (main only). Bootstrap local by rule, drift-planned in CI.
   - Merge → unattended plan → one approval → apply the saved plan: Task 10.
   - D57 C: tf-bunny and its gate (Task 5), never-public guard (Task 6), no fence work.
   - Hygiene: Task 4 (gitignore, gitleaks, permissions); masking and summaries: Tasks 2 and 10.
   - Break-glass: its own section; copied to the README in Task 12.
   - Drift: Tasks 10 and 13.
2. **Live order:** L0 → L1 → L2 → L3 → L4 → L5, each keeping `main` working. The one exception (bunny plans from `main` refuse between L1 and L2) is explained, with an alternative.
3. **Consistency:** `tf.sh` (5 roots, `plan-summary`, `bunny-cli`, `bunny-mask`), `tf-roots.sh`, `tf-stage.sh`, environments `dev` and `cluster-plan`, and object paths are named the same across tasks.
4. **Proportion:** code appears only for the encryption config, `.gitleaks.toml`, the CI gitleaks step and the AGENTS.md copy.

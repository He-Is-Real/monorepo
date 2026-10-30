# The D14 migration bundle and the Job that applies it, as plain values (no providers, so
# `terraform test` runs offline). The cluster module applies the two manifests.
#
# Bundle = every *.surql in the schema directory and its data/ directory (flattened: ConfigMap
# keys can't contain "/"), the runner (migrate.py) and params.json, the values the runner binds
# as SurrealQL parameters.
# Nothing is templated into the files. The Job and its ConfigMap are named after a hash of the
# bundle and the Job spec, so any change gives new names (Terraform replaces the Job, which runs
# again) and no change gives no diff. scripts/local-migration.mjs builds the same bundle locally.

terraform {
  required_version = ">= 1.11"
}

variable "schema_dir" {
  description = "libs/database/schema."
  type        = string
}

variable "dpa_dir" {
  description = "libs/legal/dpa: one <dpaVersion id>.md per DPA version (D20). The consent forms are beside it, in ../forms/<signup|testimony|social>/<id>.md (D84, D93)."
  type        = string
}

variable "clerk_jwt_public_key" {
  description = "Clerk's RS256 PEM public key, or \"\" until Clerk is set up (no person sessions then)."
  type        = string
  default     = ""
  validation {
    condition = var.clerk_jwt_public_key == "" || (
      startswith(trimspace(var.clerk_jwt_public_key), "-----BEGIN PUBLIC KEY-----") &&
      endswith(trimspace(var.clerk_jwt_public_key), "-----END PUBLIC KEY-----") &&
      !strcontains(var.clerk_jwt_public_key, "PRIVATE")
    )
    error_message = "clerk_jwt_public_key must be a PEM public key (-----BEGIN PUBLIC KEY-----), or empty."
  }
}

variable "seed_dev_story" {
  description = "Seed 0003's walking-skeleton story (test content, M0 0.9). Retired in M1 step 4 (D49: the dev-seed Job loads dummy data); kept for tests and local runs. Off, the script records itself as applied and writes nothing."
  type        = bool
  default     = false
}

variable "environment" {
  description = "The environment this database belongs to (\"dev\", \"prod\", ...; modules/cluster derives it from the GCP project). null = unknown, which is never dev."
  type        = string
  default     = null
}

variable "dev_consent_relaxed" {
  description = "D48: relax consent checks for dummy data. The runner writes it to _setting:consent, which the database's consent functions read. Dev only: refused here unless environment is \"dev\", and by the database too."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.dev_consent_relaxed || var.environment == "dev"
    error_message = "dev_consent_relaxed (D48) can only be set in dev."
  }
}

variable "dev_legal_placeholders" {
  description = "D75: dev's placeholder privacy document and consent forms (data script 0005). The runner writes it to _setting:consent; the database counts the placeholders only while it's on. Dev only: refused here unless environment is \"dev\", and by the database too."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.dev_legal_placeholders || var.environment == "dev"
    error_message = "dev_legal_placeholders (D75) can only be set in dev."
  }
}

variable "extra_system_users" {
  description = "System users besides backup and migrator that SurrealDB's startup init creates (D49: dev_seed, in dev only). The Job waits for exactly these (MIGRATE_EXPECT_USERS)."
  type        = list(string)
  default     = []
  nullable    = false
  validation {
    condition     = alltrue([for u in var.extra_system_users : can(regex("^[a-z][a-z0-9_]*$", u)) && !contains(["backup", "migrator"], u)])
    error_message = "extra_system_users are other lowercase user names."
  }
}

variable "identity_hash" {
  description = "The identity config SurrealDB must have restarted with (modules/db-identity) before the Job migrates; null = don't wait for one."
  type        = string
  default     = null
}

variable "job_template" {
  description = "The rendered surrealdb-migrate Job from the Kustomize overlay (decoded)."
  type        = any
}

locals {
  top_files  = fileset(var.schema_dir, "*.surql")
  data_files = fileset("${var.schema_dir}/data", "*.surql")

  # Every DPA text, keyed by its dpaVersion id (0001, 0005 and dpa-sync.surql use it), with its
  # words: the database keeps a copy beside the ledger (D84).
  dpa_sha256 = { for f in fileset(var.dpa_dir, "*.md") : trimsuffix(f, ".md") => filesha256("${var.dpa_dir}/${f}") }
  dpa_text   = { for f in fileset(var.dpa_dir, "*.md") : trimsuffix(f, ".md") => file("${var.dpa_dir}/${f}") }

  # D84: every consent form version's text and sha256, { signup|testimony|social: { <id>: ... } }
  # (0005 and form-sync.surql). README.md files aren't versions.
  forms_dir   = "${dirname(var.dpa_dir)}/forms"
  form_kinds  = ["signup", "testimony", "social"]
  form_files  = { for k in local.form_kinds : k => [for f in fileset("${local.forms_dir}/${k}", "*.md") : f if f != "README.md"] }
  form_sha256 = { for k in local.form_kinds : k => { for f in local.form_files[k] : trimsuffix(f, ".md") => filesha256("${local.forms_dir}/${k}/${f}") } }
  form_text   = { for k in local.form_kinds : k => { for f in local.form_files[k] : trimsuffix(f, ".md") => file("${local.forms_dir}/${k}/${f}") } }
  # D114: each version's boxes, libs/legal/forms/<kind>/<id>.statements.json, decoded and with
  # the file's sha256 (form-sync.surql; evidence v3 covers the hash).
  statement_files        = { for k in local.form_kinds : k => fileset("${local.forms_dir}/${k}", "*.statements.json") }
  form_statements        = { for k in local.form_kinds : k => { for f in local.statement_files[k] : trimsuffix(f, ".statements.json") => jsondecode(file("${local.forms_dir}/${k}/${f}")) } }
  form_statements_sha256 = { for k in local.form_kinds : k => { for f in local.statement_files[k] : trimsuffix(f, ".statements.json") => filesha256("${local.forms_dir}/${k}/${f}") } }

  # D121: the legal documents' repo files: the privacy policy's PDFs of record beside its texts
  # (libs/legal/dpa/<id>.pdf) and the terms of use (libs/legal/terms/<id>.md and .pdf), for
  # data 0007 and dpa-sync. Sizes from the base64 length.
  terms_dir = "${dirname(var.dpa_dir)}/terms"
  dpa_pdf = { for f in fileset(var.dpa_dir, "*.pdf") : trimsuffix(f, ".pdf") => {
    pdfSha256 = filesha256("${var.dpa_dir}/${f}")
    pdfSize = (length(filebase64("${var.dpa_dir}/${f}")) / 4 * 3
    -(endswith(filebase64("${var.dpa_dir}/${f}"), "==") ? 2 : endswith(filebase64("${var.dpa_dir}/${f}"), "=") ? 1 : 0))
  } }
  terms_text = { for f in fileset(local.terms_dir, "*.md") : trimsuffix(f, ".md") => file("${local.terms_dir}/${f}") }
  terms_pdf = { for f in fileset(local.terms_dir, "*.pdf") : trimsuffix(f, ".pdf") => {
    pdfSha256 = filesha256("${local.terms_dir}/${f}")
    pdfSize = (length(filebase64("${local.terms_dir}/${f}")) / 4 * 3
    -(endswith(filebase64("${local.terms_dir}/${f}"), "==") ? 2 : endswith(filebase64("${local.terms_dir}/${f}"), "=") ? 1 : 0))
  } }

  params = {
    clerk_jwt_public_key   = var.clerk_jwt_public_key == "" ? null : var.clerk_jwt_public_key
    dev_consent_relaxed    = var.dev_consent_relaxed
    dev_legal_placeholders = var.dev_legal_placeholders
    dpa_sha256             = local.dpa_sha256
    dpa_text               = local.dpa_text
    form_sha256            = local.form_sha256
    form_text              = local.form_text
    form_statements        = local.form_statements
    form_statements_sha256 = local.form_statements_sha256
    dpa_pdf                = local.dpa_pdf
    terms_text             = local.terms_text
    terms_pdf              = local.terms_pdf
    environment            = var.environment
    identity_hash          = var.identity_hash
    seed_dev_story         = var.seed_dev_story
  }

  bundle = merge(
    { for f in local.top_files : f => file("${var.schema_dir}/${f}") },
    { for f in local.data_files : f => file("${var.schema_dir}/data/${f}") },
    { "migrate.py" = file("${var.schema_dir}/migrate.py"), "params.json" = jsonencode(local.params) },
  )

  # jsonencode sorts object keys, so the hash depends on content only.
  hash = substr(sha256(jsonencode({ bundle = local.bundle, job = var.job_template, extra_system_users = var.extra_system_users })), 0, 10)

  config_map_name = "surrealdb-migration-${local.hash}"
  job_name        = "surrealdb-migrate-${local.hash}"

  template_spec = var.job_template.spec.template.spec

  # MIGRATE_EXPECT_USERS: the template's users plus the extra ones, sorted.
  containers = [
    for c in local.template_spec.containers : can(c.env) ? merge(c, {
      env = [
        for e in c.env :
        e.name == "MIGRATE_EXPECT_USERS" ? merge(e, { value = join(",", sort(distinct(concat(split(",", e.value), var.extra_system_users)))) }) : e
      ]
    }) : c
  ]
}

output "hash" {
  value = local.hash
}

output "job_name" {
  value = local.job_name
}

output "params" {
  description = "What the runner gets (all public: hashes, the legal texts and a public key)."
  value       = local.params
}

output "config_map" {
  value = {
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata = {
      name      = local.config_map_name
      namespace = var.job_template.metadata.namespace
      labels    = try(var.job_template.metadata.labels, {})
    }
    immutable = true
    data      = local.bundle
  }

  precondition {
    condition     = alltrue([for f in local.data_files : can(regex("^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\\.surql$", f))])
    error_message = "Data scripts are named NNNN-lowercase-words.surql."
  }
  precondition {
    condition     = length(setintersection(local.top_files, local.data_files)) == 0
    error_message = "A data script has the same name as a top-level schema file."
  }
  precondition {
    condition     = length(local.data_files) == length(distinct([for f in local.data_files : substr(f, 0, 4)]))
    error_message = "Two data scripts share a number."
  }
  precondition {
    condition     = length(jsonencode(local.bundle)) < 900000
    error_message = "The migration bundle is close to the 1 MiB ConfigMap limit."
  }
}

output "job" {
  value = merge(var.job_template, {
    metadata = merge(var.job_template.metadata, { name = local.job_name })
    spec = merge(var.job_template.spec, {
      template = merge(var.job_template.spec.template, {
        spec = merge(local.template_spec, {
          containers = local.containers
          volumes = [
            for v in local.template_spec.volumes :
            v.name == "migration" ? merge(v, { configMap = merge(v.configMap, { name = local.config_map_name }) }) : v
          ]
        })
      })
    })
  })

  precondition {
    condition     = length([for v in local.template_spec.volumes : v if v.name == "migration"]) == 1
    error_message = "The surrealdb-migrate Job template needs exactly one volume named \"migration\"."
  }
}

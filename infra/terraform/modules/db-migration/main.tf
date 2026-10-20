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
  description = "libs/legal/dpa: one <dpaVersion id>.md per DPA version (D20)."
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

variable "job_template" {
  description = "The rendered surrealdb-migrate Job from the Kustomize overlay (decoded)."
  type        = any
}

locals {
  top_files  = fileset(var.schema_dir, "*.surql")
  data_files = fileset("${var.schema_dir}/data", "*.surql")

  params = {
    clerk_jwt_public_key = var.clerk_jwt_public_key == "" ? null : var.clerk_jwt_public_key
    dpa_v1_sha256        = fileexists("${var.dpa_dir}/v1.md") ? filesha256("${var.dpa_dir}/v1.md") : null
    legacy_sha256        = fileexists("${var.dpa_dir}/legacy-squarespace.md") ? filesha256("${var.dpa_dir}/legacy-squarespace.md") : null
  }

  bundle = merge(
    { for f in local.top_files : f => file("${var.schema_dir}/${f}") },
    { for f in local.data_files : f => file("${var.schema_dir}/data/${f}") },
    { "migrate.py" = file("${var.schema_dir}/migrate.py"), "params.json" = jsonencode(local.params) },
  )

  # jsonencode sorts object keys, so the hash depends on content only.
  hash = substr(sha256(jsonencode({ bundle = local.bundle, job = var.job_template })), 0, 10)

  config_map_name = "surrealdb-migration-${local.hash}"
  job_name        = "surrealdb-migrate-${local.hash}"

  template_spec = var.job_template.spec.template.spec

  # Data scripts the runner will hold back (with every later one) because a parameter they use
  # is null; same rule as migrate.py.
  held_back = sort([
    for f in local.data_files : trimsuffix(f, ".surql")
    if anytrue([for p, v in local.params : v == null && can(regex(format("\\$%s\\b", p), local.bundle[f]))])
  ])
}

output "hash" {
  value = local.hash
}

output "job_name" {
  value = local.job_name
}

output "params" {
  description = "What the runner gets (all public: hashes and a public key)."
  value       = local.params
}

output "held_back" {
  value = local.held_back
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

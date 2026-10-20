# SurrealDB's identity config (D13 B) as plain values (no providers; `terraform test` offline).
#
# The init script (base/init.surql.tmpl, rendered by External Secrets Operator into a Secret)
# runs at SurrealDB's startup (--import-file). Everything that can change it is hashed: the
# template, the ExternalSecret definitions (which secrets go in) and the rotation number from the
# gcp root. The hash names the template ConfigMap, the ExternalSecret and its target Secret
# (surrealdb-init-<hash>) and is stamped on the StatefulSet's pod template, so a change:
#   * restarts SurrealDB, which ends every open session (removing a user doesn't, on 3.2.4);
#   * can only start once ESO has rendered the NEW Secret: the pod mounts it by name, so it can
#     never run a stale script that happened to satisfy the mount (review P1-3);
#   * writes an identity marker as the script's last statement (inside its transaction, in place
#     of the `-- @identity-marker` line), and gives the identity-check sidecar the expected hash
#     (Secret key identity-hash); the sidecar verifies the intended credentials and records it,
#     and the migrate Job waits for that.
# No secret value passes through here: only the template and secret *names*.

terraform {
  required_version = ">= 1.11"
}

variable "template" {
  description = "Contents of infra/k8s/surrealdb/base/init.surql.tmpl."
  type        = string
}

variable "external_secrets" {
  description = "Contents of infra/k8s/surrealdb/overlays/gke/externalsecrets.yaml (secret names only)."
  type        = string
}

variable "rotation" {
  description = "The gcp root's secret_rotation: a new password version means a new init Secret."
  type        = string
}

variable "config_map" {
  description = "The rendered surrealdb-init-template ConfigMap (decoded)."
  type        = any
}

variable "external_secret" {
  description = "The rendered surrealdb-init ExternalSecret (decoded)."
  type        = any
}

locals {
  hash = substr(sha256(jsonencode({
    template         = var.template
    external_secrets = var.external_secrets
    rotation         = var.rotation
  })), 0, 10)
  secret_name   = "surrealdb-init-${local.hash}"
  template_name = "surrealdb-init-template-${local.hash}"
  sentinel      = "-- @identity-marker"
  marker        = "UPSERT _identity:current SET hash = ${jsonencode(local.hash)}, appliedAt = time::now();"
  es            = var.external_secret
  script        = var.config_map.data["init.surql"]
}

output "hash" {
  value = local.hash
}

output "secret_name" {
  value = local.secret_name
}

output "config_map" {
  value = merge(var.config_map, {
    metadata  = merge(var.config_map.metadata, { name = local.template_name })
    immutable = true
    data      = { "init.surql" = replace(local.script, local.sentinel, local.marker) }
  })

  precondition {
    condition     = length(split(local.sentinel, local.script)) == 2
    error_message = "init.surql.tmpl must contain the line `-- @identity-marker` exactly once (inside its transaction, last)."
  }
}

output "external_secret" {
  value = merge(local.es, {
    metadata = merge(local.es.metadata, { name = local.secret_name })
    spec = merge(local.es.spec, {
      target = merge(local.es.spec.target, {
        name = local.secret_name
        template = merge(local.es.spec.target.template, {
          data = merge(try(local.es.spec.target.template.data, {}), { "identity-hash" = local.hash })
          templateFrom = [
            for t in local.es.spec.target.template.templateFrom :
            merge(t, { configMap = merge(t.configMap, { name = local.template_name }) })
          ]
        })
      })
    })
  })

  precondition {
    condition     = length(local.es.spec.target.template.templateFrom) == 1
    error_message = "The surrealdb-init ExternalSecret must render exactly one template (the init script)."
  }
}

# Strategic-merge patch for the overlay: mount the new Secret and restart the pod.
output "statefulset_patch" {
  value = yamlencode({
    apiVersion = "apps/v1"
    kind       = "StatefulSet"
    metadata   = { name = "surrealdb" }
    spec = {
      template = {
        metadata = { annotations = { "heisreal.today/identity-config" = local.hash } }
        spec     = { volumes = [{ name = "init", secret = { secretName = local.secret_name } }] }
      }
    }
  })
}

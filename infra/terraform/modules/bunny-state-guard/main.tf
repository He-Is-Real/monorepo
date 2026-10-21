# Who could read the bunny root's state through an inherited grant (no providers; `terraform
# test` offline). A project- or organisation-level role with storage.objects.get reads every
# bucket, whatever the bucket's own policy says. Allowed: the developers, and an EXPLICIT list of
# verified Google service agents (Google-managed; you can't use them directly). Nothing in the
# project's own `<project-id>.iam.gserviceaccount.com` domain is ever exempt: user-managed service
# accounts live there, and any account ID (even `service-123`) can be chosen. Everyone else's
# roles are expanded by the caller (role_permissions) and checked, conditions or not. A role
# missing from role_permissions counts as a reader (fail closed), and so does a new, unlisted
# service agent: review it, then add it to service_agents.

terraform {
  required_version = ">= 1.11"
}

variable "project_id" {
  type = string
}

variable "bindings" {
  description = "Project and organisation IAM bindings (role, members; conditions are ignored, i.e. treated as granting)."
  type        = any
}

variable "state_readers" {
  description = "Developers: principals allowed to read state."
  type        = list(string)
}

variable "service_agents" {
  description = "Verified Google service agents allowed to hold storage.objects.get, by exact member string."
  type        = list(string)
  validation {
    condition     = alltrue([for m in var.service_agents : !endswith(m, "@${var.project_id}.iam.gserviceaccount.com")])
    error_message = "A user-managed service account (in the project's own domain) can never be listed as a service agent."
  }
}

variable "role_permissions" {
  description = "Role name -> included permissions, for every role in roles_to_check."
  type        = map(list(string))
  default     = {}
}

locals {
  user_sa_domain = "@${var.project_id}.iam.gserviceaccount.com"

  exempt = toset(concat(
    var.state_readers,
    [for m in var.service_agents : m if !endswith(m, local.user_sa_domain)],
  ))

  other_grants = flatten([
    for b in var.bindings : [
      for m in b.members : { role = b.role, member = m } if !contains(local.exempt, m)
    ]
  ])

  object_readers = [
    for g in local.other_grants : "${g.member} (${g.role})"
    if !contains(keys(var.role_permissions), g.role) || contains(lookup(var.role_permissions, g.role, []), "storage.objects.get")
  ]
}

output "roles_to_check" {
  description = "Roles the caller must expand into role_permissions."
  value       = sort(distinct([for g in local.other_grants : g.role]))
}

output "object_readers" {
  description = "Principals outside the allowed set that can read every bucket. Must be empty."
  value       = local.object_readers
}

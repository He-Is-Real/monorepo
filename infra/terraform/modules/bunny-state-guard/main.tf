# The bunny root's "never public" guard (D57 C; no providers, `tofu test` offline). Lists every
# grant to allUsers or allAuthenticatedUsers in the given IAM policies: the state bucket, the
# project, the KMS keyring and keys, and each `bunny-*` secret. Conditions don't matter: a public
# member counts whatever its condition says. Who else holds access is bootstrap's job (state.tf,
# tf_bunny.tf, kms.tf); org-level grants are checked by tools/scripts/check-bunny-fences.sh.

terraform {
  required_version = ">= 1.11"
}

variable "policies" {
  description = "Policy name (e.g. bucket, secret/bunny-account-api-key) -> its IAM bindings."
  type = map(list(object({
    role    = string
    members = list(string)
    condition = optional(object({
      title       = optional(string)
      description = optional(string)
      expression  = optional(string)
    }))
  })))
}

locals {
  public_members = ["allUsers", "allAuthenticatedUsers"]
}

output "public_grants" {
  description = "\"<policy>: <member> (<role>)\" for every public grant. Must be empty."
  value = flatten([
    for name, bindings in var.policies : [
      for b in bindings : [
        for m in b.members : "${name}: ${m} (${b.role})" if contains(local.public_members, m)
      ]
    ]
  ])
}

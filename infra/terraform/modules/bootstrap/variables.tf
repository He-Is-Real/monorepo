variable "project_id" {
  description = "GCP project ID for this environment (e.g. heisreal-dev)."
  type        = string
}

variable "project_name" {
  description = "Display name of the project."
  type        = string
}

variable "environment" {
  description = "Environment name used in labels and names (dev, prod)."
  type        = string
}

variable "org_id" {
  description = "GCP organisation ID (heisreal.today)."
  type        = string
}

variable "billing_account" {
  description = "Billing account ID the project is linked to."
  type        = string
}

variable "region" {
  description = "Region for all resources (UK for GDPR)."
  type        = string
  default     = "europe-west2"
}

variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to use the CI identities."
  type        = string
}

variable "github_repository_id" {
  description = "Numeric GitHub repository ID (robust against repo renames/takeovers)."
  type        = string
}

variable "budget_amount" {
  description = "Monthly budget in the billing account's currency (alert emails only)."
  type        = number
}

variable "budget_alert_fractions" {
  description = "Fractions of the budget that trigger alert emails (100% is always added)."
  type        = list(number)
}

variable "developers" {
  description = "Google identities of developers (user:email) allowed to read/write Terraform state."
  type        = list(string)
}

terraform {
  required_version = ">= 1.11" # write-only attributes / ephemeral resources
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
      # google.billing: same credentials, but bills API usage to the project
      # (the Billing Budgets API requires a quota project for user credentials).
      configuration_aliases = [google.billing]
    }
  }
}

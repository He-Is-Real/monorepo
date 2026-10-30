terraform {
  required_version = ">= 1.11" # ephemeral values (the API key's mode)
  required_providers {
    stripe = {
      source  = "stripe/stripe"
      version = "~> 0.3.0"
    }
  }
}

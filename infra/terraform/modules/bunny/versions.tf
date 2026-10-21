terraform {
  required_version = ">= 1.11" # write-only attributes / ephemeral resources
  required_providers {
    bunnynet = {
      source  = "BunnyWay/bunnynet"
      version = "~> 0.19"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
}

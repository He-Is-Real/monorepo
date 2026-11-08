terraform {
  backend "gcs" {
    bucket = "heisreal-dev-tfstate"
    prefix = "org"
  }
}

terraform {
  backend "gcs" {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/cluster"
  }
}

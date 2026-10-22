terraform {
  backend "gcs" {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/bunny" # only developers and tf-bunny can read it; encrypted with tofu-bunny
  }
}

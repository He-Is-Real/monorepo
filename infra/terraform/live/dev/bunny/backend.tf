terraform {
  backend "gcs" {
    bucket = "heisreal-dev-tfstate"
    prefix = "dev/bunny" # private: no CI identity can read it (modules/bootstrap/state.tf)
  }
}

variable "org_id" {
  description = "GCP organisation ID (heisreal.today)."
  type        = string
}

variable "allowed_locations" {
  description = <<-EOT
    Where Google Cloud may create resources in the organisation (constraints/gcp.resourceLocations):
    value groups ("in:gb-locations") or locations. Global resources (IAM, VPC networks,
    Cloud DNS, Pub/Sub topics) aren't location-bound and are never refused.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_locations) > 0
    error_message = "An empty list would allow every location."
  }
  validation {
    condition = alltrue([for l in var.allowed_locations : contains([
      "in:gb-locations", "in:europe-west2-locations",
      "europe-west2", "europe-west2-a", "europe-west2-b", "europe-west2-c",
    ], l)])
    error_message = "Only UK locations: in:gb-locations, in:europe-west2-locations, europe-west2 or its zones."
  }
}

variable "log_storage_location" {
  description = "Default location of new projects' _Default and _Required log buckets."
  type        = string

  validation {
    condition     = var.log_storage_location == "europe-west2"
    error_message = "Logs stay in the UK: log_storage_location must be europe-west2 (London)."
  }
}

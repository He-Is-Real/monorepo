variable "project_id" {
  description = "GCP project whose Secret Manager receives the keys the apps need."
  type        = string
}

variable "environment" {
  description = "dev, prod, ... (used in names: heisreal-<environment>-...)."
  type        = string
}

variable "region" {
  description = "GCP region for the Secret Manager replicas (UK for GDPR)."
  type        = string
  default     = "europe-west2"
}

variable "storage_region" {
  description = "Bunny storage main region. Create-time only (a change replaces the zone and its files). UK is offered on the Standard tier."
  type        = string
  default     = "UK"
}

variable "stream_resolutions" {
  description = "Stream encoding resolutions. Each one adds stored output, so keep the set small."
  type        = set(string)
  default     = ["360p", "480p", "720p"]
}

variable "cdn_routing_zones" {
  description = "Continents the images pull zone serves from. EU + US are the cheapest ($0.01/GB); visitors elsewhere are served from the nearest of these."
  type        = set(string)
  default     = ["EU", "US"]
}

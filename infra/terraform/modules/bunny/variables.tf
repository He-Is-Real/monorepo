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

  validation {
    condition     = var.region == "europe-west2"
    error_message = "Data stays in the UK: region must be europe-west2 (London)."
  }
}

variable "storage_region" {
  description = "Bunny storage main region. Create-time only (a change replaces the zone and its files). UK is offered on the Standard tier."
  type        = string
  default     = "UK"

  validation {
    condition     = var.storage_region == "UK"
    error_message = "Images stay in the UK: storage_region must be UK (Bunny's London)."
  }
}

variable "stream_storage_zone" {
  description = "The storage zone Bunny made for the Stream library (its id and name), adopted with an import block in the root. null before the library exists."
  type = object({
    id   = number
    name = string
  })
  default = null
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

variable "token_auth" {
  description = <<-EOT
    Bunny token authentication (D52): signed, expiring links for the Stream
    player (stream_embed), Stream's CDN files incl. HLS and thumbnails
    (stream_cdn) and the images pull zone (images). Unsigned links get 403.
  EOT
  type = object({
    stream_embed = bool
    stream_cdn   = bool
    images       = bool
  })
  default = {
    stream_embed = true
    stream_cdn   = true
    images       = true
  }
}

variable "signing_key_readers" {
  description = "IAM members (e.g. serviceAccount:api-public-read@…) that may read the two token auth keys, and no other bunny-* secret."
  type        = set(string)
  default     = []
  validation {
    condition = alltrue([for m in var.signing_key_readers :
      can(regex("^serviceAccount:[a-z][a-z0-9-]{4,28}[a-z0-9]@${var.project_id}\\.iam\\.gserviceaccount\\.com$", m))
    ])
    error_message = "Only this project's service accounts (serviceAccount:<name>@<project>.iam.gserviceaccount.com) may read the signing keys; never allUsers, groups or people."
  }
}

variable "upload_key_readers" {
  description = "The service that signs uploads (D80: api-user only), as serviceAccount:api-user@<project>.iam.gserviceaccount.com: it may read the Stream library key and the images zone password, and no other bunny-* secret. Empty: no reader."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for m in var.upload_key_readers : m == "serviceAccount:api-user@${var.project_id}.iam.gserviceaccount.com"])
    error_message = "Only this project's api-user service account may read the upload keys (D80: api-user alone creates and signs uploads)."
  }
}

variable "storage_password_readers" {
  description = "The nightly housekeeping Job, as serviceAccount:housekeeping@<project>.iam.gserviceaccount.com: it may read the images zone's password (to delete the folders of stories that are gone: erasure's queued pictures and abandoned drafts'), and no other bunny-* secret beyond stream_key_readers'. Empty: no reader."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for m in var.storage_password_readers : m == "serviceAccount:housekeeping@${var.project_id}.iam.gserviceaccount.com"])
    error_message = "Only this project's housekeeping service account may read the images zone password on its own (api-user reads it through upload_key_readers)."
  }
}

variable "stream_key_readers" {
  description = "The nightly housekeeping Job, as serviceAccount:housekeeping@<project>.iam.gserviceaccount.com: it may read the Stream library key (to list and delete orphaned story videos), and no other bunny-* secret. Empty: no reader."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for m in var.stream_key_readers : m == "serviceAccount:housekeeping@${var.project_id}.iam.gserviceaccount.com"])
    error_message = "Only this project's housekeeping service account may read the Stream library key on its own (api-user reads it through upload_key_readers)."
  }
}

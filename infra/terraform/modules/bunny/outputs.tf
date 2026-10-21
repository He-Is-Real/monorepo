# Identifiers only, never keys. Other roots must not read this state through
# terraform_remote_state (it holds secrets and CI can't read it): when an app
# needs these, pass them on explicitly.

output "stream_library_id" {
  value = bunnynet_stream_library.media.id
}

output "stream_cdn_pullzone_id" {
  description = "The pull zone Bunny created for the library (embed and HLS delivery)."
  value       = bunnynet_stream_library.media.pullzone
}

output "storage_zone_name" {
  description = "Also the S3 bucket name and access key ID."
  value       = bunnynet_storage_zone.images.name
}

output "storage_s3_hostname" {
  value = bunnynet_storage_zone.images.hostname_s3
}

output "images_cdn_hostname" {
  value = "${bunnynet_pullzone.images.name}.${bunnynet_pullzone.images.cdn_domain}"
}

output "app_secrets" {
  description = "Secret Manager secret IDs holding the keys the apps need."
  value       = local.app_secret_ids
}

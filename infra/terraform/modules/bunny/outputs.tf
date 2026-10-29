# Identifiers only, never keys. Other roots must not read this state through
# terraform_remote_state (it holds secrets and CI can't read it): when an app
# needs these, pass them on explicitly.

output "stream_library_id" {
  value = bunnynet_stream_library.media.id
}

output "site_assets_collection_id" {
  description = "The Stream collection for site videos (tools/scripts/site-asset-upload.mjs finds it by name)."
  value       = bunnynet_stream_collection.site_assets.id
}

output "stream_cdn_pullzone_id" {
  description = "The pull zone Bunny created for the library (embed and HLS delivery)."
  value       = bunnynet_stream_library.media.pullzone
}

output "stream_cdn_hostname" {
  description = "The Stream library's CDN hostname (thumbnails, HLS); api-public-read's BUNNY_STREAM_CDN_HOST."
  value       = "${data.bunnynet_pullzone.stream.name}.${data.bunnynet_pullzone.stream.cdn_domain}"
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

output "token_auth" {
  description = "Which deliveries refuse unsigned links (D52)."
  value       = var.token_auth
}

output "app_secrets" {
  description = "Secret Manager secret IDs holding the keys the apps need."
  value       = local.app_secret_ids
}

# State and saved plans encrypted with Cloud KMS (D54). Losing tofu-state loses these states.
terraform {
  encryption {
    key_provider "gcp_kms" "state" {
      kms_encryption_key       = "projects/heisreal-dev/locations/europe-west2/keyRings/tofu/cryptoKeys/tofu-state"
      key_length               = 32
      encrypted_metadata_alias = "tofu-state"
    }
    method "aes_gcm" "state" {
      keys = key_provider.gcp_kms.state
    }
    method "unencrypted" "migration" {} # removed in Task 11

    state {
      method = method.aes_gcm.state
      fallback { method = method.unencrypted.migration }
    }
    plan {
      method = method.aes_gcm.state
      fallback { method = method.unencrypted.migration }
    }
  }
}

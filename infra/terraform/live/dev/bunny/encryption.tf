# State and saved plans encrypted with Cloud KMS (D54). Only developers and tf-bunny can use
# tofu-bunny (modules/bootstrap/kms.tf). Losing it loses this state.
terraform {
  encryption {
    key_provider "gcp_kms" "bunny" {
      kms_encryption_key       = "projects/heisreal-dev/locations/europe-west2/keyRings/tofu/cryptoKeys/tofu-bunny"
      key_length               = 32
      encrypted_metadata_alias = "tofu-bunny"
    }
    method "aes_gcm" "bunny" {
      keys = key_provider.gcp_kms.bunny
    }

    state {
      method   = method.aes_gcm.bunny
      enforced = true # never read or write plaintext
    }
    plan {
      method   = method.aes_gcm.bunny
      enforced = true # never read or write plaintext
    }
  }
}

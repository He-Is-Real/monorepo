# The migrate Job's name changes if and only if what it would apply changes (D14): Terraform
# replaces the Job (so it runs again) exactly when the name changes. Offline: `tofu test`.
#
# OpenTofu doesn't accept run.<name>.<output> inside assert, so run "a" applies (no providers
# or resources: still offline) and later runs take its values in as variables.

variables {
  schema_dir = "tests/fixtures/a/schema"
  dpa_dir    = "tests/fixtures/a/dpa"
  job_template = {
    apiVersion = "batch/v1"
    kind       = "Job"
    metadata   = { name = "surrealdb-migrate", namespace = "database", labels = { app = "x" } }
    spec = {
      template = {
        spec = {
          containers = [{ name = "migrate", image = "google/cloud-sdk:1" }]
          volumes = [
            { name = "runner", configMap = { name = "surrealdb-migrate-runner-abc" } },
            { name = "migration", configMap = { name = "surrealdb-migration" } },
          ]
        }
      }
    }
  }
}

run "repo_bundle" {
  command = plan
  variables {
    schema_dir = "../../../../libs/database/schema"
    dpa_dir    = "../../../../libs/legal/dpa"
  }
  assert {
    condition = alltrue([for f in ["schema.surql", "access-clerk.surql", "dpa-sync.surql", "0001-seed-dpa-v1.surql", "migrate.py", "params.json"] :
    contains(keys(output.config_map.data), f)])
    error_message = "The bundle must hold the schema, the clerk access, the DPA sync, the data scripts, the runner and params.json."
  }
  assert {
    condition = (output.params.dpa_sha256["v1"] == filesha256("../../../../libs/legal/dpa/v1.md")
      && output.params.clerk_jwt_public_key == null && output.params.identity_hash == null
      && output.params.seed_dev_story == false && output.params.dev_consent_relaxed == false
    && output.params.environment == null)
    error_message = "dpa_sha256 holds the files' sha256 (D20); no Clerk key, identity config, dev story, environment or relaxed consent (D48) by default."
  }
  assert {
    condition     = output.job.metadata.name == output.job_name && output.config_map.metadata.name == "surrealdb-migration-${output.hash}"
    error_message = "Job and ConfigMap are named after the hash."
  }
  assert {
    condition = (output.job.spec.template.spec.volumes[1].configMap.name == output.config_map.metadata.name
    && output.job.spec.template.spec.volumes[0].configMap.name == "surrealdb-migrate-runner-abc")
    error_message = "Only the migration volume points at the hashed ConfigMap."
  }
}

run "a" {
  command = apply
  assert {
    condition     = output.params.dpa_sha256 == { v1 = filesha256("tests/fixtures/a/dpa/v1.md") }
    error_message = "dpa_sha256 maps each DPA file to its sha256."
  }
}

run "same_content_elsewhere" {
  command = plan
  variables {
    base_job_name = run.a.job_name
    schema_dir    = "tests/fixtures/a-copy/schema"
    dpa_dir       = "tests/fixtures/a-copy/dpa"
  }
  assert {
    condition     = output.job_name == var.base_job_name
    error_message = "Identical content must give the same name (no diff, no re-run)."
  }
}

run "data_script_changed" {
  command = plan
  variables {
    base_job_name = run.a.job_name
    schema_dir    = "tests/fixtures/b/schema"
  }
  assert {
    condition     = output.job_name != var.base_job_name
    error_message = "A one-byte change to a data script must give a new name."
  }
}

run "dpa_text_changed" {
  command = plan
  variables {
    base_job_name   = run.a.job_name
    base_dpa_sha256 = run.a.params.dpa_sha256.v1
    dpa_dir         = "tests/fixtures/dpa-changed"
  }
  assert {
    condition     = output.job_name != var.base_job_name && output.params.dpa_sha256.v1 != var.base_dpa_sha256
    error_message = "A changed DPA text must give a new hash parameter and a new name."
  }
}

run "clerk_key_set" {
  command = plan
  variables {
    base_job_name        = run.a.job_name
    clerk_jwt_public_key = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----\n"
  }
  assert {
    condition     = output.job_name != var.base_job_name && output.params.clerk_jwt_public_key != null
    error_message = "Setting the Clerk key must give a new name."
  }
}

run "job_spec_changed" {
  command = plan
  variables {
    base_job_name = run.a.job_name
    job_template = {
      apiVersion = "batch/v1"
      kind       = "Job"
      metadata   = { name = "surrealdb-migrate", namespace = "database", labels = { app = "x" } }
      spec = {
        template = {
          spec = {
            containers = [{ name = "migrate", image = "google/cloud-sdk:2" }]
            volumes = [
              { name = "runner", configMap = { name = "surrealdb-migrate-runner-abc" } },
              { name = "migration", configMap = { name = "surrealdb-migration" } },
            ]
          }
        }
      }
    }
  }
  assert {
    condition     = output.job_name != var.base_job_name
    error_message = "A new image (or runner, or any Job field) must give a new name: Jobs are immutable."
  }
}

run "identity_config_changed" {
  command = plan
  variables {
    base_job_name = run.a.job_name
    identity_hash = "abc"
  }
  assert {
    condition     = output.job_name != var.base_job_name && output.params.identity_hash == "abc"
    error_message = "A new identity config re-runs the Job, which checks the restart happened."
  }
}

run "private_key_refused" {
  command = plan
  variables {
    clerk_jwt_public_key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
  }
  expect_failures = [var.clerk_jwt_public_key]
}

# D48: relaxed consent is dev only. On in dev it reaches the runner (and re-runs the Job); in any
# other environment, or an unknown one, it's refused before anything is planned. The database
# refuses it outside dev too (libs/database/integration/dev-consent.int-spec.ts).
run "consent_relaxed_in_dev" {
  command = plan
  variables {
    base_job_name       = run.a.job_name
    environment         = "dev"
    dev_consent_relaxed = true
  }
  assert {
    condition = (output.job_name != var.base_job_name && output.params.dev_consent_relaxed == true
    && output.params.environment == "dev")
    error_message = "Relaxing consent in dev passes it to the runner and re-runs the Job."
  }
}

run "consent_enforced_in_dev_by_default" {
  command = plan
  variables {
    environment = "dev"
  }
  assert {
    condition     = output.params.dev_consent_relaxed == false
    error_message = "Dev enforces consent unless the flag is set."
  }
}

run "consent_relaxed_refused_in_prod" {
  command = plan
  variables {
    environment         = "prod"
    dev_consent_relaxed = true
  }
  expect_failures = [var.dev_consent_relaxed]
}

run "consent_relaxed_refused_without_environment" {
  command = plan
  variables {
    dev_consent_relaxed = true
  }
  expect_failures = [var.dev_consent_relaxed]
}

# D49: the Job waits for exactly the system users the init creates, dev_seed included in dev.
run "extra_system_users" {
  command = plan
  variables {
    base_job_name      = run.a.job_name
    extra_system_users = ["dev_seed"]
    job_template = {
      apiVersion = "batch/v1"
      kind       = "Job"
      metadata   = { name = "surrealdb-migrate", namespace = "database", labels = { app = "x" } }
      spec = {
        template = {
          spec = {
            containers = [{
              name = "migrate", image = "google/cloud-sdk:1"
              env  = [{ name = "MIGRATE_EXPECT_USERS", value = "backup,migrator" }, { name = "OTHER", value = "backup" }]
            }]
            volumes = [{ name = "migration", configMap = { name = "surrealdb-migration" } }]
          }
        }
      }
    }
  }
  assert {
    condition = (output.job.spec.template.spec.containers[0].env[0].value == "backup,dev_seed,migrator"
    && output.job.spec.template.spec.containers[0].env[1].value == "backup")
    error_message = "MIGRATE_EXPECT_USERS gains dev_seed (sorted); nothing else changes."
  }
  assert {
    condition     = output.job_name != var.base_job_name
    error_message = "A different user set is a different Job."
  }
}

run "extra_system_users_refused" {
  command = plan
  variables {
    extra_system_users = ["migrator"]
  }
  expect_failures = [var.extra_system_users]
}

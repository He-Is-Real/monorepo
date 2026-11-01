# The migrate Job's name changes if and only if what it would apply changes (D14): Terraform
# replaces the Job (so it runs again) exactly when the name changes. Offline: `tofu test`.
#
# OpenTofu doesn't accept run.<name>.<output> inside assert, so run "a" applies (no providers
# or resources: still offline) and later runs take its values in as variables.

variables {
  schema_dir = "tests/fixtures/a/schema"
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
  }
  assert {
    condition = alltrue([for f in ["schema.surql", "access-clerk.surql", "0006-submission-settings.surql", "migrate.py", "params.json"] :
    contains(keys(output.config_map.data), f)])
    error_message = "The bundle must hold the schema, the clerk access, the data scripts, the runner and params.json."
  }
  assert {
    condition     = !contains(keys(output.config_map.data), "dpa-sync.surql") && !contains(keys(output.config_map.data), "form-sync.surql")
    error_message = "Plan 4e: no legal files are synced into the database; the legal texts live there."
  }
  assert {
    condition = (length(keys(output.params)) == 3
      && output.params.clerk_jwt_public_key == null && output.params.environment == null
    && output.params.identity_hash == null)
    error_message = "The runner gets the Clerk key, the environment and the identity config only; none by default."
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
}

run "same_content_elsewhere" {
  command = plan
  variables {
    base_job_name = run.a.job_name
    schema_dir    = "tests/fixtures/a-copy/schema"
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

run "environment_changed" {
  command = plan
  variables {
    base_job_name = run.a.job_name
    environment   = "dev"
  }
  assert {
    condition     = output.job_name != var.base_job_name && output.params.environment == "dev"
    error_message = "The environment reaches the runner (_setting:current), and a new one re-runs the Job."
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

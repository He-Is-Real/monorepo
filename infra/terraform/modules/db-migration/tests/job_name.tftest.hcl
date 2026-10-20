# The migrate Job's name changes if and only if what it would apply changes (D14): Terraform
# replaces the Job (so it runs again) exactly when the name changes. Offline: `terraform test`.

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
          containers = [{ name = "migrate", image = "google/cloud-sdk:1", env = [{ name = "A", value = "1" }] }]
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
    condition = (output.params.dpa_v1_sha256 == filesha256("../../../../libs/legal/dpa/v1.md")
      && output.params.dpa_sha256["v1"] == output.params.dpa_v1_sha256
    && output.params.clerk_jwt_public_key == null && output.params.identity_hash == null)
    error_message = "dpa_v1_sha256 / dpa_sha256 are the files' sha256 (D20); no Clerk key or identity config by default."
  }
  assert {
    condition     = fileexists("../../../../libs/legal/dpa/legacy-squarespace.md") || contains(output.held_back, "0002-seed-legacy-dpa")
    error_message = "Without the legacy DPA text, 0002 must be held back."
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
  command = plan
  assert {
    condition     = output.held_back == tolist(["0002-two"])
    error_message = "A script using a null parameter is held back."
  }
}

run "same_content_elsewhere" {
  command = plan
  variables {
    schema_dir = "tests/fixtures/a-copy/schema"
    dpa_dir    = "tests/fixtures/a-copy/dpa"
  }
  assert {
    condition     = output.job_name == run.a.job_name
    error_message = "Identical content must give the same name (no diff, no re-run)."
  }
}

run "data_script_changed" {
  command = plan
  variables {
    schema_dir = "tests/fixtures/b/schema"
  }
  assert {
    condition     = output.job_name != run.a.job_name
    error_message = "A one-byte change to a data script must give a new name."
  }
}

run "dpa_text_changed" {
  command = plan
  variables {
    dpa_dir = "tests/fixtures/dpa-changed"
  }
  assert {
    condition     = output.job_name != run.a.job_name && output.params.dpa_v1_sha256 != run.a.params.dpa_v1_sha256
    error_message = "A changed DPA text must give a new hash parameter and a new name."
  }
}

run "clerk_key_set" {
  command = plan
  variables {
    clerk_jwt_public_key = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----\n"
  }
  assert {
    condition     = output.job_name != run.a.job_name && output.params.clerk_jwt_public_key != null
    error_message = "Setting the Clerk key must give a new name."
  }
}

run "job_spec_changed" {
  command = plan
  variables {
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
    condition     = output.job_name != run.a.job_name
    error_message = "A new image (or runner, or any Job field) must give a new name: Jobs are immutable."
  }
}

run "identity_config_changed" {
  command = plan
  variables {
    identity_hash = "abc"
  }
  assert {
    condition     = output.job_name != run.a.job_name && output.params.identity_hash == "abc"
    error_message = "A new identity config re-runs the Job, which checks the restart happened."
  }
}

run "generation_doesnt_rename" {
  command = plan
  variables {
    generation = "2026-10-20T18:00:00Z"
  }
  assert {
    condition = (output.job_name == run.a.job_name
    && contains([for e in output.job.spec.template.spec.containers[0].env : "${e.name}=${e.value}"], "MIGRATE_GENERATION=2026-10-20T18:00:00Z"))
    error_message = "The generation goes into the Job's environment without changing its name."
  }
}

run "private_key_refused" {
  command = plan
  variables {
    clerk_jwt_public_key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
  }
  expect_failures = [var.clerk_jwt_public_key]
}

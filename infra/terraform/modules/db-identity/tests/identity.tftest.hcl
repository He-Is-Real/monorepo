# The identity config hash changes iff the init script, the secrets that go into it or the
# rotation number change; everything that mounts or renders the script follows the hash.
#
# OpenTofu doesn't accept run.<name>.<output> inside assert, so run "base" applies (no providers
# or resources: offline) and later runs take its hash in as a variable.

variables {
  template         = "DEFINE USER OVERWRITE migrator ON DATABASE PASSWORD {{ .migrator | toJson }} ROLES OWNER;\n"
  external_secrets = "data: [migrator]\n"
  rotation         = "1"
  config_map = {
    apiVersion = "v1", kind = "ConfigMap"
    metadata   = { name = "surrealdb-init-template", namespace = "database" }
    data       = { "init.surql" = "BEGIN TRANSACTION;\nDEFINE USER OVERWRITE migrator ON DATABASE PASSWORD {{ .migrator | toJson }} ROLES OWNER;\n-- @dev-seed-login\n-- @identity-marker\nCOMMIT TRANSACTION;\n" }
  }
  external_secret = {
    apiVersion = "external-secrets.io/v1", kind = "ExternalSecret"
    metadata   = { name = "surrealdb-init", namespace = "database" }
    spec = {
      refreshInterval = "1h"
      target = {
        name = "surrealdb-init", creationPolicy = "Owner"
        template = {
          engineVersion = "v2"
          data          = { "credentials.json" = "{}" }
          templateFrom  = [{ configMap = { name = "surrealdb-init-template", items = [{ key = "init.surql", templateAs = "Values" }] } }]
        }
      }
      data = [{ secretKey = "migrator", remoteRef = { key = "surreal-migrator-password" } }]
    }
  }
}

run "base" {
  command = apply
  assert {
    condition = (output.external_secret.metadata.name == output.secret_name
      && output.external_secret.spec.target.name == output.secret_name
      && output.external_secret.spec.target.template.templateFrom[0].configMap.name == output.config_map.metadata.name
    && output.config_map.metadata.name == "surrealdb-init-template-${output.hash}")
    error_message = "ExternalSecret, its Secret and its template are all named after the hash."
  }
  assert {
    condition     = endswith(output.config_map.data["init.surql"], "UPSERT _identity:current SET hash = \"${output.hash}\", appliedAt = time::now();\nCOMMIT TRANSACTION;\n")
    error_message = "The identity marker is the last statement inside the init's transaction."
  }
  assert {
    condition = (output.external_secret.spec.target.template.data["identity-hash"] == output.hash
    && output.external_secret.spec.target.template.data["credentials.json"] == "{}")
    error_message = "The sidecar gets the expected hash next to the credentials."
  }
  assert {
    condition = (yamldecode(output.statefulset_patch).spec.template.metadata.annotations["heisreal.today/identity-config"] == output.hash
    && yamldecode(output.statefulset_patch).spec.template.spec.volumes[0].secret.secretName == output.secret_name)
    error_message = "The pod template carries the hash (restart) and mounts the new Secret."
  }
  assert {
    condition     = output.external_secret.spec.data[0].remoteRef.key == "surreal-migrator-password"
    error_message = "Secret references pass through unchanged."
  }
  assert {
    condition = (strcontains(output.config_map.data["init.surql"], "\nREMOVE USER IF EXISTS dev_seed ON DATABASE;\n")
      && !strcontains(output.config_map.data["init.surql"], "DEFINE USER OVERWRITE dev_seed")
      && length(output.external_secret.spec.data) == 1
    && !contains(keys(output.external_secret.spec.target.template.data), "system-users.json"))
    error_message = "D49: without dev_seed_login the init removes dev_seed, and no dev-seed password goes in."
  }
}

run "same_config" {
  command = plan
  variables {
    base_hash = run.base.hash
  }
  assert {
    condition     = output.hash == var.base_hash
    error_message = "No change, no restart."
  }
}

run "template_changed" {
  command = plan
  variables {
    base_hash = run.base.hash
    template  = "REMOVE USER IF EXISTS api_admin ON DATABASE;\n"
  }
  assert {
    condition     = output.hash != var.base_hash
    error_message = "A new init script means a new Secret and a restart."
  }
}

run "secrets_changed" {
  command = plan
  variables {
    base_hash        = run.base.hash
    external_secrets = "data: [migrator, backup]\n"
  }
  assert {
    condition     = output.hash != var.base_hash
    error_message = "A change to which secrets go in means a new Secret and a restart."
  }
}

run "rotated" {
  command = plan
  variables {
    base_hash = run.base.hash
    rotation  = "2"
  }
  assert {
    condition     = output.hash != var.base_hash
    error_message = "A password rotation means a new Secret (latest versions) and a restart."
  }
}

run "no_sentinel" {
  command = plan
  variables {
    config_map = {
      apiVersion = "v1", kind = "ConfigMap"
      metadata   = { name = "surrealdb-init-template", namespace = "database" }
      data       = { "init.surql" = "DEFINE USER OVERWRITE migrator ON DATABASE PASSWORD {{ .migrator | toJson }} ROLES OWNER;\n" }
    }
  }
  expect_failures = [output.config_map]
}

# D49: the dev-seed Job's system user, in dev only.
run "dev_seed_login" {
  command = plan
  variables {
    base_hash      = run.base.hash
    environment    = "dev"
    dev_seed_login = true
  }
  assert {
    condition = (strcontains(output.config_map.data["init.surql"],
      "\nDEFINE USER OVERWRITE dev_seed ON DATABASE PASSWORD {{ .dev_seed | toJson }} ROLES EDITOR")
    && !strcontains(output.config_map.data["init.surql"], "REMOVE USER IF EXISTS dev_seed"))
    error_message = "The init defines dev_seed as an EDITOR, with its password from the Secret."
  }
  assert {
    condition = (output.external_secret.spec.data[1].secretKey == "dev_seed"
      && output.external_secret.spec.data[1].remoteRef.key == "surreal-dev-seed-password"
    && output.external_secret.spec.target.template.data["system-users.json"] == "{\"dev_seed\": {{ .dev_seed | toJson }}}")
    error_message = "The Secret gets the dev-seed password, and the sidecar expects the user."
  }
  assert {
    condition     = output.hash != var.base_hash
    error_message = "Turning the login on or off restarts SurrealDB with the new init."
  }
}

run "dev_seed_login_refused_outside_dev" {
  command = plan
  variables {
    environment    = "prod"
    dev_seed_login = true
  }
  expect_failures = [var.dev_seed_login]
}

run "dev_seed_login_refused_without_environment" {
  command = plan
  variables {
    dev_seed_login = true
  }
  expect_failures = [var.dev_seed_login]
}

run "no_dev_seed_sentinel" {
  command = plan
  variables {
    config_map = {
      apiVersion = "v1", kind = "ConfigMap"
      metadata   = { name = "surrealdb-init-template", namespace = "database" }
      data       = { "init.surql" = "BEGIN TRANSACTION;\n-- @identity-marker\nCOMMIT TRANSACTION;\n" }
    }
  }
  expect_failures = [output.config_map]
}

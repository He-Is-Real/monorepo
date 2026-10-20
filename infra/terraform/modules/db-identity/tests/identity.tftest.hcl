# The identity config hash changes iff the init script, the secrets that go into it or the
# rotation number change; everything that mounts or renders the script follows the hash.

variables {
  template         = "DEFINE USER OVERWRITE migrator ON DATABASE PASSWORD {{ .migrator | toJson }} ROLES OWNER;\n"
  external_secrets = "data: [migrator]\n"
  rotation         = "1"
  config_map = {
    apiVersion = "v1", kind = "ConfigMap"
    metadata   = { name = "surrealdb-init-template", namespace = "database" }
    data       = { "init.surql" = "BEGIN TRANSACTION;\nDEFINE USER OVERWRITE migrator ON DATABASE PASSWORD {{ .migrator | toJson }} ROLES OWNER;\n-- @identity-marker\nCOMMIT TRANSACTION;\n" }
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
  command = plan
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
}

run "same_config" {
  command = plan
  assert {
    condition     = output.hash == run.base.hash
    error_message = "No change, no restart."
  }
}

run "template_changed" {
  command = plan
  variables {
    template = "REMOVE USER IF EXISTS api_admin ON DATABASE;\n"
  }
  assert {
    condition     = output.hash != run.base.hash
    error_message = "A new init script means a new Secret and a restart."
  }
}

run "secrets_changed" {
  command = plan
  variables {
    external_secrets = "data: [migrator, backup]\n"
  }
  assert {
    condition     = output.hash != run.base.hash
    error_message = "A change to which secrets go in means a new Secret and a restart."
  }
}

run "rotated" {
  command = plan
  variables {
    rotation = "2"
  }
  assert {
    condition     = output.hash != run.base.hash
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

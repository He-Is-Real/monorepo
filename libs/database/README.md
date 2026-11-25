# libs/database

The SurrealDB schema (`schema/`), its runner (`schema/migrate.py`) and the shared database code
(`src/`). The rules are in `docs/system/data-model.md` and the files it links to.

## Integration tests

```bash
pnpm nx run database:test-integration    # needs Docker
```

- Vitest's global setup runs `docker run` with the image from
  `infra/k8s/surrealdb/base/kustomization.yaml` (tag + digest), on RocksDB, the production engine.
  `SURREAL_TEST_URL` / `SURREAL_TEST_USER` / `SURREAL_TEST_PASS` use a running server instead.
- Each spec file gets its own namespace. An OWNER `migrator` applies the bundle with `migrate.py`;
  each service gets a `service` record with a random argon2-hashed password; Clerk is an RS256 key
  pair generated per run, passed as `clerk_jwt_public_key`.

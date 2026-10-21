# contracts

The OpenAPI 3.1 contracts for every service. **They are the source of truth (D23):** change the
spec in the same PR as the code that implements it. The rules they follow are in
[docs/api-conventions.md](../../docs/api-conventions.md).

| Spec                                                   | Service                                               | Callers                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| [`api-public-read.yaml`](openapi/api-public-read.yaml) | `api-public-read`: anonymous public queries           | Browser; `web` on the server, to prerender              |
| [`api-user.yaml`](openapi/api-user.yaml)               | `api-user`: the signed-in person's reads and commands | Browser with the Clerk token; Clerk and Stripe webhooks |
| [`api-admin.yaml`](openapi/api-admin.yaml)             | `api-admin`: moderation and admin                     | Browser with the Clerk token (role Moderator or higher) |
| [`worker.yaml`](openapi/worker.yaml)                   | `workflow` / `inference-worker` job payloads (M7)     | Pub/Sub through Dapr; Cloud Tasks only as the fallback  |
| [`components.yaml`](openapi/components.yaml)           | Shared schemas, parameters, headers and responses     | Referenced by the specs above; not served on its own    |

Each operation carries `x-milestone` (the milestone that builds it). M0 builds `GET /v1/stories/{slug}`,
the `/health` probes and api-user's three consent operations (task 0.8; they answer `401` until sign-in
arrives in task 0.5).

```bash
pnpm nx run contracts:lint-openapi      # Redocly, recommended-strict (also runs as part of `lint`)
pnpm exec redocly bundle libs/contracts/openapi/api-user.yaml -o /tmp/api-user.yaml   # one file
```

Lint exceptions are listed, with reasons, in `.redocly.lint-ignore.yaml`. TypeScript types for
`web` will be generated from these specs (openapi-typescript) when it first calls an API.

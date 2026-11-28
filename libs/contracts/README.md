# contracts

The OpenAPI 3.1 contracts for every service. **They are the source of truth (D23):** change the
spec in the same PR as the code that implements it. The rules they all follow are under
[Conventions](#conventions) below.

| Spec                                                   | Service                                               | Callers                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| [`api-public-read.yaml`](openapi/api-public-read.yaml) | `api-public-read`: anonymous public queries           | Browser; `web` on the server, to prerender              |
| [`api-user.yaml`](openapi/api-user.yaml)               | `api-user`: the signed-in person's reads and commands | Browser with the Clerk token; Clerk and Stripe webhooks |
| [`api-admin.yaml`](openapi/api-admin.yaml)             | `api-admin`: moderation and admin                     | Browser with the Clerk token (role Moderator or higher) |
| [`worker.yaml`](openapi/worker.yaml)                   | `workflow` / `inference-worker` job payloads (M7)     | Pub/Sub through Dapr; Cloud Tasks only as the fallback  |
| [`components.yaml`](openapi/components.yaml)           | Shared schemas, parameters, headers and responses     | Referenced by the specs above; not served on its own    |

Each operation carries `x-milestone` (the milestone that builds it). M0 builds `GET /v1/stories/{slug}`
and the `/health` probes (signed-in routes use Clerk since task 0.5, `libs/auth`).

```bash
pnpm nx run contracts:lint-openapi      # Redocly, recommended-strict (also runs as part of `lint`)
pnpm exec redocly bundle libs/contracts/openapi/api-user.yaml -o /tmp/api-user.yaml   # one file
```

Lint exceptions are listed, with reasons, in `.redocly.lint-ignore.yaml`. TypeScript types for
`web` will be generated from these specs (openapi-typescript) when it first calls an API.

## Conventions

These hold across `api-public-read`, `api-user` and `api-admin`; each operation's own entry wins.

- Every path is under `/v1` except `/health`: widgets on church websites can't be updated in step with the APIs.
- Path segments are kebab-case. Collections are plural nouns (`/stories`, `/themes`), singletons singular
  (`/account`, `/feed`); the method says what happens. A verb is only the last segment of a state-changing `POST`
  (`/{id}/submit`, `/{id}/approve`), never in a `GET`: `/{id}/verb`, not Google's `/{id}:verb`, which clashes
  with Express route parameters.
- Editable fields change by `PATCH` with JSON Merge Patch (`application/merge-patch+json`); a relationship is set
  with `PUT` and removed with `DELETE`, both idempotent. A status is never patched: it changes by command.
- Our own JSON fields are camelCase (vendor payloads, such as Bunny's webhook, and header maps keep their names),
  times RFC 3339 UTC, and ids opaque (the record id without its table): clients never parse them.
- Queries change no application state, except that signing in to api-user creates the person's record on first
  use, whichever route that is (a query too). There is no event store: the tables are the state.
- Paged lists use cursors (`?limit=&cursor=` → `{ data, nextCursor }`); some short lists (public themes, staff,
  the block list) are not paged. Public lists carry no totals.
- Errors are RFC 9457 `application/problem+json` (`type`, `title`, `status`), with our `code` where the caller
  can act on it (a generic failure has none), and never echo testimony text or other personal data. `/health`
  answers with its own response. Each operation lists its own statuses (not every one lists `5XX`), and a status
  means the same everywhere:

| Status | Means                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Malformed or invalid request (also a missing `Idempotency-Key`)                                                                                                                    |
| 401    | Missing or invalid Clerk token (on the Bunny webhook, a bad signature)                                                                                                             |
| 403    | Role or ownership check failed, or the person must agree first (`terms_agreement_required`, `testimony_consent_required`)                                                          |
| 404    | Not found, or not visible to the caller                                                                                                                                            |
| 409    | The resource's state doesn't allow it                                                                                                                                              |
| 412    | `If-Match` doesn't match the current version                                                                                                                                       |
| 422    | `Idempotency-Key` reused with a different body                                                                                                                                     |
| 428    | `If-Match` missing                                                                                                                                                                 |
| 5XX    | The service couldn't answer: a generic problem (`type`, `title`, `status`, no `code`), never the cause (a rate limit answers exactly this too)                                     |
| 503    | `service_restarting` (the database is restarting; `Retry-After` and `retryAfterSeconds` say when to try again), or `sign_in_unavailable` / `uploads_unavailable` (no retry fields) |

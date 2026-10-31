# Clerk (task 0.5)

Clerk's settings as code, applied with the Clerk CLI. There's no maintained Clerk OpenTofu (or OpenTofu)
provider: the registry has none from Clerk, and the community ones have at most a handful of
stars. So this is an exception to "all cloud changes through OpenTofu"
([delivery-status](../../docs/delivery-status.md), decision 17). Everything else about Clerk that
lives on our side (the public key SurrealDB pins, the publishable key on `web`, the secret-key
container) is in OpenTofu.

| File               | What                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| `dev.json`         | The dev instance's settings we manage: a partial config for `clerk config patch` |
| `clerk-config.mjs` | Checks the instance against `dev.json` (read-only), or applies it with `--apply` |

```bash
node infra/clerk/clerk-config.mjs           # check: exit 1 and the differences if it drifted
node infra/clerk/clerk-config.mjs --apply   # show the request (dry run), patch, check again
```

It needs the Clerk CLI logged in and linked to the "He Is Real" app (decision 13). It prints only
the settings `dev.json` lists, never keys. A `PATCH` only touches those keys; everything else stays
as Clerk's defaults or the dashboard left it. Change settings here, in a PR, and apply after
merge. If you change one in the dashboard, copy it into `dev.json` too: `check` shows the drift.

## What `dev.json` sets (D2, D1)

- **Sign-in:** Google (Clerk's shared dev credentials) and email. Email signs in with a code or a
  password: passwords are optional (`required: false`), with an 8-character minimum and the
  leaked-password (HIBP) check, on sign-in too. Clerk links accounts by verified email, so Google
  and email work on one account.
- **Protection:** CAPTCHA and lockout stay on. Multi-factor login and passkeys stay off, because
  they need Clerk Pro (decide at M3, D2). The instance stays on the free Hobby plan.
- **Session token:** a 60 s lifetime, 5 s clock skew, and four custom claims:
  - `ns`, `db`, `ac`: route the token to SurrealDB's `DEFINE ACCESS clerk` (D27; checked
    against the services' settings in `libs/auth`'s `clerk-instance.spec.ts`);
  - `role`: `{{user.public_metadata.role || 'User'}}`, the role (D1). A person without
    `publicMetadata.role` gets `User`.
- **No Clerk legal-consent checkbox.** Our own versioned consent ledger (D17–D21) is the record of
  consent. It's bound to a DPA version and its text's hash, it's per type and append-only, and
  it's built for Art 7(1) proof and Art 7(3) withdrawal. A Clerk checkbox would be a second,
  unversioned consent record outside our database, and it can't express Art 9 consent anyway.
  Terms acceptance for sign-up can be added later through the ledger, not Clerk.

Verified on 2026-10-21 with a real token minted for a throwaway user (deleted afterwards): RS256,
the dev key's `kid`, `ns`/`db`/`ac` present, `role` = `User` without metadata and `Moderator`
with it. About 900 bytes. That token, now expired, is the fixture in
`libs/auth/src/lib/fixtures/`.

## Keys

| Key                  | Public? | Where                                                                                                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Issuer (`iss`)       | yes     | `infra/terraform/live/dev/gcp/main.tf` (`clerk_issuer`): api-user's and api-admin's `CLERK_ISSUER`                        |
| JWT public key (PEM) | yes     | `infra/terraform/live/dev/cluster/clerk.auto.tfvars`: SurrealDB, and (linked into the gcp root) `CLERK_JWT_PUBLIC_KEY`    |
| Publishable key      | yes     | `infra/terraform/live/dev/gcp/main.tf` (`clerk_publishable_key`): `web`'s `CLERK_PUBLISHABLE_KEY`                         |
| Secret key           | **no**  | Secret Manager `clerk-secret-key` (container from the `gcp` root). Only api-user reads it: erasure deletes the Clerk user |

- **PEM from the JWKS** (read-only):
  `clerk api /jwks | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(require('crypto').createPublicKey({key:JSON.parse(s).keys[0],format:'jwk'}).export({type:'spki',format:'pem'})))"`
- **Add the secret key** (after the `gcp` root has created the container), without echoing it:

  ```bash
  t=$(mktemp); gcloud auth application-default print-access-token > "$t"
  clerk api --platform "/platform/applications/app_3JuNErrA1fDnJI7SBa3Qx9iYkqU?include_secret_keys=true" \
    | jq -j '.instances[] | select(.environment_type == "development") | .secret_key' \
    | CLOUDSDK_AUTH_ACCESS_TOKEN_FILE="$t" gcloud secrets versions add clerk-secret-key --project heisreal-dev --data-file=-
  rm -f "$t"
  ```

  Never `clerk env pull` it into a `.env` file (decision 13).

- **Key rotation:** a rotated Clerk signing key breaks every person session until the new PEM is
  pinned: update `clerk.auto.tfvars` (one file: the gcp root links to it) and the local
  `.env` files; the merge's `tofu-apply.yml` run redeploys api-user and api-admin (gcp) and
  migrates (cluster). The secret key rotates with the Platform API
  (`rotate_secret_keys`), then gets a new secret version.

## Webhook (erasure, M2 plan PR 11)

Clerk's `user.deleted` event erases the person in our database too (D39): someone who deletes
their account in Clerk's own panel, or whom an admin deletes in Clerk's dashboard, loses their
stories and media with it. api-user receives it at `POST /v1/webhooks/clerk`, checks the Svix
signature with the endpoint's signing secret, and ignores every other event. Webhook endpoints
aren't part of `clerk config patch`, so this is a one-off dashboard step (an exception to
config-as-code, like the rest of this folder):

1. Clerk dashboard → the "He Is Real" app, development instance → **Webhooks** → **Add
   Endpoint**. URL: `https://api-user-jbxp6odnsa-nw.a.run.app/v1/webhooks/clerk`. Subscribe to
   **`user.deleted` only**. Create.
2. Copy the endpoint's **Signing Secret** (`whsec_…`) and add it as a version of the Secret
   Manager secret `clerk-webhook-signing-secret` (the `gcp` root makes the container), without
   echoing it:

   ```bash
   t=$(mktemp); gcloud auth application-default print-access-token > "$t"
   read -rs WHSEC && printf %s "$WHSEC" \
     | CLOUDSDK_AUTH_ACCESS_TOKEN_FILE="$t" gcloud secrets versions add clerk-webhook-signing-secret --project heisreal-dev --data-file=-
   unset WHSEC; rm -f "$t"
   ```

Until the version exists, api-user answers the webhook `503` and Svix keeps retrying for days,
so nothing is lost; api-user reads the secret on the next delivery, with no redeploy. Rotating
it in the dashboard means adding the new secret as a new version straight away.

The production instance needs a domain we own, so it waits for the domain cutover (D7). It gets
its own `prod.json`, keys and PEM.

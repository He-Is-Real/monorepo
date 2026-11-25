# Architecture

Who: the services, the media worker and the people who build them. Data: `docs/db-permissions.md`.
Next id: REQ-ARC-041

## Services

- **REQ-ARC-001** The site is four services: `web` (the website), `api-public-read` (anonymous, published stories only), `api-user` (the signed-in person) and `api-admin` (Moderators and Admins). [D33]
- **REQ-ARC-002** Services never call each other, and two services are never merged into one. [D33]
- **REQ-ARC-003** Each service signs in to the database as its own least-privilege login; services never share a login, and `api-public-read`'s login is read-only. [D13]
  Example: the logins and their permissions are in `docs/db-permissions.md`.
- **REQ-ARC-004** The website's server calls only `api-public-read`, never `api-user` or `api-admin`. [D32]
- **REQ-ARC-005** Clerk runs in the browser only, and the browser calls `api-user` and `api-admin` directly. [D31]
- **REQ-ARC-006** The website's server never reads, logs or forwards the sign-in cookie; a lint rule guards this (`apps/web/README.md`). [D32]
- **REQ-ARC-007** In `api-user`, a person's own reads run inside a database session as that person, so the database's own permissions keep everyone else's rows out. [D27]
- **REQ-ARC-008** The OpenAPI specs in `libs/contracts/openapi` are the source of truth for every API; the conventions are in `docs/api-conventions.md`. [D23]

## A sign-in pass that runs out mid-request

- **REQ-ARC-009** When a request in `api-user` is quick, it runs on the person's own Clerk pass (it lasts 60 seconds) while that pass lasts 10 seconds more. [DEC-T]
  Why: the database library ends the person's session when their pass expires, which would cut the request off midway.
- **REQ-ARC-010** Slow work in `api-user` (submit, an upload link, Download my data) always runs as the person on a fresh 6-minute pass `api-user` gets from Clerk for the same sign-in. [DEC-T]
- **REQ-ARC-011** When work runs on a fresh pass, it starts no new try after 2 minutes. [DEC-T]
- **REQ-ARC-012** When Clerk says the sign-in is over, `api-user` answers `401`; when Clerk does not answer, it answers `503 sign_in_unavailable` (try again). [DEC-T]
- **REQ-ARC-013** `api-admin` holds no Clerk key and works on the person's own pass. [DEC-T]

## Stories in the database

- **REQ-ARC-014** There is one story table: the public reads `story` itself, and the database's rules show the public only approved stories and only their published fields. [R11]
- **REQ-ARC-015** A story's status lives in its status log (`storyStatusLog`), whose entries are never edited; the story points at its newest entry. [R6]

## When the database restarts

- **REQ-ARC-016** Every service notices a database restart in the shared database client (`DatabaseAvailability` in `libs/database`) and keeps reconnecting for as long as it takes. [J-2026-11-07-ARC]
- **REQ-ARC-017** A service starts without the database and connects in the background (`startConnecting`); Cloud Run's start-up check needs only the port open. [J-2026-11-07-ARC]
- **REQ-ARC-018** When the database answers a service's first sign-in with a refusal (the SDK's `ServerError`), the service exits with code 1. [J-2026-11-07-ARC]
- **REQ-ARC-019** While the database is unreachable, every request, sign-in's person lookup included, answers at once with `503 service_restarting` and `Retry-After` instead of hanging (`ServiceRestarting` in `libs/contracts/openapi/components.yaml`). [J-2026-11-07-ARC]

## Public answers kept in memory

- **REQ-ARC-020** `api-public-read` keeps public answers in its own memory, per running copy, with no timers, at most 500 answers. [R13]
  Why: with no timers, Cloud Run still bills only per request and scales to zero.
- **REQ-ARC-021** The answers kept for a database restart share that same store and its 500-answer limit. [J-2026-11-07-ARC]
- **REQ-ARC-022** In dev there is no CDN in front of the site or the APIs, and API answers tell browsers and CDNs not to keep them. [D51]

## Background work

- **REQ-ARC-023** Background work runs in Dapr off Google Cloud (the founder's machine now, church hardware later), pulling its jobs from Pub/Sub; there is no Dapr on GKE. [D78]
- **REQ-ARC-024** While the worker machine is off, its work waits in Pub/Sub, in London, for up to 31 days. [D78]
- **REQ-ARC-025** The worker sends each answer directly to the Cloud Run result writer, which only the worker's Google account may call, and the writer writes the results. [J5]
- **REQ-ARC-026** The worker uses only Dapr's Pub/Sub part and stores nothing on the machine but its identity. [D129]
- **REQ-ARC-027** Every answer names the job's video, and the result writer refuses an answer that names another. [J-2026-11-08-ARC]
- **REQ-ARC-028** Anything the worker cannot do counts as a failure, the writer refusing its answer and the worker's own errors included, and a job gives up after 5 failures. [J-2026-11-08-ARC]
  Why: so no job loops for ever.

## Worker identity

- **REQ-ARC-029** The worker signs in as the narrow `media-worker` Google account with its own certificate, never with a person's gcloud login and never with a Google key file. [W1-A]
- **REQ-ARC-030** Our own certificate authority issues each machine a certificate naming it, signed with a Cloud KMS key in London that only the `cert-signer` service may sign with. [W1-A]
- **REQ-ARC-031** Google's workload identity federation trusts only that certificate authority. [W1-A]
- **REQ-ARC-032** Every 6 hours the worker makes a new key and gets a new certificate, valid 24 hours, by proving its current one to `cert-signer`; both times are settings. [W1-A]
- **REQ-ARC-033** `cert-signer` has one route, and only `media-worker` may call it. [W1-A]
- **REQ-ARC-034** The new key and certificate replace the old pair at the same path, so the old key is deleted at once and Dapr follows without a restart. [W1-A]
- **REQ-ARC-035** Only the newest certificate issued for a machine may renew, so a copied certificate and key cannot keep a second line going. [W2-1]
  Why: church machines have no security chip, so no chip-based protection is available.
- **REQ-ARC-036** When a copy renews first, the real worker is refused at its next renewal and says so; its name is then cancelled and the machine enrolled under a new name. [W2-1]
- **REQ-ARC-037** When a renewal's answer is lost, the worker asks again with the new key it saved first and gets the same certificate back, never a new one. [W3-1]
- **REQ-ARC-038** A machine off for longer than the certificate's lifetime is enrolled again by a developer with one command. [W1-A]
- **REQ-ARC-039** A machine is cancelled by taking its name out of the list in OpenTofu. [W1-A]
- **REQ-ARC-040** Every machine that runs workers has automatic time sync on. [J-2026-11-17-ARC]
  Why: certificates and the Google sign-in they give are checked against the clock; a drifting clock makes them look not yet valid or expired.

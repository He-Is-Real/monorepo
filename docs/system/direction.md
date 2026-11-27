# Direction

Who: anyone building the site and the services behind it.
Data: none.
Next id: REQ-DIR-029

These lines say what we build with today. None is a promise to users; the behaviour files hold those. Engineering may change anything not written here, as long as every behaviour still holds. Changing a line on this page comes to the founder with the reason, the cost and the benefit.

## Platform

- **REQ-DIR-001** Google Cloud is the platform. [BE-2]
- **REQ-DIR-002** Every cloud change goes through OpenTofu. [BE-2]
- **REQ-DIR-003** An apply to the production environment needs approval. [BE-2]

## Shape

- **REQ-DIR-004** The site is a website and three APIs (public read, user, admin). [BE-2]
- **REQ-DIR-005** Services never call each other; background work goes out as queue messages. [BE-2]
- **REQ-DIR-006** Each service has its own database login with the least access it needs. [BE-2]
- **REQ-DIR-007** The website's server calls only the public API and holds no sign-in tokens. [BE-2]
- **REQ-DIR-008** Nothing on the cluster is reachable from the internet. [BE-2]
- **REQ-DIR-009** Nothing keeps compute running between requests; services scale to zero. This keeps running costs down. [BE-8]

## Data

- **REQ-DIR-010** The database is SurrealDB, hosted by us. [BE-2]
- **REQ-DIR-011** Before production, dev's data is wiped and rebuilt rather than migrated. [BE-2]

## Code

- **REQ-DIR-012** TypeScript throughout: Next.js for the website, NestJS for the APIs, one repository run through Nx. [BE-2]
- **REQ-DIR-013** The API contract files (OpenAPI) are the source of truth for every API. [BE-2]
- **REQ-DIR-014** No framework workarounds: use the standard way or drop the feature. [BE-2]

## Outside services

- **REQ-DIR-015** Clerk for sign-in. [BE-2]
- **REQ-DIR-016** Bunny for video and audio. [BE-2]
- **REQ-DIR-017** Stripe for donations. [BE-2]
- **REQ-DIR-018** No Apple-only technology. [BE-2]

## Background work

- **REQ-DIR-019** Heavy media work runs on our own machines outside Google Cloud, through Dapr. [BE-2]

## Website look

- **REQ-DIR-020** One library holds the website's building blocks. Use its pieces first; page-level styling is the last resort. [BE-2]

## Testing

- **REQ-DIR-021** Tests check behaviour, at the highest level that can see it; few unit tests. [BE-2]
- **REQ-DIR-022** A test gives the same result on a developer's machine and in CI. [BE-2]
- **REQ-DIR-023** Scale tests run only on a developer's machine. [BE-2]
- **REQ-DIR-024** No Safari or Apple-device testing. [BE-2]

## Accepted risks

- **REQ-DIR-025** One database node, in production too. [BE-8]
- **REQ-DIR-026** If the user API's own database login were stolen, it could delete anyone's account. Accepted: the backup restores it, and nothing is disclosed. [BE-7]
- **REQ-DIR-027** A page left open when its account is deleted can still read what is left for up to five minutes; it can write nothing. [BE-7]
- **REQ-DIR-028** The database's own owner login and the backup login are trusted: the owner could remove the database's guards, and the backup reads everything. [BE-7]

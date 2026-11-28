# Rate limits

Who: Visitor, Signed-in person, Moderator, Admin, the system.
Data: none; counts live only in each running copy's memory.
Next id: REQ-LIM-030

## The numbers

Each number is per caller and per running copy of the service.

- **REQ-LIM-001** The website allows 600 page loads and actions a minute per Visitor or Signed-in person. [RL-2]
- **REQ-LIM-024** The website allows 2 requests a minute for the sitemap. [RL-2]
- **REQ-LIM-002** api-public-read allows a direct caller 120 requests a minute; the website's own calls share 3,000 a minute. [RL-2]
- **REQ-LIM-003** api-user allows each caller 120 reads, 60 changes and 10 deletes a minute, and 20 upload links and 2 "Download my data" an hour. [RL-2]
- **REQ-LIM-004** api-user allows the browser's error reports 60 a minute per address, signed in or not, counted apart from other changes. [LG-13a]
- **REQ-LIM-005** api-admin never limits a signed-in Moderator or Admin. [RL-2]
- **REQ-LIM-006** api-admin counts only the requests it refuses for sign-in (not signed in, a refused or ended sign-in, no staff role, or a person the site does not know yet), 10 a minute per address. [RL-2]
- **REQ-LIM-007** When an address goes over the api-admin limit, its next requests get the generic error before sign-in is checked, for up to a minute, so a Moderator sharing that address (for example a church network) is blocked there too. [RL-2]
- **REQ-LIM-008** When api-admin refuses a Moderator an Admin-only page or action, that refusal does not count towards the limit. [RL-2]
- **REQ-LIM-009** Every service's health check allows 60 a minute. [RL-2]

## How callers are counted

- **REQ-LIM-010** Each running copy counts in its own memory only: nothing goes to the database, Redis or an edge service, and no address is written anywhere. [RL-6]
- **REQ-LIM-012** With two running copies a caller can get up to twice a limit, and a copy that restarts starts its counts again; no number is a site-wide promise. [RL-6]
- **REQ-LIM-013** A caller's count covers the last full window (for example the last 60 seconds), not a clock minute that resets. [J-2026-11-21-LIM]
  Not: a fixed minute that resets, where waiting for the reset and bursting works.
- **REQ-LIM-014** One caller is the IP address REQ-ACC-047 describes. [RL-8]
- **REQ-LIM-029** An IPv6 address counts as its /56 network. [PR-261]
- **REQ-LIM-015** The website does not count images, scripts and other static files. [RL-8]
- **REQ-LIM-016** api-user counts each caller by groups of routes (reads, ordinary changes, upload links, "Download my data", deleting, browser error reports), so a busy account can still delete its story or itself. [RL-8]
- **REQ-LIM-017** api-public-read counts each caller, except the website's own server, whose calls carry a private key and share one large allowance. [RL-8]
- **REQ-LIM-018** Clerk's and Bunny's webhooks have no limit; their signatures are checked. [UNTRACED]
  Why: a ceiling waits until their real bursts are known.

## What a limited caller sees

- **REQ-LIM-019** When an API limits a caller, it answers exactly as for any unexpected failure (status 500, the same body and headers), with no "too many requests" status, no remaining-count or retry headers and no special wording. [RL-5]
  Why: people must not see their progress while trying to break or bypass the limiter.
- **REQ-LIM-020** When the website limits a caller, it answers exactly as when a page crashes, with the error page "Something went wrong. Please try again later." and "Try again", for page loads, in-site navigation and server actions alike. [RL-5]
- **REQ-LIM-021** Only our private logs say a caller was limited: one line when a caller first goes over, naming the group, never the address. [RL-5]

## Changing a number

- **REQ-LIM-022** A number changes only by a reviewed change to the one limits table in the shared code, and a deploy. [RL-9]
- **REQ-LIM-023** Limits apply only where Cloud Run runs the service; a local run has none. [RL-2]

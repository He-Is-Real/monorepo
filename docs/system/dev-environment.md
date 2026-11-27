# Dev and test environment

Who: the system, Moderator, Admin (anyone building or testing the site).
Data: `docs/db-permissions.md#who-connects` (the dev-seed login).
Next id: REQ-DEV-011

- **REQ-DEV-001** Milestones M1 to M8 are built and tested on the dev site only, with made-up stories; then "Real stories" brings in the 24 existing stories, then "Go live" opens the real site, then Emails. [D87]
- **REQ-DEV-002** Public submissions open only once emails work, so nobody shares a story without a confirmation; Go live may put the site up first, as the 24 imported stories need no emails. [D95]
- **REQ-DEV-003** The dev site uses Google's own web addresses (`*.run.app`); heisreal.today stays with the prototype until Go live. [D7]
- **REQ-DEV-004** Search engines do not list the dev site. [UNTRACED]
- **REQ-DEV-005** Dev has about 25 obviously fake stories covering every type and status, with fake people and short test videos. [D47]
- **REQ-DEV-006** "Reset dev data" puts the dev data back in about a minute. [D49]
- **REQ-DEV-007** After each deploy, automatic tests sign real test people in on dev and clean up what they upload. [D50]
- **REQ-DEV-008** Dev's test accounts are trusted submitters, on dev only. [D112]
- **REQ-DEV-009** Error tracking (Sentry) and visitor statistics (Umami) are not part of this phase. [D5]
- **REQ-DEV-010** Bunny.net is the only video host; YouTube is a later feature. [D8]

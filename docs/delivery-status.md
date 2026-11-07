# Delivery status

Where the build is, milestone by milestone, in plain words. The plan itself (what each milestone
is for) is the delivery plan in the `project` repo (`context/future/delivery-plan.md`).

- **How the site behaves** (the rules: who can do what, limits, what is kept and deleted) is in
  [how-the-app-works.md](how-the-app-works.md).
- **This file is progress only:** what is done, what is being worked on and what is next.
- Joel owns the data structure, the API and behaviour (AGENTS.md). A change to a rule in
  how-the-app-works.md needs Joel's decision first; record it there in the same pull request.
- Update this file in the same pull request that finishes or starts a piece of work.
- The long dated log and the per-step build notes that used to be here are in git history
  (this file before 2026-11-04).

**Last updated:** 2026-11-07

Everything below runs on the **dev** site only, with made-up test stories. Nothing reaches the
public until the "Go live" milestone; the old prototype and the Squarespace site keep running
until then.

## Milestones

| Milestone                         | Status         | In short                                                                                                                                           |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 Walking skeleton               | ✅ Done        | The foundations: the code base, the cloud set-up, the database, sign-in and a first public page.                                                   |
| M1 Browse & view                  | ✅ Done        | Anyone can read, watch and listen to stories, browse and search them, and read the information pages. Done 2026-10-24.                             |
| M2 Accounts & submission          | 🟡 In progress | People can sign up, agree to the terms, share stories, manage them, keep favourites, download their data and delete their account. Two parts left. |
| M3 Moderation                     | ⚪ Not started | Moderators review stories before they go public.                                                                                                   |
| M4 Donations                      | 🟡 In progress | Giving through Stripe works on dev in Stripe's test mode. Recording donors and Gift Aid are not started.                                           |
| M5 Admin dashboard                | ⚪ Not started | Three admin pages already exist from M2 (limits, themes, consent texts); the dashboard itself is not started.                                      |
| M6 Community vetting              | ⚪ Not started |                                                                                                                                                    |
| M7 Async processing (AI)          | ⚪ Not started | A transcription worker was tried out in the `project` repo. Background work will run on Joel's machine, later church hardware, not Google Cloud.   |
| M8 Embeddable widgets             | ⚪ Not started | Can start any time.                                                                                                                                |
| Real stories (the 24 testimonies) | ⚪ Not started | After M8: bring in the 24 existing testimonies. See "What blocks Go live" below.                                                                   |
| Go live                           | ⚪ Not started | After Real stories: the heisreal.today domain, the production sign-in service and switching off Squarespace.                                       |
| Emails                            | ⚪ Not started | After Go live, once the domain can send mail: submission confirmations, moderation results, the draft-deletion reminder.                           |

## M0: Walking skeleton ✅

Done (on dev since 2026-10-21): the code base and its automatic checks, the Google Cloud set-up
(all through OpenTofu, our infrastructure-as-code tool), the database with its access rules, video
and picture hosting at Bunny.net, sign-in through Clerk, and a first public story page.

Not done on purpose: error tracking (Sentry) and visitor statistics (Umami) are left for later.

## M1: Browse & view ✅

Done (on dev, 2026-10-24): the home page, browsing and searching stories (by theme and format, with
sorting), video, audio and written story pages with related stories, cards that play in
place, the information pages (About, The Greatest Story, Get ready to share, Next steps, FAQs,
Contact, Privacy, Terms), the essential-cookies notice, and a test set of made-up stories that
can be reset at any time. The founder's videos play on About and Next Steps.

The old idea of importing the 24 real testimonies moved to the "Real stories" milestone.

## M2: Accounts & submission 🟡

**Done and on dev:**

- **Sign up and sign in** with Google or email ([sign-in page](https://github.com/He-Is-Real/monorepo/pull/100), [one sign-in set-up for the whole site](https://github.com/He-Is-Real/monorepo/pull/132)).
- **Consent, privacy and terms (plan 4e):** four versioned texts (terms of use, testimony
  consent, social media sharing consent, privacy notice); people agree before they can share,
  and agree again when a text changes; admins publish new versions at the consent admin page
  ([plan 4e](https://github.com/He-Is-Real/monorepo/pull/171)). Follow-ups: an upload refused
  for a newer text opens the agree-again screen and carries on once the person agrees
  ([#172](https://github.com/He-Is-Real/monorepo/pull/172)); being sent to the terms step twice
  no longer loses the page the person started from
  ([#173](https://github.com/He-Is-Real/monorepo/pull/173)). This replaced the earlier consent
  design (sign-up consent forms, consent history records and legal documents built in late
  October), which is gone.
- **Share your story:** written stories ([submit flow](https://github.com/He-Is-Real/monorepo/pull/118)),
  video and audio uploaded straight to Bunny with progress and resume
  ([video and audio](https://github.com/He-Is-Real/monorepo/pull/133)), and a picture on any
  story ([pictures](https://github.com/He-Is-Real/monorepo/pull/140)); autosave; limits on
  length, themes, drafts and how often someone can submit or upload, which admins can change; the
  share page shows what's left this week before a limit is reached
  ([limits shown](https://github.com/He-Is-Real/monorepo/pull/156)).
- **My profile:** My submissions with each story's status, continue, withdraw and delete
  ([profile](https://github.com/He-Is-Real/monorepo/pull/138),
  [delete a story sent back, draft expiry date](https://github.com/He-Is-Real/monorepo/pull/144)),
  Clerk's own account panel for name, email and password.
- **Delete my account**, which also removes the person's stories, videos and pictures, and stops
  the same sign-in from coming back ([erasure](https://github.com/He-Is-Real/monorepo/pull/145),
  [one account-wide withdrawal, sharing chosen per story](https://github.com/He-Is-Real/monorepo/pull/154)).
- **Download my data** as one file ([download](https://github.com/He-Is-Real/monorepo/pull/151)).
- **Favourites:** private hearts on cards and story pages, and a My favourites page laid out like
  browse ([favourites](https://github.com/He-Is-Real/monorepo/pull/117),
  [same layout as browse](https://github.com/He-Is-Real/monorepo/pull/153)). My favourites is at
  /favourites, and signed-out visitors reach it from the header.
- **NEW badge** on stories published in the last 7 days ([badge](https://github.com/He-Is-Real/monorepo/pull/110)).
- **Browse and favourites load more on their own** as the reader nears the end, with no page cap
  ([no page cap](https://github.com/He-Is-Real/monorepo/pull/157)).
- **Themes:** admins manage theme categories and themes on one page; people choose themes when
  sharing and browse by them ([themes rebuild](https://github.com/He-Is-Real/monorepo/pull/162),
  [More themes unfolds in place](https://github.com/He-Is-Real/monorepo/pull/170), dev data fixes
  [#167](https://github.com/He-Is-Real/monorepo/pull/167) and
  [#168](https://github.com/He-Is-Real/monorepo/pull/168), which keeps an "Other" category that
  already exists).
- **Admin pages:** submission limits ([limits page](https://github.com/He-Is-Real/monorepo/pull/139)),
  themes, and consent texts.
- **Nightly clean-up** of abandoned drafts and leftover videos
  ([housekeeping](https://github.com/He-Is-Real/monorepo/pull/141),
  [runs the real build](https://github.com/He-Is-Real/monorepo/pull/146)). On dev it still runs
  in "report only" mode: it logs what it would delete and deletes nothing.
- **Direct uploads proven** on dev before building them ([upload test](https://github.com/He-Is-Real/monorepo/pull/123)).
- **Process rule recorded:** Joel owns data structure, API and behaviour decisions
  ([AGENTS.md rule](https://github.com/He-Is-Real/monorepo/pull/169)).
- The public API answers a repeated request from memory for up to 60 seconds, so busy pages ask
  the database far less; a withdrawn or hidden story can show for up to a minute (database
  review 2, Joel's decision R13; [#181](https://github.com/He-Is-Real/monorepo/pull/181)).
- **Database tidy before production** (database review 2, part A; Joel, 2026-11-05): the audit
  log goes (each legal text version records who published it instead), an erased account is just
  marked "deleted", the three write-fence tables become one, expired request keys are deleted
  nightly, admins can't delete upload, submission or review records, a heart's time comes from
  its id so it can't be backdated, the draft legal texts say super admins can see drafts, and the
  schema is split into one file per area. Dev's database was wiped once and rebuilt from scratch
  with its dummy data ([#182](https://github.com/He-Is-Real/monorepo/pull/182)).
- **One story table and its history** (database review 2, part B1; Joel, 2026-11-04/05;
  [#187](https://github.com/He-Is-Real/monorepo/pull/187)): the public copy of each story goes; the public reads the one story table, and the
  database shows it only published stories and their public fields. Every change of a story's
  status (submitted, picked up, approved, sent back, rejected, withdrawn, hidden, shown again) is
  a new line in the story's own history, never edited, saying who made it and when. Super admins
  can read every story, drafts included, with its history (API only; no page yet). "Download my
  data" now includes each story's whole history. Nothing else changes for people using the
  site. Dev's database was wiped and rebuilt once more.
- **Test clean-up** (Joel, 2026-11-05): unreliable tests fixed
  ([#185](https://github.com/He-Is-Real/monorepo/pull/185)), the low-value tests Joel approved deleted,
  and whole browser flows run on one phone and one desktop while every page's "fits the screen"
  checks still run on all 14 devices ([#186](https://github.com/He-Is-Real/monorepo/pull/186)).
- **Each story's files as their own records** (database review 2, part B2; Joel, 2026-11-05;
  [#188](https://github.com/He-Is-Real/monorepo/pull/188)): every uploaded video, audio file and picture gets its own record, and the story points
  at the ones it shows. A replaced or removed file is now deleted by the nightly clean-up once its
  upload link has expired (pictures were left behind before). An approval records which files the
  moderator reviewed, and a story hidden because its media broke comes back on its own only while
  it still shows those files. Search now looks at published stories only, so drafts can never
  shift its "best match" order (Joel's choice, option A), and it matches theme names too. A local
  scale test with 50,000 stories (run on a developer's machine only) found the browse lists and
  search too slow at that size; after reworking their queries, list pages take 15–90 ms (were
  2–5 s) and searching for a word in nearly every story takes 1.4 s (was 22 s). Renaming a theme
  carried by 15,000 stories takes about 43 s, accepted for now. The super admins' list of every
  story takes about half a second a page; a possible index is with Joel. Nothing changes for
  people using the site. Dev's database is wiped and rebuilt once more for it.

- **Tidy-up after the database rework** ([#189](https://github.com/He-Is-Real/monorepo/pull/189)): the code that reads a story's status says it in one
  place, and the developer notes on database permissions are cut to the rules in force. Nothing
  changes for people using the site.
- A signed-in request isn't cut off when the person's short-lived sign-in pass runs out partway
  through: slow work (submit, upload links, "Download my data") always runs on a fresh pass that
  api-user gets from Clerk for the same sign-in (Joel's decision T, option B, re-approved
  2026-11-06; [#165](https://github.com/He-Is-Real/monorepo/pull/165)).
- Browse and favourites cards barely move once the page has measured them: the server guesses
  each card's height for every narrow band of list widths, wrapping text with the site font's
  real letter widths, and a wrong guess can only hide a card's last line for a moment, never
  overlap the next card. Without JavaScript the cards show in one column (Joel's option B,
  re-approved 2026-11-06; [#163](https://github.com/He-Is-Real/monorepo/pull/163)).

**In progress (open pull requests):**

- "Download my data" gives people each video or audio as an MP4 file Bunny makes when it encodes
  it, and its links last 7 days instead of an hour (Joel's B and C1, 2026-11-06,
  `project/context/research/video-bundle-rethink.html`;
  [#191](https://github.com/He-Is-Real/monorepo/pull/191)). Bunny's MP4 copies start once the bunny
  root is applied; older videos have none. The browser removes a video's or audio file's location
  and device details before upload (Joel's M2, 2026-11-06), as an MP4 copy can keep the
  location.
- A video's own picture shown by Bunny's player (Joel's A, 2026-11-06) is built after the
  media-ready result writer, which it joins. The old video bundle
  ([#160](https://github.com/He-Is-Real/monorepo/pull/160)) is closed.

**Left in the M2 plan:**

- **Media ready:** when Bunny finishes processing a video, mark it ready with its real size and
  length, so moderators in M3 can approve video stories, through the background worker on Joel's
  machine (`project/context/research/m2-media-ready-plan.html`). **In progress.** First part
  built: a job table so no media job is ever lost (each job is written down before it is
  queued), the queue in London, Bunny's signed "finished", "failed" and "deleted" notices to
  api-user, and the result writer the worker calls directly, which records the answer on the
  video's file and ends the job in one step (and ignores an answer older than the last one it
  recorded, so a late answer can't undo a newer one). A job that fails 5 times is marked "gave up"
  instead of going to a dead-letter queue. Second part built: every evening at 18:00 UK time
  (when Joel's machine is on) unfinished jobs not sent for 12 hours are sent again, and the
  nightly clean-up deletes finished jobs after 30 days; a moderator can't approve a story while
  its file could still be replaced through its upload link (an hour; a picture 10 minutes) or
  while one of its media jobs is open, and a SuperAdmin can approve anyway, which is recorded.
  Third part built: the media worker on Joel's machine (`apps/media-worker` with Dapr beside it,
  started with `tools/scripts/media-worker.sh`), signed in through Joel's own Google login acting
  as the narrow media-worker account. It checks each video at Bunny and gives the result writer
  the answer. Media ready works end to end once Joel runs it; while his PC is off or his Google
  sign-in has lapsed, jobs wait and it catches up. The nightly clean-ups and the 18:00 resend
  now really act on dev instead of only logging (Joel, 2026-11-07). Still to come: the audio
  clip's picture video, and the 40-byte picture check at submit.
- **Closing M2:** a final check of this file and a "run it and try" walk-through on dev.

**Dropped or moved out of M2:** the personalised home and "New for you" (replaced by the NEW
badge); seen tracking; submission emails (moved to the Emails milestone); editing a story that
was sent back for changes (moves to M3 with moderation).

## M3: Moderation ⚪

Not started. Planned: a moderation queue, a review view with approve, request changes, reject
and escalate, feedback the person sees on their profile, and assigning the moderator role.
Needs "Media ready" from M2 before video stories can be approved.

## M4: Donations 🟡

**Done and on dev (Stripe test mode):** the Donate page offers One-off or Monthly and shows
Stripe's own button for the choice; Stripe's page takes the payment, so we never handle card
details ([Stripe set-up](https://github.com/He-Is-Real/monorepo/pull/122),
[buttons on](https://github.com/He-Is-Real/monorepo/pull/135), framed in a centred card
[#137](https://github.com/He-Is-Real/monorepo/pull/137) and
[#142](https://github.com/He-Is-Real/monorepo/pull/142)).

**Not started:** recording donors in our database (Stripe tells us about each gift), and Gift
Aid (after the charity is registered).

## M5–M8 ⚪

Not started.

## Known issues

- **Database restarts (Spot), built 2026-11-07:** the services notice when the database is
  restarting, public pages keep working from the last copy, and everything else shows a calm
  "restarting, refresh in about 2 minutes" message. Not covered yet: a copy of an API that starts
  while the database is away still fails to start (Google then shows its own error page), and the
  legal text pages show their usual "can't be shown" message rather than the restarting one.

- **The nightly clean-up only reports on dev.** It will start deleting once someone has read a
  night's report and it looks right.
- **Temporary database build.** Dev runs a patched SurrealDB 3.2.4 so it accepts Clerk's sign-in
  tokens. It misses security fixes from later SurrealDB versions. It must be replaced by the
  official release once that includes the fix, and before any real data.
- **Stripe's monthly-gift portal:** a bug in the Stripe tool we use means the portal's
  "change the amount" setting can't be managed in code. Dev keeps the setting it already has; it
  must be fixed before donations go live.
- **While audio plays, Bunny shows its own placeholder picture** instead of the story's picture.
  Kept for now.
- **Old encrypted-state copies** expire around 2026-11-28; check once then that they're gone.
- **Spot servers are pinned to one London zone** until the Google billing account is upgraded.

## What blocks Go live

Before the 24 real testimonies come in ("Real stories"):

- The four consent texts are drafts today ("to be reviewed before go-live"). Real, checked
  versions must be published, and the privacy notice must name everything it has to (Bunny.net
  and Germany for video storage, the record of deleted accounts, where background processing runs).
- Media links must last about an hour or less (dev uses 6–7 hours), and deleting an account must
  cut off links already handed out.
- How the 24 existing storytellers' agreement is recorded must be decided.
- The CI planning account must stop reading dev's logs.
- The official SurrealDB release must replace the patched build.

Before the site goes public ("Go live"):

- The organisation admin's one-time Google set-up, then switch on the organisation-wide "UK
  only" settings (they are postponed for dev).
- A front door for the heisreal.today domain, Clerk's production instance, and moving from
  Squarespace.
- Stripe's portal fix (above), then the switch from test mode to live payments.
- Background processing on church hardware needs disk encryption and physical security once it
  holds real data.

Before anything is posted to social media: decide how a withdrawn or deleted story, or a deleted
account, takes down copies on our own channels (two decisions disagree; see "Needs Joel to
confirm" in how-the-app-works.md). Nothing does that yet, and nothing posts yet.

Before public submissions open: emails must work, so nobody shares a testimony without a
confirmation (decided, D95).

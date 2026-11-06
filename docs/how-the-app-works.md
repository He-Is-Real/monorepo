# How the app works

The rules for how the He Is Real Today site behaves, by area, in plain words: who can do what,
the limits, and what we keep and delete. Progress (what is built and what is next) is in
[delivery-status.md](delivery-status.md).

- These are the rules **in force**. Rules that were later replaced are left out; git history and
  the `project` repo's decision documents keep them.
- Where a rule here differs from the `project` repo's plan or older documents, **this file wins**.
- **Joel owns these rules** (AGENTS.md: data structure, API and behaviour). Nobody changes or adds
  a rule without Joel's decision. Record the change here in the same pull request that builds it.
- Each rule marks whether it is **built** (on the dev site) or **planned** (a later milestone).
  Rules without a mark are built.
- The bracketed codes, like (D71), point to the decision record in the `project` repo
  (`context/research/*.html`), for anyone who needs the reasoning.

**Last updated:** 2026-11-06

## Needs Joel to confirm

Sources disagree on these, or it isn't clear the decision still stands. Until Joel answers, the
code does what it does today; nobody should build on either reading.

1. **Recording in the browser.** The M2 decisions (2026-10-25) say people can record video or
   audio in the browser as well as upload a file; the delivery plan calls recording a future
   idea, and nothing records today. Is in-browser recording still wanted, and when?
2. **Accounts that never agree to the terms.** Earlier M2 decisions said an account that never
   ticks the terms box is deleted after 30 days. Plan 4e keeps such an account with no agreements
   and doesn't mention the clean-up, and nothing deletes them today. Does the 30-day rule stand?
3. **Taking down our own social media posts.** An earlier decision (D107) says that when sharing
   is withdrawn we take the story off our own channels and stop paid promotion within 30 days.
   Plan 4e's sharing text says sharing can't be withdrawn and a takedown is "on request, with
   care". Which applies before the first post? (delivery-status.md lists the takedown as a gate.)
4. **Publishing a withdrawn story again.** D61 says giving consent again doesn't republish a
   story, and planned a "publish my story again" option. Plan 4e removed consent withdrawal, so
   this is about withdrawn stories only. Is "publish my story again" still wanted?
5. **Editing a published story.** Today a person can edit only a draft or a story sent back for
   changes. Older decisions say "a story changed after it went public needs approving again",
   which suggests published stories could be edited. Can a person edit a published story (and so
   send it back for review), or only withdraw it?
6. **A notice when the privacy notice changes.** Plan 4e (8b) says changes that matter are
   announced with a banner on the next visit (and later by email). Only the testimony-consent
   banner is built. Is a privacy-notice banner wanted before Go live?
7. **Bunny Optimizer.** Joel chose (2026-10-30, picture checks) to add Bunny Optimizer, which
   rebuilds every picture on the way out (about $19 a month). It is off in our infrastructure
   code ("nothing that costs extra") and was never tested with signed links. Still wanted?
8. **Checking pictures at submit.** The same decision says the server reads the start of each
   picture at submit to check it really is a clean WebP of the recorded size, and refuses one
   that still carries hidden data such as location. Today submit checks only that the picture
   arrived. Should the deeper check be built?
9. **Stripe's embedded Checkout.** The donate-button decision (2026-10-30) said Stripe's embedded
   Checkout would replace the Buy Buttons in M4. Is that still the M4 plan?
10. **Trusted submitters' hourly limit.** D94 says trusted submitters keep the hourly upload
    limit "but raised"; today they keep the same 10 an hour. Should it be higher, and how much?
11. **Who gives people the Moderator role.** The security review says only a Super Admin assigns
    roles; the delivery plan says admins assign the moderator role. Which (planned, M3/M5)?
12. **Spam and safety checks on sharing.** The security review plans a CAPTCHA on the share
    form, a verified email before the first story, and virus scanning of uploads. None of these
    is in a later decision or built. Are they still planned, and for which milestone?

## Accounts and sign-in

- Anyone can read, watch and listen to public stories without an account.
- People sign in with Google or with their email address. With email they use a one-time code
  or, if they choose, a password of at least 8 characters that is checked against known leaked
  passwords. One account per verified email: signing in with Google on the same email joins the
  same account. (D2)
- There is no Sign in with Apple and no Apple-only technology. Apple Pay through Stripe is fine.
- CAPTCHA and lockout after repeated failures are on. Two-step sign-in and passkeys are off for
  now (they need Clerk's paid plan; decided with moderation, M3). (D2)
- **Adults only.** The site isn't for children: signing up and sharing need the person to be 18
  or over, which they confirm by agreeing to the terms of use. There is no parental-consent route
  and no date of birth is stored. Reading needs no age check. (D77)
- Our sign-in provider, Clerk, keeps the person's email, name and password; our database keeps
  only a link to their Clerk account. Clerk is hosted in the US, which is accepted. (D16, D6)
- People change their name, email and password in Clerk's own account panel, opened from My
  profile. There is no country, display name or notification setting. (D81)
- Roles, lowest to highest: Viewer, User, Moderator, Admin, Super Admin. Roles are set in Clerk;
  someone without one is a User. (D1)
- The parts of a page that are about the signed-in person (hearts, their stories, their profile)
  are filled in by the browser, with space kept so nothing jumps. Pages for signed-in people
  need JavaScript. (D83)
- If someone else signs in on the same browser while a form is open (for example in another
  tab), nothing is saved under the new person's name: the form starts again for them. Signing
  out clears what the share page kept in the tab.
- A deleted account can never come back: its Clerk sign-in can't create an account again.
  Signing up afresh with the same email makes a new, empty account. (D82, D90)

## Consent, privacy and terms

This is "plan 4e" (Joel, 2026-10-31 and 2026-11-01).

- There are four texts: the **terms of use** (which include being 18 or over), the **testimony
  consent** (keeping and publishing your stories, which are special-category data under GDPR
  Article 9), the **social media sharing consent** (per story, optional) and the **privacy
  notice**. Each has numbered versions from 0; a saved version can never be changed or deleted.
- **Sign up:** one box, "I am 18 or over and agree to the terms of use".
- **Before the first story:** the person agrees to the testimony consent, once for their
  account. Agreeing to a newer version covers their earlier stories too. (D85)
- **At the end of sharing a story:** an optional, unticked box to let us share that story on
  social media, naming every platform. It is chosen per story. It can't be withdrawn on its own:
  withdrawing or deleting the story stops any further sharing, but copies already posted can't
  be recalled.
- **The privacy notice** is shown and linked next to every box. Nobody ticks it, and nobody is
  recorded as having read it. It is called "privacy notice" everywhere.
- Boxes are never ticked in advance.
- **Agree first:** the database refuses to start, edit, upload or submit a story until the
  person has agreed to the latest terms of use and testimony consent, and refuses a heart until
  they have agreed to the latest terms of use.
- **When a text changes:** the person sees what changed (the old words struck through, the new
  ones marked) and the full text, and agrees again before carrying on. A banner after sign-in asks
  them to, for the testimony consent; it never shows on the share page (which asks within the
  flow), and "Not now" hides it for that page only. An upload refused for this reason opens the
  same agree-again screen, and the upload carries on once they agree.
- Withdrawing or deleting your own story never needs a new agreement.
- A story can be approved if its writer has agreed to a testimony consent (any version); a newer
  version stops them starting, editing or submitting stories until they agree again.
- If the sharing text changes while someone is submitting, the submit is refused, the draft is
  kept, and they see the new text and decide again.
- Nothing is shared beyond heisreal.today until the story is public there.
- Agreeing to the testimony consent doesn't waive the person's right to object to how their
  story is edited or presented.
- Published stories stay up when a text changes.
- A person can only agree to the latest version, and only to the version the page showed them.
  The time recorded is the database's.
- **Admins and Super Admins publish new versions** at the consent admin page: a text box, the
  changes against the current version, a preview, then confirm. A saved version is in force at
  once, and records which admin published it.
- **Withdrawing:** deleting the account withdraws everything; withdrawing or deleting a story
  withdraws it for that story. There is no other withdrawal.
- Version 0 of each text is a draft written from how the system works today ("Draft, to be
  reviewed before go-live"). Everyone who had an account when plan 4e arrived on dev was recorded
  as agreeing to version 0 of the terms of use and the testimony consent. The testimony consent
  and the privacy notice say who sees a story before it is public: while it's a draft, the person
  and a small number of super admins (for support and safety); while it's waiting for review, the
  person and our moderators. (Joel, 2026-11-05; the super admins' view is in api-admin, R15, with
  no admin page yet.)
- **Cookies:** the site uses only essential cookies and storage (sign-in, the light or dark
  choice, the video player's own settings), so there is no cookie banner, only a footer note
  linking to the privacy notice. Anything non-essential later (analytics, error replay) needs the
  visitor's opt-in first.
- **Contact** is an email link (info@heisreal.today), not a form, until emails exist.

## Sharing a story

### Types

- A story is one of three types: **written** (text, with an optional picture), **video** (one
  video, with optional text) or **audio** (one audio file, with optional text). (D53)
- A written story's picture, an audio story's picture and a video's own thumbnail can all be
  uploaded. Decided and being built: a video's own picture is sent to Bunny as its thumbnail
  when the person sends the story for review, and the story can't be approved until it is set. An audio story without its own picture shows the site's default waveform picture.
- The person chooses the name shown on the story (an optional first name). Without one, the
  story shows "Anonymous".

### Steps

- The share page goes: choose the type → the testimony consent (only if not yet agreed to the
  latest) → preparation prompts (never stored) → write, or upload the file → details (optional
  first name, themes) → review (with the optional social media box) → "waiting for review".
- **Autosave:** the draft is saved once it has a title and text, then after each pause. If the
  same draft is open in two tabs, each keeps its own changes, and the person is asked only when
  both changed the same thing. Text stays in the tab until the server has it, through reloads and
  outages. (D70)
- Pressing submit twice doesn't create two drafts or two submissions.
- After sending for review, the page promises no email (there are none yet): "Our team reads
  every story before it's published".
- If a theme the person picked is deleted while they are sharing, submit asks them to choose
  again.

### Limits (admins can change these)

| Limit                         | Today                           |
| ----------------------------- | ------------------------------- |
| A written story's text        | 200 to 10,000 characters        |
| Video and audio stories' text | no minimum, at most 10,000      |
| Title                         | at most 140 characters          |
| Themes on a story             | 1 to 5, counted when submitting |
| Open drafts per person        | 3                               |
| Stories sent for review       | 1 in any 7 days                 |
| Video and audio uploads       | 5 in any 7 days                 |
| Upload requests (any file)    | 10 an hour                      |
| Video file size               | 4 GB                            |
| Audio file size               | 500 MB                          |
| Video and audio length        | 15 minutes                      |

- Pictures never count towards the 7-day upload limit. (D113)
- Invisible zero-width characters count towards the 200-character minimum. (A2)
- **Trusted submitters** have no open-drafts or weekly limits, only the hourly upload limit. An
  admin can also set a person's own limits. (W3, D112) There is no admin page for that yet.
- **New limits apply to everyone at once** (no "grandfathering"): every later action must meet
  the limits in force. An edit over a maximum is accepted only if it doesn't make it worse, so a
  long draft can still be trimmed; submitting needs every current minimum and maximum. (D94)
- The share page shows what's left this week ("2 of 3 stories left…") before a limit is reached.
  At a limit it explains kindly, says when the person can carry on, and holds that step back.

### Uploads

- Files go straight from the person's browser to Bunny.net; our servers never handle the files.
  Video and audio show progress, can pause and resume, and carry on after a reload.
- **Our server, never the browser, decides which file belongs to a story**, so nobody can point
  their story at someone else's media. (D80, D65)
- One video or audio file per story; replacing it deletes the old one at Bunny at once.
- Sending for review checks that the file arrived and is within the limits.
- Pictures are converted in the browser before upload, so no location or camera data leaves the
  device: WebP, at most 2048 pixels on the long side, at least 200 pixels a side, at most 5 MB,
  and no more extreme than 1:3 or 3:1. A description for screen readers is optional, on every
  type.
- Uploaded videos and audio are stored by Bunny in Frankfurt, Germany (Bunny doesn't offer
  London); pictures are stored in London. (D89)
- Nothing personal is stored at Bunny: a video's title there is just the story's id. (D69)

## My profile, withdraw and delete

- **My submissions** lists the person's stories, each with its status in plain words and any
  feedback from a moderator.
- **Drafts:** continue or delete. Each draft says when it will be deleted if nobody touches it.
- **Withdraw:** a story waiting for review, in review, sent back for changes or published
  (including one hidden while its media is fixed) can be withdrawn; it leaves the public site at
  once.
- A story hidden because its media broke shows to its owner as published, as before: they can't
  act on it, and it comes back by itself.
- **Delete:** a person can delete their own draft, a story sent back for changes, a withdrawn
  story or a rejected one. A story waiting for review, in review or published must be withdrawn
  first. Deleting a story also deletes its videos and pictures and everyone's hearts on it. (D71)
- Editing a story that was sent back for changes comes with moderation (planned, M3).
- **Delete my account** is the one account-wide withdrawal. The page says what goes and what
  stays and asks the person to type "delete". It deletes their stories, videos, pictures, hearts,
  limits and records, deletes them at Clerk (which signs them out everywhere), and keeps a
  fingerprint of their sign-in so it can't create a new account. What's left of the account is
  marked deleted, with no date and no reason. Deleting the person in Clerk's dashboard does the
  same. (D82, D88, O4)
- **Download my data** gives one file of everything we hold about the person, explained in plain
  words: their stories in every status, each story's whole status history (their own submits and
  withdrawals, moderators' decisions with their comments, signed "moderator" and never who made
  them, and the site's own hides and shows while a video can't play; R6, Joel 2026-11-05), what
  they agreed to and when, their hearts, their limits and their sign-in details from Clerk. Videos,
  audio and pictures come as links that last one hour today. Decided (Joel, 2026-10-31) and being
  built: Bunny keeps the original upload, and the file's links let the person watch and download
  the original for 7 days. The file says what it leaves out (who moderated, Clerk's sessions
  and devices, anyone else's data). If Clerk
  can't answer, there is no file rather than a partial one.

## Favourites

- A signed-in person can heart a story on its card or its page. Hearts are private: only the
  person can see theirs, and there are no counts.
- Only a story that is public can be hearted. A story that stops being public stays hearted but
  no longer shows.
- Signed out (or before agreeing to the terms), hearts are kept in the browser only, with no
  expiry, and never sent to us. After signing in, the site offers to add them to the account;
  they are added only if the person chooses to.
- Seeing or removing your hearts never needs an agreement.
- Planned: a story's owner sees how many hearts each of their stories has, never who gave them.
- My favourites shows the newest heart first, laid out like browse, and loads more on its own.
- A heart's time is the moment it was made, taken from its id; nobody can set it by hand.
  (Joel, 2026-11-05)
- Deleting the account deletes the person's hearts; deleting a story deletes the hearts on it.

## Browse and themes

- **Only approved stories are ever public.**
- **Home** shows the 3 newest stories ("Recently shared") and a row of highlighted themes per
  category. **No story is ever featured or pinned:** it would be unfair to everyone else. (A4)
- **No story counts anywhere:** no totals and no counts per theme. (D62) No made-up figures:
  the impact numbers on home stay hidden until real ones exist.
- **NEW badge:** a story is "new" for 7 days after it is published. Nothing is stored per person;
  there is no personalised home or "New for you". (D72)
- **Browse** has search, sort, format and theme filters. Cards are laid out in balanced columns
  at each picture's own shape (limited between tall 9:16 and wide 2:1) and never move once shown.
  More stories load on their own as the reader nears the end, to the end of the list, with an end
  message. Without JavaScript there is a link to the next page. (D55)
- **Search looks at published stories only.** Its "best match" order compares each story only
  with the other published stories, so drafts and unpublished stories can never change a score,
  the order or where "load more" carries on. The database keeps the published stories' words in
  their own search table and updates it in the same step as a story is published or stops being
  published. (Search option A, Joel 2026-11-06)
- **Search also matches theme names.** A story's search words are its title, description,
  written text and the current names of its themes, all counting equally (category names
  aren't included). Renaming or deleting a theme updates the stories that carry it straight
  away. (Joel, 2026-11-06)
- **Themes** are grouped in categories that admins manage. One category, "Other", is fixed: it
  can't be renamed or deleted and takes the themes of a deleted category. A theme with no
  published stories is hidden unless it is highlighted. (D130, D63)
- Cards of video and audio stories play in place when pressed, one at a time on the page. Nothing
  ever plays on its own.
- A **story page** shows the player, picture or text, and 3 related stories (shared themes first,
  then newest). Long written stories show about the first 600 characters with "Continue reading",
  unless that would hide fewer than 100 characters. (A1)
- If a story's title changes, its old address redirects to the new one.
- Sharing links use the site's brand picture, not the story's.
- Video, audio and pictures load only through signed links that expire (6 to 7 hours on dev).
  (D52, D64)
- **Public pages may show a change up to 60 seconds late.** The public API keeps recent answers
  in memory for a minute, so a story that is withdrawn, deleted or hidden, or a new or edited one,
  can take up to 60 seconds to disappear or appear. Never longer: browsers and any future CDN
  may keep an answer only for the part of the minute it has left. Nothing personal is kept this
  way. (R13, Joel 2026-11-05)
- Every page works from 320-pixel phones to large desktops, in light or dark (following the
  device, with a switch), with text enlarged to 200%. Body text sits in a reading column of at
  most about 80 characters a line.
- The About and Next Steps pages play the founder's videos.

## Moderation

Built in the database (the pages and the queue are planned, M3):

- A story's statuses: draft, waiting for review, in review, approved, sent back for changes,
  rejected, withdrawn, and hidden (approved, but off the site while its media is fixed, or
  hidden by a moderator).
- **Each story has a status log (R6, Joel 2026-11-04/05):** every change of status is a new
  entry, never edited or deleted while the story exists, saying who made it (the person, a
  moderator or the system), when, and which edit of the story it was about. A moderator's entry
  can carry a note to the person. The story's status is its newest entry; a story with none is a
  draft. Who may add which status is fixed in the database: the person submits (from draft or
  sent back) and withdraws; a moderator picks up, decides, hides and shows again; the system hides
  and shows again when media breaks and works again.
- **A story can't be approved until every upload is processed** and its size and length are
  known, so nothing unchecked reaches the public. (A2)
- **Media ready (M2 plan item 13; D76, D78):** when Bunny says a video or audio file finished
  encoding or failed, the media worker asks Bunny itself and the result writer records the answer
  on that file only: ready with its real size, length and Bunny's thumbnail; still encoding;
  or failed (also when Bunny no longer has it). An answer about a file the story no longer
  shows is dropped. Built: Bunny's notice, the queue and the writer; the worker on Joel's machine
  is the next piece, so until it runs, files stay "not processed yet". An audio file's picture
  is set by a later step (D127), so audio stories can't be approved until then.
- **An approved story whose media breaks is hidden, not un-approved**, and comes back on its own
  when the same files work again: the approval records which video or audio file and which
  picture the moderator reviewed, and the story shows again only while it still points at both.
  A new video or picture counts as a change, and the story stays hidden until a moderator looks.
  (D60, R12)
- **A replaced file is deleted once its upload link has expired.** When a story stops pointing at
  a video or picture, the nightly clean-up deletes it at Bunny or in the images storage zone
  once no upload link for it can still be used (2 hours), and forgets the file once it no longer
  counts towards the 7-day upload limits. (R12)
- Moderators and admins can never change the words of someone's testimony. (D41)
- A person can read moderators' decisions and feedback on their own stories, never who made them.
- The status log is the moderation history; there is no separate audit log (Joel, 2026-11-05).

Planned (M3):

- A queue of stories waiting for review, oldest first. A moderator picks one up, which locks it
  for them, and can release it.
- The review view: the player (with playback speed), the text, themes and submitter details,
  with Approve, Request changes, Reject and Escalate. Reject and Request changes need feedback,
  written pastorally, which the person sees on their profile.
- A story changed after it went public needs approving again. (D59, D66)

## Donations

- The Donate page offers **One-off** or **Monthly** and shows Stripe's own button for the
  choice. Stripe's page takes the payment, so we never handle card details. (D116)
- One-off: the donor chooses the amount, from £1 (starting at £10). Monthly: the donor chooses
  how many £1s a month (1 to 999, starting at 10). Monthly donors can change or stop their gift
  through Stripe's donor portal.
- Dev uses Stripe's test mode only. Nothing about donors is stored in our database yet; Gift Aid
  comes after the charity is registered (planned, M4).

## Admin pages

- **Limits** (Admin and above): the submission limits in plain words with their units; Save
  lists the changes and asks to confirm. If another admin saved meanwhile, the page asks to
  reload. The settings keep the name and role of the admin who changed them last; there is no
  history of changes (no audit log, see Moderation).
- **Themes**: categories and themes on one page (drag on desktop, tap or keyboard on phones),
  delete confirmed by typing "delete <name>", and one Save for the whole picture. Deleting a theme
  removes it from every story. If someone else saved meanwhile, the page asks to reload.
- **Consent texts** (Admins and Super Admins): publish the next version of any of the four texts
  (see "Consent, privacy and terms").
- The database can list stories hidden because their media broke or changed; there is no admin
  page for it yet.
- **All stories** (Super Admins only, R15, Joel 2026-11-05): a read-only list of every story in
  every status, drafts included, and each story with its status log and files. Moderators and
  admins see stories from "waiting for review" on, through moderation. Built in api-admin; there
  is no admin page for it yet.
- Theme and category names are tidied (trimmed, single spaces, capital first letter); a
  duplicate name is refused. Deleting a category moves its themes to "Other", not highlighted.
- Planned (M5): the dashboard, the user list and role management.

## Data kept and deleted

- **Abandoned drafts:** a draft nobody has touched (no edit, no resumed upload) for 186 days
  (about 6 months) is deleted, with its files, by the nightly clean-up at 03:30 London time.
  (D71) The emailed warning before that comes with the Emails milestone.
- **Leftover videos** at Bunny that no story uses, older than 48 hours, are deleted by the same
  nightly clean-up. It deletes at most 50 of each kind a night. It started in "report only" mode
  and switches to real deletions after a night whose report looks right (on dev it still only
  reports).
- **Deleting an account** (see "Delete my account") keeps only the account record marked deleted
  and the sign-in fingerprint. Their files at Bunny and their Clerk account go straight after;
  anything that fails is retried. (D39, D40, D82)
- The record of what a person submitted in the last 7 days (for the weekly limit) is kept 7 days
  and deleted with the account. Upload records stay when a story is deleted, so the upload limits
  still count them.
- **Request keys** (which stop a resent request being applied twice) are deleted by the nightly
  clean-up once they expire, 24 hours after the request. (Joel, 2026-11-05)
- Backups are nightly, in the UK, and age out; they aren't edited after a deletion.
- Our services' logs are stored in London for 30 days. (D101)
- **Where data lives:** in the UK wherever possible (London), declared in our infrastructure
  code. Exceptions: video and audio files at Bunny in Frankfurt (D89); Clerk in the US (D6);
  Bunny's delivery network serves files worldwide.

## Dev and test environment

- Milestones M1 to M8 are built and tested on the dev site only, with made-up stories. Then
  "Real stories" brings in the 24 existing testimonies, then "Go live" opens the real site, then
  Emails. (D46, D87)
- The dev site uses Google's own web addresses (`*.run.app`); heisreal.today stays with the
  prototype until Go live. Dev isn't listed by search engines. (D7)
- Dev has about 25 obviously fake stories covering every type and status, with fake people and
  short test videos. "Reset dev data" puts it back in about a minute. (D47, D49)
- Automatic tests sign real test people in on dev after each deploy, and clean up what they
  upload. Dev's test accounts are trusted submitters (never outside dev). (D50)
- **Public submissions open only once emails work,** so nobody shares a testimony without a
  confirmation. Go live may put the site up first; the 24 imported testimonies need no emails.
  (D95, D87)
- Error tracking (Sentry) and visitor statistics (Umami) are not part of this phase. (D5)
- YouTube is a later feature; Bunny.net is the only video host. (D8)

## Technical decisions

For developers. Details are in the linked documents.

- **Services:** the website (`web`), `api-public-read` (anonymous, published stories only),
  `api-user` (the signed-in person) and `api-admin` (moderators and admins). Services never call
  each other, and each signs in to the database as its own least-privilege user. (D13, D33, D36;
  [db-permissions.md](db-permissions.md))
- **The website's server reads only `api-public-read`**; Clerk runs in the browser only, and the
  server never reads, logs or forwards the sign-in cookie. A lint rule guards against mistakes.
  (D31, D32; `apps/web/README.md`)
- **Personal reads run as the person,** so the database itself keeps everyone else's rows out.
  (D27)
- **A person's request isn't cut off when their sign-in pass runs out midway** (decision T,
  option B, Joel 2026-10-31, re-approved 2026-11-06). Clerk's pass lasts 60 s and the database
  library ends the person's session when it expires. So quick work uses the person's own pass
  while it lasts 10 s more, and slow work (submit, an upload link, Download my data) always runs
  on a fresh 6-minute pass api-user gets from Clerk for the same sign-in, and starts no new try
  after 2 minutes. The work still runs as the person. Clerk saying the sign-in is over is `401`;
  Clerk not answering is `503 sign_in_unavailable` (try again). api-admin has no Clerk key and
  uses the person's own pass. ([db-permissions.md](db-permissions.md))
- **One story table (R11, Joel 2026-11-04/05):** the public reads `story` itself, and the database's rules show it only approved stories and only
  their published fields. Each story's status lives in its status log (`storyStatusLog`, R6),
  never edited; the story points at its newest entry. (D25, R6, R11;
  [db-permissions.md](db-permissions.md))
- **API conventions:** commands for state changes, CRUD for plain resources, `version` and
  `If-Match` on every changeable record, RFC 9457 errors, no totals. The OpenAPI specs in
  `libs/contracts` are the source of truth. (D23, D28–D30; [api-conventions.md](api-conventions.md))
- **Database:** self-hosted SurrealDB, a single node in production too, on private GKE; nightly
  backups. Schema changes run as a migration Job; the schema is one file per area. Before
  production, dev's database may be wiped and rebuilt from scratch through that Job instead of
  migrating its test data (a one-off switch in OpenTofu's dev settings that nothing else can
  use). (D9, D14; Joel, 2026-11-05; `infra/k8s/surrealdb/README.md`)
- **Temporary patched SurrealDB:** v3.2.4 built with the upstream fix so it accepts Clerk's
  tokens, until an official release has it. (D111; `infra/k8s/surrealdb/README.md`)
- **Infrastructure:** OpenTofu for every cloud change, encrypted state, one approval per apply;
  dev plans that only change image versions apply themselves. (decision 3, D54, D57, D120;
  AGENTS.md, `infra/terraform/README.md`)
- **Clerk's settings are code** (`infra/clerk/dev.json`), applied with the Clerk CLI: the one
  exception to "everything through OpenTofu". (decision 17; `infra/clerk/README.md`)
- **Nothing on GKE is reachable from the internet;** public entry points are Cloud Run only. No
  load balancer. (D3, D4; AGENTS.md)
- **Background work (Dapr)** runs off Google Cloud, on Joel's machine and later church
  hardware, pulling from Pub/Sub; a private Cloud Run service writes results. (D78) Work waits in
  Pub/Sub (in London, up to 31 days) while that machine is off; the worker signs in with Joel's
  own gcloud login acting as a narrow `media-worker` account, never a key file (D126), and uses
  only Dapr's Pub/Sub part, with nothing stored on the machine (D129). Media ready is the first
  such work (`docs/media-runbook.md`, "Media ready").
- **No CDN in front of the site or APIs in dev;** browsers and CDNs are told not to keep API
  responses in dev. (D51) api-public-read keeps public answers in its own memory for at most 60
  seconds, per running copy, with no timers, so Cloud Run still bills only per request and scales
  to zero. (R13)
- **Budget:** £15 a month with alerts at £3, £7.50 and £15. (decision 10)
- **Tests measure behaviour** (AGENTS.md; test clean-up T1–T10, 2026-10-24).
- **Dependencies** update through Renovate. (D106)

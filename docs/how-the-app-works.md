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

**Last updated:** 2026-11-09

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
8. **Stripe's embedded Checkout.** The donate-button decision (2026-10-30) said Stripe's embedded
   Checkout would replace the Buy Buttons in M4. Is that still the M4 plan?
9. **Trusted submitters' hourly limit.** D94 says trusted submitters keep the hourly upload
   limit "but raised"; today they keep the same 10 an hour. Should it be higher, and how much?
10. **Spam and safety checks on sharing.** The security review plans a CAPTCHA on the share
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
- Roles, lowest to highest: Viewer (not signed in), User, Moderator, Admin (Joel, 2026-11-11:
  the old Admin became Moderator, the old Super Admin became Admin). Roles are set in Clerk, on the
  person's account (`publicMetadata.role`), and travel in their sign-in token, which api-admin reads
  on every request; someone without one is a User. (D1, G8 B)

  | Role      | Can do (G24, Joel 2026-11-11)                                                                                                                                        |
  | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | User      | Share stories, hearts, their own account                                                                                                                             |
  | Moderator | The moderation queue: approve, send back, reject, hide and show again (today: read the queue and each story; the decisions come with M3)                             |
  | Admin     | Everything a Moderator can, plus themes, submission limits, legal texts, "approve anyway", reading drafts (every story), the block list (planned) and the Staff page |

- **Staff (S-1 to S-4, G7, G8 B; Joel 2026-11-11):** Admins add, change and remove Moderators and
  Admins on the Staff page (`/admin/staff`). Only `@heisreal.today` emails can be staff (G7). Each
  change goes to Clerk first (the person's role, or, for someone with no account yet, a Clerk
  invitation carrying it, with no invitation email), then to the staff list in our database. A
  change takes effect within about a minute (the sign-in token's lifetime). There is always at least
  one Admin: removing or demoting the last one is refused.
- **Baseline admins (S-4):** `info@heisreal.today` and `joel@heisreal.today`, listed in
  `apps/api-admin/src/app/staff/baseline-admins.json`. Each time api-admin starts (every deploy,
  and after it has been idle), it makes both Admin in Clerk and on the list, adding them back if
  missing; it never removes anyone. So removing one on the Staff page lasts only until then, which
  the page says.
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
- **Admins publish new versions** at the consent admin page: a text box, the
  changes against the current version, a preview, then confirm. A saved version is in force at
  once, and records which admin published it.
- **Withdrawing:** deleting the account withdraws everything; withdrawing or deleting a story
  withdraws it for that story. There is no other withdrawal.
- Version 0 of each text is a draft written from how the system works today ("Draft, to be
  reviewed before go-live"). Everyone who had an account when plan 4e arrived on dev was recorded
  as agreeing to version 0 of the terms of use and the testimony consent. The testimony consent
  and the privacy notice say who sees a story before it is public: while it's a draft, the person
  and a small number of admins (for support and safety; version 0's words still say "super
  admins", the old name of today's Admins); while it's waiting for review, the person and our
  moderators. (Joel, 2026-11-05; the admins' view is in api-admin, R15, with no admin page yet.)
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
  uploaded. A video's own picture is sent to Bunny as its thumbnail once its check finds the
  video ready, and again whenever the picture changes or is taken off (then Bunny shows its own
  frame again); the story can't be approved until Bunny shows the picture it has now
  (video-bundle-rethink part A, Joel 2026-11-06). The story page shows Bunny's player as before,
  with no picture of our own over it (Joel, 2026-11-08, T2). Only one writer at a time may change
  a video's picture at Bunny: it takes a lock on the video's record (for 2 minutes), reads the
  story's picture, tells Bunny (giving up after 20 seconds), and records it, lets go and closes
  the video's check only if the picture is still the one it sent (sending the new one first if it
  changed). The database's clock judges the lock, never a writer's own. The lock has three states
  (Joel, 2026-11-08, T3: "a lock field is fine"; 2026-11-09, T4: A):
  - **empty**: Bunny confirmed the picture; approval may go ahead (if nothing else holds it);
  - **in the future**: a writer is at work; approval waits and other writers try again later;
  - **in the past but not emptied**: unfinished, Bunny may show another picture (Bunny refused,
    was slow, or its reply was lost); approval still waits, and any later writer may take it over
    and finish.
    Only a write Bunny confirmed and the database recorded empties it; a failed or cut-off call, a
    lock running out or the check giving up after 5 failures never does. The nightly housekeeping
    opens a check of any video left unfinished with no check open, and the 18:00 resend sends it, so
    it is retried rather than stuck. What people see: such a story's moderator gets "can't approve
    yet: still processing" until a try succeeds; an Admin can still approve anyway, as with any
    open job. So a picture the person removed can't go public through a moderator approving in
    between.
- **An audio story becomes a picture video (Joel, 2026-11-07, audio-picture-video.html):** once
  its audio file is ready at Bunny, the media worker makes a video of the story's picture (or,
  without one, the site's default waveform picture) in the picture's own shape, at most 1280 px
  on its longer side, with the sound unchanged, and uploads it to a new Bunny video. The story
  then shows that video instead of the audio file, keeping its edit number; the audio file is
  deleted by the nightly clean-up. A new picture, or the picture taken off, makes a new picture
  video. The audio story counts as ready only once its picture video is, so it can't be approved
  before.
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
- **Sending a story with a picture for review checks the picture (Joel, 2026-10-30, R3 = A, with
  its extra suggestion):** the server reads only the first 40 bytes of the stored picture. It must
  be all there (its exact size as recorded at upload), really a WebP of the width and height
  recorded, and without hidden metadata (EXIF, which can hold a photo's location, or XMP) or
  animation; a picture our page made never has them, so one that does wasn't cleaned. Otherwise
  the story stays a draft and the person is told "Your picture hasn't finished uploading. Add it
  again, or remove it, then submit your story." If the picture storage can't be reached, the story
  stays a draft and the person tries again later; it never passes unchecked. A colour profile and
  transparency are allowed (Chrome adds a standard colour profile to every picture). A picture
  that passes counts as processed, so a moderator can approve it; until M7's scanning, that check
  and the moderator seeing every picture are what stand between an upload and the public.
- Pictures are converted in the browser before upload, so no location or camera data leaves the
  device: WebP, at most 2048 pixels on the long side, at least 200 pixels a side, at most 5 MB,
  and no more extreme than 1:3 or 3:1. A description for screen readers is optional, on every
  type.
- **A chosen picture is added straight away** (Joel, 2026-11-09), as a video or audio file
  uploads once chosen: no "Add" button to press. A line says whether it is being prepared,
  uploading or added; Continue waits while it uploads. A failed upload keeps one "Try again"
  button. Its description saves on its own when the person leaves the box (and before Continue).
- **Videos and audio lose where and on what they were recorded before they leave the device**
  (M2, Joel 2026-11-06): the browser blanks an MP4, MOV or M4A file's location and device
  metadata in place, without re-encoding, so the file is the same size and plays the same. Bunny's
  MP4 copies (for "Download my data") could otherwise keep the location. Other kinds of file (MP3,
  WAV, WebM) and files it can't read upload as they are.
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
  audio and pictures come as links that last 7 days (B, Joel 2026-11-06). Each video or audio item
  also has a link to download it as an MP4 file, a copy Bunny makes when it encodes the video (C1,
  Joel 2026-11-06); we never keep the upload itself. Videos encoded before MP4 copies were turned
  on (November 2026) have none, and the file says so. The file says what it leaves out (who
  moderated, Clerk's sessions and devices, anyone else's data). If Clerk
  (or Bunny, asked which MP4 copies the person's videos have) can't answer, there is no file rather
  than a partial one.

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
- My favourites lives at /favourites, for everyone: signed-out visitors reach it from the header
  (a heart and "My favourites" next to Sign in), signed-in people from the account menu. Signed
  out, it says the hearts are kept in this browser only and offers Sign in. The old address,
  /account/favourites, redirects there permanently. (Joel, 2026-11-07)
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
  there is no personalised home or "New for you". (D72) On a written card without a picture too
  narrow for the badge beside the heart (narrow columns with large text), the card's top line
  moves below the heart and the card grows a little (Joel, 2026-11-08).
- **Browse** has search, sort, format and theme filters. Cards are laid out in balanced columns
  at each picture's own shape (limited between tall 9:16 and wide 2:1) and never move once shown.
  More stories load on their own as the reader nears the end, to the end of the list, with an end
  message. Without JavaScript there is a link to the next page. (D55)
- **Story grids** (browse and My favourites): 3 columns from 1024 px wide, 2 from 640 px, 1
  below, whatever the text size (Joel, 2026-11-07/08). The column count follows the screen's width
  only; larger text makes the cards narrower, never fewer columns.
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
  can take up to 60 seconds to disappear or appear. Browsers and any future CDN may keep an
  answer only for the part of the minute it has left. Nothing personal is kept this way. (R13,
  Joel 2026-11-05)
- **While the database restarts, public pages keep working from the last copy.** Each running
  copy of the public API keeps its answers for 30 minutes; past their minute they are used only
  when the database can't be reached, instead of the restarting message, and browsers and CDNs
  are told not to keep them. So during a restart a story deleted in the last 30 minutes may still
  show: a rare case, accepted. A copy of the public API that has just started has nothing kept,
  so its visitors see the restarting message. (Cache B, Joel 2026-11-07)
- Every page works from 320-pixel phones to large desktops, in light or dark (following the
  device, with a switch), with text enlarged to 200%. Body text sits in a reading column of at
  most about 80 characters a line.
- The About and Next Steps pages play the founder's videos.

## Moderation

Built in the database (the decisions and their pages are planned, M3):

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
  known, so nothing unchecked reaches the public. (A2) For a picture, "processed" means it passed
  the picture check when the story was sent for review (Uploads, above), until M7's scanning.
- **A moderator waits for the media before approving (decision 5 and J6, Joel 2026-11-07):** not
  while the story's video, audio file or picture could still be replaced through its upload link
  (an hour after the link was signed, or signed again for a resumed upload; 10 minutes for a
  picture), so what they watched is what gets published; they are told the time from which they
  can approve. And not while a media job for those files is still open (for example an audio
  story's new picture video still being made), so they never approve the old picture: "media
  still being processed". An Admin may approve anyway, and the approval records that they
  skipped the wait. This holds for a moderator's "show again" too; the system hiding a story and
  showing it again when its media breaks and works again never waits.
- **Media ready (M2 plan item 13; D76, D78; Joel 2026-11-07, media-worker-final.html):** when
  Bunny says a video or audio file finished encoding, failed or was deleted, a check job for that
  file is written to the job table, then queued; the media worker asks Bunny itself and calls the
  result writer, which records the answer on that file only (ready with its real size, length and
  Bunny's thumbnail; still encoding; or failed, also when Bunny no longer has it) and marks the job
  done in the same step. At most one job per file and kind is open: a new reason joins it. An
  answer about a file the story no longer shows is dropped (the job ends "gone"), and so is one
  that reached the writer before the last answer recorded for that file (the job ends "stale"),
  so a late answer can't bring back a story whose video has since failed (F1). If the worker
  fails a job 5 times, the job ends "gave up" (no dead-letter queues, J4). Jobs hold ids only and
  go with their file (erasure, tidy-up); done jobs are deleted after 30 days (J2). Every evening
  at 18:00 UK time, when Joel's machine is on to take them, every job not done whose last send
  is over 12 hours old is sent again (Joel, 2026-11-07), so a job the queue lost (31 days, a
  failed send) still gets done. Sending a video or audio story for review writes a check of its
  file too, so a moderator never approves before the worker has looked (J6).
- **Picture videos, step by step (Joel, 2026-11-07: audio-picture-video.html 1B, K1):** a check
  that finds an audio file ready writes a "render" job (an audio story's picture change writes
  one too). The worker asks the result writer for a pass; the writer makes the new Bunny video
  and gives the worker a pass to upload to that one video for one hour (the full Bunny key never
  leaves Google Cloud), with a 10-minute link to the picture. Just before downloading the audio's
  sound, the worker asks the writer for a link to that one file, valid two minutes and read
  straight from Bunny's storage, never an old cached copy (Joel, 2026-11-08, R3: single-file links
  on a need-to-use basis; the worker holds no storage key). It runs ffmpeg on Joel's machine (files only in
  memory, removed when the job ends) and uploads. The writer then records the new video as the
  story's file, but only if the story still shows that audio file (a new recording wins), and
  checks the new video like any other. A render no longer needed (a new recording, the story
  deleted, or already made with the story's picture) ends without making anything.
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

Built, read-only (M3 plan, pull request 1; Joel, 2026-11-09):

- **Who:** Moderators and Admins. The staff menu shows "Moderation" to both; the other staff
  pages are for Admins only (G24). The database knows moderators only as api-admin's login,
  so api-admin checks the role on every moderation request and refuses anyone below Moderator.
- **The queue** (`/moderation`): the stories waiting for review, the one sent longest ago first
  (a story sent again after changes goes to the back), 20 at a time with "Show more". Each shows
  its title, kind (video, audio, written) and when it was sent.
- **The review page** (`/moderation/{id}`): the story as the public would see it, built from the
  public story page's own parts (player or picture, title, byline, themes, words), with the
  player's playback-speed menu on; then its history, oldest first: each step, whether the person,
  a moderator or the system made it, when, and any note a moderator left the person. Only a
  story waiting for review or in review opens; any other says it isn't waiting for review.
- **Least about the person:** moderators see the byline the person chose, never their name,
  email, account id or join date, and never which moderator made a step.
- **Links last one hour:** the player and picture links are signed for one hour from when the
  page loads; reloading the page gets fresh ones. A video or audio file is playable once Bunny
  has processed it; until then the page says it is still being processed.

Planned (M3):

- A moderator picks a story up, which locks it for them, and can release it.
- Approve, Request changes, Reject and Escalate on the review page. Reject and Request changes
  need feedback, written pastorally, which the person sees on their profile.
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

- **Limits** (Admins): the submission limits in plain words with their units; Save
  lists the changes and asks to confirm. If another admin saved meanwhile, the page asks to
  reload. The settings keep the name and role of the admin who changed them last; there is no
  history of changes (no audit log, see Moderation).
- **Themes**: categories and themes on one page (drag on desktop, tap or keyboard on phones),
  delete confirmed by typing "delete <name>", and one Save for the whole picture. Deleting a theme
  removes it from every story. If someone else saved meanwhile, the page asks to reload.
- **Consent texts** (Admins): publish the next version of any of the four texts
  (see "Consent, privacy and terms").
- The database can list stories hidden because their media broke or changed; there is no admin
  page for it yet.
- **All stories** (Admins only, R15, Joel 2026-11-05): a read-only list of every story in
  every status, drafts included, and each story with its status log and files. Moderators see
  stories from "waiting for review" on, through moderation. Built in api-admin; there
  is no admin page for it yet.
- Theme and category names are tidied (trimmed, single spaces, capital first letter); a
  duplicate name is refused. Deleting a category moves its themes to "Other", not highlighted.
- **Staff** (Admins): the staff list (email, role, who added them and when, baseline admins
  marked); add an `@heisreal.today` email as a Moderator or an Admin, change a role, remove someone
  (after "Remove …? They become a User."). See "Staff" under Accounts and sign-in.
- Planned (M5): the dashboard and the user list.

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
- **Media jobs** (ids and times only) are deleted by the nightly clean-up 30 days after they
  ended, and with their file before that. (J2, Joel 2026-11-07)
- Backups are nightly, in the UK, and age out; they aren't edited after a deletion.
- Our services' logs are stored in London for 30 days. (D101)
- **Where data lives:** in the UK wherever possible (London), declared in our infrastructure
  code. Exceptions: video and audio files at Bunny in Frankfurt (D89); Clerk in the US (D6);
  Bunny's delivery network serves files worldwide.

## When something goes wrong on our side

- **People never see error codes or backend state (Joel, 2026-11-09:** "dont reveal to the users
  the error code from the backed or its error type/ state, just say try again later"**),
  except that a restart is named, with its countdown** (Joel, 2026-11-09: "for errors we should
  reveal when compute is restarting with a count down but for any other error it should be
  generic"; "When the database restarts", below). Whatever else went wrong on our side (a server
  error, no answer, a technical refusal), web says only "Something went wrong. Please try again
  later." on every page, admin pages included: no HTTP status, error code, error type, request
  id or what the server is doing. Where it helps, it adds what of the person's is safe ("Your
  story is saved."). The logs keep the full detail.
- **Mistakes people can fix stay visible** (Joel, 2026-11-09: "errors caused by user mistakes
  should be visible. errors where the backend is crashing or would be useful for attackers should
  be generic to the public (except for the restart countdown)"): a field too long, a file too
  big, a limit reached, a story changed in another tab. The APIs keep their own codes; only what
  web shows changed. Web shows an API's own message only for the codes on a fixed list of input
  refusals (`INPUT_REFUSALS` in `apps/web/src/lib/api-user.ts`); the codes about our side are
  listed too (`SYSTEM_CODES`), and a test (`error-codes.spec.ts`) fails when an API answers a code
  that is on neither list, so someone decides which it is before it ships. Any code web doesn't
  know still gets the plain message.
- Pages that expect "not found" or "not allowed" explain it themselves ("This draft no longer
  exists", a story page that isn't there, "This page is for admins" or "for moderators"): that is
  not backend state.

## When the database restarts

The database runs on Google's cheap "Spot" capacity in dev and production, which Google can take
back at any time; it then restarts elsewhere within a few minutes, and no data is lost. (Joel,
2026-11-07: "we can handle occasional forced restarts")

- Public browsing keeps working from the public API's kept copies (Browse and themes, above).
- Anything else (signed-in pages, saving, sharing, uploads, admin pages) shows a calm message:
  "Our compute is currently restarting. Please try again in about 2 minutes." It's the one error
  web names (Joel, 2026-11-09). The minutes count down in the browser from the server's estimate
  (whole minutes, rounded up); when the countdown runs out it says "Please try again later."
  instead, never "about 1 minute" or 0. Without JavaScript the page shows the server's estimate
  as it was.
- After a save, a submit or an upload, the message shows at the bottom of the screen ("Our
  compute is currently restarting. Please try again in about N minutes.", then "… Please try
  again later.") and the page keeps what the person typed. A submit or an upload in the share
  flow says the same where it was tried, adding "Your story is saved."; other places that show
  their own error after an action (saving a draft, admin pages) show the plain "Something went
  wrong. Please try again later." there, with the named countdown at the bottom.
- The estimate: 2 minutes (a setting, `DATABASE_RESTART_ESTIMATE_SECONDS`) counted from when that
  copy of the service first saw the database go, never less than 1 minute.
- The message at the bottom of the screen goes as soon as the next thing the browser asks
  api-user or api-admin is answered, on the same page or after moving to another one.
- A copy of a service that starts while the database is away starts anyway and gives the same
  message (counted from when it first failed to connect) until it has connected; once
  connected, nothing changes. (Joel, 2026-11-07: "gap a")
- But a copy whose sign-in the database answers and refuses (a wrong password, an unknown
  namespace or database, a permission error) doesn't start at all, so a broken deploy never
  replaces the working version. Only "no answer" counts as a restart. Once a copy has connected,
  every later failure counts as a restart. (Joel, 2026-11-08: "differentiate between restarts
  with no response and problems caused by an error like a password error")

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
- **The database runs on Spot in dev and production** (Joel, 2026-11-07), and so do the cluster's
  helpers (External Secrets, the backup Job). Every service notices a restart in the shared
  database client (`libs/database`, `DatabaseAvailability`): it keeps reconnecting for as long as
  it takes (and starts without the database, connecting in the background: `startConnecting`;
  Cloud Run's start-up check only needs the port open; but if the database answers the first
  sign-in with a refusal, a `ServerError` from the SDK, the service exits with code 1 and logs
  `database_refused`), answers `503 service_restarting` with
  `Retry-After` at once instead of hanging, sign-in's person lookup included
  (`ServiceRestarting` in `libs/contracts/openapi/components.yaml`), and logs one line when the
  database goes (`database_unavailable`) and one when it's back (`database_available`, with how
  long). Google's own record of each reclaim is counted by the log-based metric
  `heisreal-<env>/database-spot-reclaims` (bootstrap root). The Cloud Monitoring dashboard
  "heisreal-<env>: health" (`infra/terraform/modules/gcp/monitoring.tf`) shows them
  with each service's requests by response code and instance count. Dashboards are made in
  OpenTofu only (Joel, 2026-11-08).
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
  hardware, pulling from Pub/Sub; it calls a Cloud Run result writer directly, which only its
  Google account may call, and that writes the results (D78; J5, Joel 2026-11-07). Work waits in
  Pub/Sub (in London, up to 31 days) while that machine is off. The worker signs in as a narrow
  `media-worker` account with **its own certificate**, never a person's gcloud login and never a
  Google key file (W1-A; Joel, 2026-11-08, worker-and-gcloud-sign-in.html; it replaces D126's
  "Joel's login acting as it"): our own certificate authority, a Cloud KMS key in London that only
  the `cert-signer` service may sign with, issues each machine a certificate naming it, and
  Google's workload identity federation trusts only that authority. The worker makes a new key and
  gets a new certificate every 6 hours, each valid 24 hours (both settings), by proving its current
  one to `cert-signer` (one route, only media-worker may call it); the new pair replaces the old
  one at the same path, so the old key is deleted at once and Dapr follows without a restart.
  Only the newest certificate issued for a machine may renew ("newest only", W2-1 A, Joel
  2026-11-09; church machines have no security chip, so there is no chip-based option later
  either): a copied certificate and key can't keep a second line going, and if a copy renews
  first, the real worker is refused at its next renewal and says so. A renewal whose answer was
  lost isn't refused: the worker saved its new key first and asks again with it, and gets the same
  certificate back, never a new one (W3-1 A, Joel 2026-11-09). A
  machine off for longer than the lifetime is enrolled again by a developer with one command; a
  machine is cancelled by taking its name out of the OpenTofu list. After a refusal as "not the
  newest", the name is cancelled and the machine enrolled under a new name. The worker uses only Dapr's
  Pub/Sub part, and stores nothing on the machine but its identity (D129). Media ready is the first
  such work (`docs/media-runbook.md`, "Media ready"). Every answer names the job's video, and the
  writer refuses one that names another; anything the worker can't do, the writer refusing its
  answer and the worker's own errors included, counts as a failure, and a job gives up after 5,
  so none loops for ever (Joel, 2026-11-08).
- **No CDN in front of the site or APIs in dev;** browsers and CDNs are told not to keep API
  responses in dev. (D51) api-public-read keeps public answers in its own memory, per running
  copy, with no timers, so Cloud Run still bills only per request and scales to zero: served for
  60 seconds (R13), and kept up to 30 minutes for when the database is restarting (cache B, Joel
  2026-11-07), within the same 500-answer limit.
- **Budget:** £15 a month with alerts at £3, £7.50 and £15. (decision 10)
- **Tests measure behaviour** (AGENTS.md; test clean-up T1–T10, 2026-10-24).
- **Dependencies** update through Renovate. (D106)

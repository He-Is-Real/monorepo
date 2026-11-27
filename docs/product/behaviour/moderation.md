# Moderation

Who: Moderator, Admin, Signed-in person (a story's owner), the system.
Data: `docs/db-permissions.md#stories-schema-04-storiessurql`
Next id: REQ-MOD-156

## Contents

- Story states and the status log
- Who moderates
- The moderators' list
- The review page
- Decisions
- Overturning a decision
- Admin delete
- Media before approval
- Unusable files and retries
- Media jobs
- Not offered

## Story states and the status log

- **REQ-MOD-001** A story is in one of five states: editing (a draft never sent, or one sent back), pending (waiting for review), approved, hidden (approved, but off the site while its media is fixed, or hidden by a Moderator) and rejected. [J-2026-11-11-MOD]
- **REQ-MOD-002** There is no "in review" state: a Moderator or Admin decides straight from pending. [J-2026-11-11-MOD]
- **REQ-MOD-003** When a story takes a step, the system adds a status-log entry saying what happened (its action), the state it left the story in, who made it (the owner, a Moderator or Admin, or the system), when, and which edit of the story it was about. [R6]
- **REQ-MOD-004** While the story exists, its status-log entries are never edited or deleted. [R6]
- **REQ-MOD-005** A story's state is that of its newest status-log entry that moved it; a story with none is a draft. [R6]
- **REQ-MOD-006** The database fixes who may take which step: the owner sends (from editing) and starts editing with Edit (from pending, approved or hidden). [R6]
- **REQ-MOD-007** A Moderator or Admin approves, sends back or rejects a pending story, and hides an approved one. [R6]
- **REQ-MOD-148** No step other than those in REQ-MOD-006 to REQ-MOD-008 and the overturns below is possible: a rejected story is never hidden, shown again or rejected again. [OV-2]
- **REQ-MOD-008** The system hides a story and shows it again when its media breaks and works again, and sends a story back when its file can't be used. [R6]
- **REQ-MOD-149** When the site itself hides a story, the hide records why. [J-2026-10-23-DB]
- **REQ-MOD-009** When a Moderator or Admin sends back, rejects or hides a story, the step needs a note; a Moderator's or Admin's entry can carry a note to the owner. [R6]
- **REQ-MOD-010** When a sent story gets a new video or audio file or a new picture while it is being edited, the system adds a history-only entry that leaves its state unchanged. [M3-7]
- **REQ-MOD-011** When the owner changes a sent story's title, description, text or themes, the system adds one "words changed" entry per round of editing, however many saves, and none if nothing changed. [M3-7]
- **REQ-MOD-012** A draft never sent has no history entries. [M3-7]
- **REQ-MOD-013** The status log is the moderation history; there is no separate audit log. [J-2026-11-05-MOD]
- **REQ-MOD-014** When a Moderator or Admin makes a status entry (approve, send back, reject, take down, show again, approve anyway), the system records their email from their verified sign-in. [EM-1]
  Why: to show which staff member took which action.
- **REQ-MOD-015** The review page's history shows that email to Moderators and Admins ("Approved by …"); it can't be blocked. [EM-1]
- **REQ-MOD-016** The owner never sees which staff member made a step: their pages and "Download my data" say "a moderator". [EM-1]
- **REQ-MOD-017** The owner can read the Moderators' decisions and notes on their own stories, never who made them. [EM-1]

## Who moderates

- **REQ-MOD-018** The staff menu shows "Moderation" to Moderators and Admins; the other staff pages are for Admins only. [G24]
- **REQ-MOD-019** On every moderation request, api-admin checks the role and refuses anyone below Moderator. [G24]
  Why: the database knows Moderators only as api-admin's login, so it can't check the role itself.
- **REQ-MOD-020** Moderators and Admins may decide on their own stories. [J-2026-11-11-MODb]
- **REQ-MOD-021** Any Moderator or Admin can decide any story waiting for review: there is no pick-up locking, escalation or assignment. [J-2026-11-11-MOD]
- **REQ-MOD-022** Moderators see the byline the owner chose, never the owner's name, email, account id or join date, and never which Moderator made a step. [PR-210]

## The moderators' list

- **REQ-MOD-023** At `/moderation`, Moderators and Admins see one list of every story that is not on the site, one state at a time: waiting for review, being edited, taken down and rejected. [MD-4]
- **REQ-MOD-024** "Being edited" holds stories a Moderator sent back or whose owner pressed Edit; "Taken down" holds stories a Moderator took down or the site took off while their video or audio can't play. [MD-3]
- **REQ-MOD-025** Admins also see drafts never sent; Moderators never see them, on the list or by a story's address. [MD-3]
  Why: lets Admins see people who might be preparing spam or other harmful activity.
- **REQ-MOD-026** The states are tabs across the top, in this order: Waiting for review, Being edited, Taken down, Rejected, and (Admins only) Drafts never sent. [MQ-1]
- **REQ-MOD-027** Each tab shows how many stories its state holds, whatever the filters; a Moderator is never told how many drafts there are. [MQ-1]
- **REQ-MOD-028** The list opens on "Waiting for review", and each tab is a link in the address (`?state=`). [MD-4]
- **REQ-MOD-029** The side panel holds a title search (ignoring capitals), the sort, the format and the themes; the search, format and themes together narrow the list. [MQ-1]
- **REQ-MOD-030** The format and theme filters work exactly as browse's, with browse's own controls and one shared filter definition, so a change to how browse filters changes the moderation list too. [OQ-2]
- **REQ-MOD-141** The sort uses browse's own radio buttons. [J-2026-11-20-BRW]
- **REQ-MOD-142** The title search uses browse's own search box. [UNTRACED]
- **REQ-MOD-031** The format filter takes one format at a time (All formats, Video, Audio or Written), each showing how many of this tab's stories it holds with the search and theme applied. [OQ-2]
- **REQ-MOD-032** Themes stack from browse's theme picker: each turns on and off on its own with a ✓, a story shows only if it has every chosen theme, and "Clear themes" appears once one is chosen. [BS-7]
- **REQ-MOD-033** A chosen theme that has been deleted filters nothing. [OQ-2]
- **REQ-MOD-034** "Clear filters" takes off the search, format and themes; the tab and the sort stay. [MQ-1]
- **REQ-MOD-035** Every filter and the sort are in the address, so a link or Back shows the same list, and choices made quickly one after another all count. [MQ-1]
- **REQ-MOD-036** The sorts are Oldest first (the default, by when the story entered its state), Newest first, and Recently changed (by when the story last changed, newest first). [MQ-1]
- **REQ-MOD-037** On "Waiting for review", Oldest first puts the story sent longest ago first, and a story sent again after changes goes to the back. [MD-4]
- **REQ-MOD-038** Each line shows the title with a format icon (opening the review page), the state with what put it there, its themes, the time in this state, when it was sent and when it last changed; 20 at a time with "Show more". [MQ-1]
- **REQ-MOD-039** The time column is called "Waiting" on "Waiting for review" and "In this state" on the other tabs. [OQ-2]
- **REQ-MOD-040** On "Waiting for review" only, the time turns orange after 2 days. [MQ-1]
- **REQ-MOD-136** On "Waiting for review" only, the time turns red after 7 days. [OQ-2]
- **REQ-MOD-041** The counts and times are as of when the list loaded (opening the page, a tab or a filter); nothing updates live. [OQ-2]
- **REQ-MOD-042** On screens 1280 px and wider, the page's content is up to 1480 px wide (the side panel and a list column of at most 1200 px), centred like Consent & legal; no column is wider than 1200 px. [OQ-4]
- **REQ-MOD-043** Theme names wrap inside their cell. [MQ-1]
- **REQ-MOD-044** Below 1280 px the tabs scroll sideways, the side panel folds into a "Filters and sort (N)" button (N = the filters on), and each story is a small card: title with format icon, themes and time. [MQ-1]

## The review page

- **REQ-MOD-045** At `/moderation/{id}`, a Moderator or Admin sees the story as the public would, built from the public story page's parts (player or picture, title, byline, themes, words), with the player's playback-speed menu on. [J-2026-11-09-MOD]
- **REQ-MOD-046** Below the story come the decisions the Moderator can make, then the story's history as a timeline, oldest first. [M3-7]
- **REQ-MOD-047** Each timeline step shows what happened, whether the owner, a Moderator (by email) or the system made it, when, and any note a Moderator left. [EM-1]
  Example: sent, sent again, sent back with the note, taken down to edit, approved, rejected, taken down with the reason, shown again, a new file or picture, words changed, a file that can't be used.
- **REQ-MOD-048** Any story on the list opens, and a published one; a draft never sent opens for Admins only. [MD-3]
- **REQ-MOD-049** A waiting, published, taken-down or rejected story has a decision to make; a story being edited is read only. [OV-1]
- **REQ-MOD-050** The player and picture links are signed for one hour from when the page loads; reloading the page gets fresh ones. [J-2026-11-09-MOD]
- **REQ-MOD-051** Until Bunny has processed a video or audio file, the page says it is still being processed instead of playing it. [J-2026-11-09-MOD]
- **REQ-MOD-052** While a review page is open, it checks every minute, and when the tab comes back into view, whether the story changed; if so it says "This story changed while you had it open." with "Reload to see it". [J-2026-11-10-MOD]
- **REQ-MOD-053** After that notice the decision buttons stay disabled until the Moderator reloads; the page never replaces itself, so a note being typed stays in its box. [J-2026-11-10-MOD]
- **REQ-MOD-054** When the system sends a story back because its file can't be used, it moves from "Waiting for review" to "Being edited", and its history shows "Sent back automatically: the video couldn't be processed" ("the recording" for audio). [J-2026-11-10-MOD]

## Decisions

- **REQ-MOD-055** On a waiting story, a Moderator or Admin chooses Approve, Send back or Reject. [J-2026-11-11-MOD]
- **REQ-MOD-056** Send back and Reject need a note of 1 to 2,000 characters, written pastorally; the owner reads it as "What our team said". [J-2026-11-11-MOD]
- **REQ-MOD-057** On a published story, a Moderator or Admin can Take down with a required reason. [G5]
- **REQ-MOD-058** After a take-down, the owner reads the reason under "What our team said", like a sent-back note, and it is in "Download my data". [MD-2]
- **REQ-MOD-059** Only a Moderator or Admin shows a hidden story again, with Show again on the review page. [G5]
- **REQ-MOD-060** When a signed-in Moderator or Admin views a published story on the public site, they see "Take down" under it, which opens the review page's take-down form (reason required) and takes the story off the same way. [MD-1]
- **REQ-MOD-061** The public story page is the same for everyone; the "Take down" button appears in the Moderator's browser once their role is known, and nobody else sees it. [MD-1]
- **REQ-MOD-062** When two Moderators decide the same story at once, the first decision wins; the second is refused, and their page says "Another moderator has already decided this story" and refreshes. [D-1]
- **REQ-MOD-063** A decision names the story's newest status entry and the files the page showed, not its edit number: background work on a file doesn't refuse it, and a story whose files changed since is refused. [G14]
- **REQ-MOD-064** When a story moved on since the page opened (another Moderator decided first, or the owner pressed Edit), the decision is refused, the page says so and refreshes. [G14]
- **REQ-MOD-065** When a decision is refused, the page says why in plain words, never with a code. [J-2026-11-09-MODb]
  Example: "The video is still being processed. You can approve it from 14:05."
- **REQ-MOD-066** After each decision the page confirms it and shows the story as it now is. [OV-1]
- **REQ-MOD-145** Approving a story publishes it at once. Edit or a hide takes it off the site at once, and erasing the account deletes the story and its history. [R11]
- **REQ-MOD-067** Moderators and Admins can never change the words of someone's story. [D41]

## Overturning a decision

- **REQ-MOD-068** On a taken-down story, whoever took it down (a Moderator, or the site while its video or audio can't play), a Moderator or Admin chooses Show again, Send back (with a note) or Reject (with a note). [OV-2]
- **REQ-MOD-069** When a taken-down story is rejected, it is deleted with the other rejected stories. [P1-11]
- **REQ-MOD-070** For a story the site took down, Show again waits until its video plays again. [OV-2]
- **REQ-MOD-071** On a rejected story, a Moderator or Admin chooses Approve (publish it), Send back (with a note) or "Put back in the waiting list". [OV-1]
- **REQ-MOD-072** "Put back in the waiting list" returns the story to "Waiting for review" unchanged, with no note, as its own step in the history, for any Moderator to decide again. [OV-1]
- **REQ-MOD-073** Approving a rejected story runs every check a first approval does (the media, the picture at Bunny, the owner's story consent); Approve anyway stays Admin only. [OV-1]
- **REQ-MOD-074** Approve, Show again and "Put back in the waiting list" need no note; Send back and Reject need the note the owner reads. [OV-3]
- **REQ-MOD-075** When a decision is overturned, the owner sees the new state and only the latest note, as with any decision; the full history is in "Download my data", and no email is sent. [OV-4]
- **REQ-MOD-076** A re-approved story keeps its first publication date (its place in newest first); one rejected while waiting was never published, so it is published that day. [OV-5]
- **REQ-MOD-077** A decision can be overturned any number of times, any time until the story is deleted. [OV-6]
- **REQ-MOD-078** Once a story leaves Rejected, the 90-day deletion of rejected stories stops applying to it; a story sent back starts the 186-day editing clock. [OV-6]

## Admin delete

- **REQ-MOD-079** On the review page of a story in any state they can open, an Admin has Delete, after one "This can't be undone" question, as for the owner's Delete. [P1-11]
- **REQ-MOD-080** Moderators have no Delete. [DEL-2]
- **REQ-MOD-081** An Admin's Delete deletes the story exactly as the owner's Delete does: its status log and others' hearts go with it, and it leaves the site and search at once. [P1-11]
- **REQ-MOD-082** An Admin's Delete also deletes the story's videos and picture folder at Bunny at once, side by side, waiting at most 8 seconds for Bunny so the Admin isn't kept waiting. [DEL-1]
- **REQ-MOD-083** If Bunny fails or is still busy then, the Delete still succeeds: the nightly orphan sweep removes the videos and the nightly clean-up removes the queued picture folder, as for the owner's Delete. [DEL-1]
- **REQ-MOD-084** The owner isn't told of an Admin's Delete, beyond the story leaving My submissions. [P1-11]
- **REQ-MOD-085** An Admin's Delete doesn't check what the Admin saw: the story goes even if it changed since the page opened; a story already gone answers that it wasn't found. [DEL-3]
- **REQ-MOD-144** An Admin's Delete names nobody: no account is stored with the deletion or on any history entry for it. [UNTRACED]

## Media before approval

- **REQ-MOD-086** A story can't be approved until every upload is processed and its size and length are known, so nothing unchecked reaches the public. [M1-A2]
- **REQ-MOD-087** For a picture, "processed" means it passed the picture check when the story was sent for review. [R3]
- **REQ-MOD-146** A story can't be approved unless the person who sent it has agreed to a testimony consent, of any version. [J-2026-11-01-DB]
- **REQ-MOD-152** A video story can't be approved until the picture shown for its video is the story's current picture. [J-2026-11-06-SHR]
- **REQ-MOD-155** An audio story can't be approved until its picture video is made from the story's current picture. [DEC-1B]
- **REQ-MOD-088** While the story's video, audio file or picture could still be replaced through its upload link, a Moderator can't approve, and is told the time from which they can. [DEC-5]
  Why: what the Moderator watched is what gets published.
- **REQ-MOD-089** An upload link can replace a video or audio file for an hour after it was signed, or signed again for a resumed upload, and a picture for 10 minutes. [DEC-5]
- **REQ-MOD-090** While a media job for the story's files is still open (for example an audio story's new picture video still being made), a Moderator can't approve: "media still being processed". [J6]
- **REQ-MOD-091** An Admin may Approve anyway while the media is still being processed, never within the upload link's time; the approval records that they skipped the wait. [G11]
- **REQ-MOD-092** Approve anyway is offered only after an approval was refused because the media is still being processed. [G24]
- **REQ-MOD-093** The waits hold for a Moderator's Show again too; the system hiding a story and showing it again when its media breaks and works again never waits. [DEC-5]
- **REQ-MOD-094** When a Moderator approves a video story (Approve or Approve anyway) or shows a hidden one again (Show again, also anyway), the site asks Bunny which picture file it shows and compares it with the one recorded when the story was sent. [RE-2]
  Why: a picture from an earlier send that timed out, or from another tab, can still reach Bunny later.
- **REQ-MOD-095** The Bunny picture check does not apply to an audio story's picture video. [RE-2]
- **REQ-MOD-096** If the pictures differ, or none was recorded, the story isn't approved (a hidden one stays hidden) and the Moderator reads "The picture changed at Bunny. Send it back so the person sends again."; Approve anyway can't get past it. [RE-3]
- **REQ-MOD-097** If Bunny can't answer the picture check within 10 seconds, the story isn't approved or shown ("Something went wrong. Please try again later."): it never goes on the site unchecked. [RE-2]
- **REQ-MOD-098** When an approved story's media breaks, the system hides it, not un-approves it, and it comes back on its own when the same files work again. [D60]
- **REQ-MOD-099** The approval records which video or audio file and which picture the Moderator reviewed; the story shows again only while it points at both, so after a new video or picture it stays hidden until a Moderator looks. [R12]
- **REQ-MOD-150** When a published story's files stop being ready, or stop being the files that were reviewed, the site hides the story in that same moment. [J-2026-10-23-DB]
- **REQ-MOD-151** A story the site hid comes back on its own only while the person who sent it still has testimony consent. [D61]
- **REQ-MOD-154** A story the site hid keeps its first publish date when it comes back. [R6]

## Unusable files and retries

- **REQ-MOD-100** When Bunny reports "failed to process" for a story's file, the owner is told at once; there is no automatic re-encode. [RE-1]
- **REQ-MOD-101** The result writer believes a worker's "failed" only once Bunny says the same; then it marks the file failed and the job "gave up" with the reason `file_unusable`. [UNTRACED]
  Why: the worker runs on a home PC and can never blame the file.
- **REQ-MOD-102** In that same write, the database sends a story that is waiting for review, published, or off the site back to its owner with a system "file unusable" entry: "Needs a new file". [G2]
- **REQ-MOD-103** A published story whose file is unusable goes back to its owner at once, with no timer. [G2]
- **REQ-MOD-104** The "file unusable" entry records `recording` (the story's video or audio file) or `picture` (an audio story's picture video made with its picture), and only the database writes it. [P1-2]
- **REQ-MOD-105** A picture video made on the site's default background, with no picture, counts as the `recording`. [G17]
- **REQ-MOD-106** Every other give-up is ours, never the owner's: `bunny_unavailable`, `worker_error` or `other`, a fixed list readable by api-admin only; a video Bunny has lost counts as `other`. [P1a-4]
- **REQ-MOD-107** For a story waiting for review whose newest job gave up, the nightly housekeeping opens a new check, for up to 3 nights. [P1-9]
- **REQ-MOD-108** After those 3 nights, the moderators' list shows "Can't be reviewed yet: a problem on our side" on the story, and the owner keeps seeing "Waiting for review". [P1-9]
- **REQ-MOD-109** The same nightly retry covers a published story the site took off itself (for example while Bunny has lost its video), never one a Moderator hid: up to 3 nights, then it stays off the site. [P1-5]
- **REQ-MOD-110** After those 3 nights the owner keeps seeing "We're fixing your video", and the moderators' list shows "A problem on our side" on the story. [P1-5]
- **REQ-MOD-111** While a story waits for review or is off the site because the site took it off, its media jobs are kept, so its give-ups keep counting and its 3 nightly retries never start again. [P1-3]
- **REQ-MOD-112** The 30-day tidy-up of done jobs skips those jobs; they go 30 days after the story is decided, shown again or deleted. [P1-3]
- **REQ-MOD-113** Once the 3 retries are used, the database refuses every new check or render job for that story's file, in one place: a chore, Bunny's notice, a late copy of an answer from the queue, or the owner sending the same file again after Edit. [P1-9]
- **REQ-MOD-114** A new file the owner uploads starts with no give-ups, and the cap doesn't apply while the story is back with its owner. [P1-9]
- **REQ-MOD-115** The nightly clean-up never deletes a story the site took off itself. [P1-9]
- **REQ-MOD-116** For a story the site took off itself, its owner can use Edit and upload a new file, a Moderator or Admin can send it back or reject it (then it is deleted like any rejected story), and an Admin can delete it. [P1-9]

## Media jobs

- **REQ-MOD-117** When Bunny says a video or audio file finished encoding, failed or was deleted, the system writes a check job for that file to the job table, then queues it. [D76]
- **REQ-MOD-118** For a check job, the media worker asks Bunny itself and calls the result writer, which records the answer on that file only and marks the job done in the same step. [D78]
  Example: ready with its real size, length and Bunny's thumbnail; still encoding; or Bunny's failure (REQ-MOD-102).
- **REQ-MOD-119** At most one job per file and kind is open; a new reason joins the open job. [J-2026-11-07-MOD]
- **REQ-MOD-120** An answer about a file the story doesn't show is dropped (the job ends "gone"), and so is one that reached the writer before the last answer recorded for that file (the job ends "stale"). [UNTRACED]
  Why: a late answer must never bring back a story whose video has since failed.
- **REQ-MOD-121** When the worker fails a job 5 times, the job ends "gave up" with why (`bunny_unavailable`, `worker_error` or `other`, never the file's fault). [J-2026-11-07-MOD]
- **REQ-MOD-140** There are no dead-letter queues: the job table records failed jobs. [J4]
- **REQ-MOD-122** A media job holds ids only. [J1]
- **REQ-MOD-138** When a file is deleted (erasure or tidy-up), its media jobs are deleted with it. [J1]
- **REQ-MOD-139** The system deletes a done media job 30 days after it ended, except as REQ-MOD-112 says. [J2]
- **REQ-MOD-123** Every evening at 18:00 UK time, when the worker machine is on to take them, every job not done whose last send is over 12 hours old is sent again. [J-2026-11-07-MODb]
  Why: a job the queue lost (after 31 days, or a failed send) still gets done.
- **REQ-MOD-143** While the worker machine is off, its work waits for up to 31 days, held in London. [D78]
- **REQ-MOD-124** When the owner sends a video or audio story for review, the system writes a check job for its file too, so a Moderator never approves before the worker has looked. [J-2026-11-07-MOD]
- **REQ-MOD-125** When a check finds an audio file ready, or an audio story's picture changes, the system writes a "render" job for its picture video. [DEC-1B]
- **REQ-MOD-126** For a render, the worker asks the result writer for a pass; the writer makes the new Bunny video and gives the worker a pass to upload to that one video for one hour, with a 10-minute link to the picture. [DEC-2]
  Why: the full Bunny key never leaves Google Cloud.
- **REQ-MOD-127** Just before downloading the audio's sound, the worker asks the writer for a link to that one file, valid two minutes and read straight from Bunny's storage, never a cached copy; the worker holds no storage key. [J-2026-11-08-MOD]
- **REQ-MOD-128** The worker runs ffmpeg on its own machine, with files only in memory and removed when the job ends, then uploads the picture video. [UNTRACED]
- **REQ-MOD-129** The writer then records the new video as the story's file only if the story still shows that audio file (a new recording wins), and checks the new video like any other. [DEC-1B]
- **REQ-MOD-130** A render not needed any more (a new recording, the story deleted, or already made with the story's picture) ends without making anything. [DEC-1B]
- **REQ-MOD-131** When a story stops pointing at a video or picture, the nightly clean-up deletes the file at Bunny or in the images storage zone once no upload link for it can still be used (2 hours). [R12]
- **REQ-MOD-132** The nightly clean-up forgets a replaced file once it stops counting towards the 7-day upload limits. [R12]

## Not offered

- **REQ-MOD-133** There is no appeal process: the rejection message points the owner to info@heisreal.today. [G20]
- **REQ-MOD-134** Distressing stories carry no content notes. [G19]
- **REQ-MOD-135** The owner gets no "your story has news" banner. [G25]
- **REQ-MOD-137** There are no speed statistics per Moderator. [G25]

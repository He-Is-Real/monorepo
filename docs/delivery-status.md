# Delivery status

Where the build is, in plain words. **Last updated:** 2026-11-21

Everything here runs on the **dev** test site only, with made-up stories. Nothing reaches the
public until the "Go live" milestone. The old prototype and the Squarespace site keep running until
then.

**Key:** ✅ done · 🟡 being built · ⏸ waiting for a decision or a step from Joel · ⚪ not started

## How to edit this file (read before changing it)

This file is for the project owner, who is not technical. Joel asked for it to stay readable
(2026-11-17).

- **Milestones are the `##` headings.** Each has one status in its heading and a one-line
  "what it gives people".
- **Its parts are a checklist under it**, one line each, starting with the status mark.
- **A finished part is a tick and a few words.** Don't add PR links, dates, reasons or details.
- **A part not finished says in one sentence what is left**, and who it waits for if that's Joel.
- **Plain words only.** No code names, file paths, database terms or decision numbers.
- Update it in the same pull request that finishes or starts a part. Change the date at the top.
- How the site behaves (the rules) lives in [how-the-app-works.md](how-the-app-works.md); the
  technical detail lives in the pull requests and git history, not here.

## Milestones at a glance

| Milestone               | Status | What it gives people                                         |
| ----------------------- | ------ | ------------------------------------------------------------ |
| M0 Foundations          | ✅     | The code base, cloud set-up, database, sign-in, first page   |
| M1 Browse and watch     | ✅     | Anyone can read, watch, listen, browse and search stories    |
| M2 Accounts and sharing | 🟡     | People sign up, agree to the terms and share their own story |
| M3 Moderation           | 🟡     | Staff check every story before it goes public                |
| M4 Donations            | 🟡     | People can give money through Stripe                         |
| M5 Admin dashboard      | ⚪     | One place for admins to run the site                         |
| M6 Community vetting    | ⚪     | Trusted members help check stories                           |
| M7 Background AI        | ⚪     | Transcripts, captions and summaries made automatically       |
| M8 Embeddable widgets   | ⚪     | Stories shown on other websites                              |
| Real stories            | ⚪     | The 24 existing testimonies brought in                       |
| Go live                 | ⚪     | The real heisreal.today site replaces Squarespace            |
| Emails                  | ⚪     | Confirmation and result emails to storytellers               |

## M0 Foundations ✅

- ✅ Code base and automatic checks
- ✅ Google Cloud set-up, all written as code
- ✅ Database
- ✅ Video and picture hosting (Bunny.net)
- ✅ Sign-in (Clerk)
- ✅ First public story page
- ⚪ Error tracking and visitor statistics: left for later on purpose

## M1 Browse and watch ✅

- ✅ Home page
- ✅ Browse and search stories by theme and type
- ✅ Video, audio and written story pages, with related stories
- ✅ Information pages (About, FAQs, Contact, Privacy, Terms and the rest)
- ✅ Cookie notice
- ✅ Pages kept for a short time so repeat visits are faster
- ✅ A set of made-up test stories that can be reset at any time

## M2 Accounts and sharing 🟡

Everything is built. Two small steps are left.

- ✅ Sign up and sign in with Google or email
- ✅ Agree to the terms, consent and privacy texts, and agree again when they change
- ✅ Share a written, video or audio story, with a picture
- ✅ Drafts save on their own, with "Save and exit"
- ✅ Limits on how much and how often people can share, and how big a picture can be (admins can change them)
- ✅ My submissions: see each story's status, edit or delete it
- ✅ Delete my account, with all its stories and files
- ✅ Download my data
- ✅ Favourites (a "Favourites only" switch on browse)
- ✅ NEW badge on stories from the last 7 days
- ✅ Admin pages for limits, themes and the legal texts
- ✅ Nightly clean-up of abandoned drafts and leftover files
- ✅ Videos and audio checked automatically once Bunny has processed them
- ✅ An audio story becomes a video of its picture
- ⏸ Joel connects his PC to the video checker (it then renews its own sign-in while it runs; after
  more than a day switched off, Joel connects it again)
- ⚪ A final "try it all" walk-through on dev, then M2 is closed

## M3 Moderation 🟡

Kept basic for now. Joel will decide later how stories are shared out between moderators.

- ✅ Plain error messages ("Something went wrong. Please try again later.")
- ✅ Staff roles: User, Moderator and Admin, with a Staff page for Admins
- ✅ One "Admin" link in the site's menu, opening an admin page to choose from
- ✅ Moderators' list of every story that isn't public: tabs with counts, search, sort, the same format and theme filters as browse, long waits in orange and red
- ✅ Admin and moderation pages centred
- ✅ Review page showing a story as the public will see it, with its history
- ✅ Approve, send back with a note, reject, take down and put back
- ✅ Take-down button on a published story's own page
- ✅ Rejections and take-downs can be overturned: approve, send back, reject, or put back in the waiting list
- ✅ Admins can delete any story
- ✅ Stories have clear states, and Edit replaces Withdraw
- ✅ Old rejected and abandoned stories are deleted automatically
- ✅ Block list for email and internet addresses
- ✅ Admins block a story's sender from its review page; the history shows which staff member did what
- ✅ Share flow tidy: drag and drop, file names, "attached" ticks, clearer preview button
- ✅ A deleted story's pictures go straight away
- ✅ A video that can't be used is sent back to its owner straight away to replace
- ✅ Bunny keeps each video's original upload, for later social media use
- ✅ Logs in one standard format
- ✅ A video's picture is added when the story is sent, with no background picture jobs
- ✅ "Attached" confirmation when coming back from another tab or device kept as it is
- ✅ Every drop-down on the site uses the same styled list, in every browser
- ✅ Text boxes, panels, menus and buttons come from one shared set, so pages don't restyle them
- ✅ The site's colours live in the shared set, named by meaning, with one red for delete buttons everywhere
- ✅ Stories page search and filters take less room: a column beside the stories from small laptops up, a Filters button on portrait tablets and phones, sort as round choice buttons
- ✅ Choose several themes at once on the Stories page and the moderators' list: only stories with all of them show
- ✅ One look each for chips, labels, "Are you sure?" steps, delete boxes, check boxes, tabs, switches, open/close sections and text boxes
- ✅ One look for buttons and links that look like buttons
- ✅ One look for notices
- ⚪ Final docs and a demo walk-through on dev
- ⚪ Two-step sign-in for staff: deferred until we're happy to pay for it

## M4 Donations 🟡

- ✅ Donate page with one-off and monthly giving (Stripe test mode)
- ⚪ Recording donors in our database
- ⚪ Gift Aid, once the charity is registered

## M5 Admin dashboard ⚪

- ⚪ The dashboard itself (three admin pages already exist from M2)
- ⚪ Background jobs view (parked by Joel until now)

## M6 Community vetting ⚪

## M7 Background AI ⚪

- ⚪ Runs on Joel's machine, later church hardware, not Google Cloud

## M8 Embeddable widgets ⚪

## Real stories ⚪

Bring in the 24 existing testimonies. Before that:

- ⚪ The consent, terms and privacy texts are checked and published for real
- ⚪ Video, audio and picture links expire within about an hour, and deleting an account cuts them
  off ("Download my data" keeps its 7-day links)
- ⚪ Joel decides how the 24 storytellers' agreement is recorded
- ⚪ The temporary database build is replaced by the official release
- ⚪ The automatic planning account stops reading dev's logs

## Go live ⚪

- ✅ UK-only settings for the whole Google organisation
- ⚪ The heisreal.today domain and the real sign-in service
- ⚪ Stripe switched from test mode to real payments (after a Stripe tool fix)
- ⚪ Church hardware secured before it holds real data
- ⚪ Church worker machines keep their clocks right (automatic time sync turned on)
- ⚪ Moving off Squarespace

## Emails ⚪

- ⚪ Submission confirmations, moderation results and the draft-deletion reminder. Public sharing
  doesn't open until these work.

## Known issues

- **Temporary database build:** dev runs a patched database so it accepts Clerk's sign-in. It
  must be replaced by the official release before any real data.
- **Database restarts:** dev's database runs on cheap servers that Google can restart. The site
  shows a calm "restarting, try again in about 2 minutes" message. The legal pages still show the
  plain error instead.
- **Stripe's monthly-gift portal** can't yet be set up in code. Must be fixed before real
  payments.
- **Dev servers sit in one London zone** until the Google billing account is upgraded.
- **Old encrypted copies of our cloud set-up** expire around 28 November 2026; check then that
  they're gone.
- **Before anything is posted to social media**, Joel decides how a deleted story is taken down
  from our own channels. Nothing posts yet.

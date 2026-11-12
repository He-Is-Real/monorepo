# Housekeeping

Housekeeping is a small job that tidies up after the site. Things people do leave work that can't
happen at once: a replaced video can't be deleted while its upload link still works, an erased
person's files at Bunny or Clerk may fail to delete the first time, and a media job may need
sending again because Joel's PC was off. Housekeeping does that work later, on a timer, with the
smallest database login that can (`service:housekeeping`, [docs/db-permissions.md](../../docs/db-permissions.md)).
The database itself refuses anything outside those rules, so a bug here can't delete the wrong
thing.

It is a Cloud Run Job (`housekeeping`, London), not a service: it starts, does its chores, logs
one line per chore and stops. OpenTofu sets it up: `infra/terraform/modules/gcp/housekeeping.tf`.

## Its two runs

| Run            | When (Europe/London) | What it does                           | Why then                                                   |
| -------------- | -------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `nightly`      | 03:30 every day      | every clean-up chore below, in order   | quiet hours                                                |
| `media-resend` | 18:00 every day      | only sends unfinished media jobs again | Joel's PC (the media worker) is on then (Joel, 2026-11-07) |

Cloud Scheduler starts the Job each time. The 03:30 trigger starts it as it is (the Job's own
setting is `HOUSEKEEPING_CHORES=nightly`); the 18:00 trigger starts the same Job with one
override, `HOUSEKEEPING_CHORES=media-resend`. Each trigger has its own Google account that may
start this Job only. The nightly run never resends, and the resend never deletes.

## The chores

Each chore does at most `max_deletions` things per run (deletions; for the resend, sends), the
oldest first; the rest wait for the next run. One chore failing doesn't stop the next.

**Nightly, in this order:**

1. **`expired-request-keys`**: deletes the "this request was already done" keys once they expire,
   24 hours after they were written. Nobody resends a request that late. Tiny rows, so it may
   delete up to 20 × `max_deletions`. Its log shows a short hash of each key, never the key.
2. **`pending-deletions`**: retries deletions outside the database that api-user couldn't finish
   or hasn't tried: an erased person's Bunny videos and Clerk account, and every deleted story's
   picture folder in the images storage. A failed try waits longer each time (1 hour, doubling, at
   most a week), so a stuck row never holds up the others. A picture folder is deleted one last
   time 15 minutes after its story went, once any upload link signed before then has expired.
3. **`expired-drafts`**: deletes drafts nobody has touched for 6 months (186 days), the way a
   person deletes their own draft. Only drafts: a story that was ever submitted is never touched.
4. **`orphan-videos`**: deletes story videos at Bunny that no story shows. Only videos titled
   with a story id and in no collection (so site videos and dev-seed's clips are never touched),
   made more than 48 hours ago, and named by no story or recent file record.
5. **`detached-files`**: deletes a video, audio file or picture its story stopped showing (replaced
   or removed), once no upload link for it can still be used (2 hours), then records it as
   removed. Already gone counts as done. Dev-seed's own pictures are only marked removed.
6. **`old-file-rows`**: deletes file records that no longer count towards the 7-day upload limits
   and whose file is removed or whose story is gone. Their media jobs go with them. No file is
   deleted here.
7. **`unfinished-pictures`**: opens a check job (reason `resent`) for each video whose picture at
   Bunny is unfinished: the result writer's lock on it ran out without Bunny confirming the
   picture, and no check of it is open (the last one gave up, say). Approval waits until it is
   finished (Joel, 2026-11-09, T4). It sends nothing: the 18:00 resend sends the job that evening.
8. **`media-retry`** (Part 1a, Joel 2026-11-10): opens a check job (reason `resent`) of the file of
   each story waiting for review whose newest media job gave up on our side (never Bunny's final
   failure: that story went back to its owner) and has none open, while the file has given up at
   most 3 times (`fn::media::our_problem`): a new check on up to 3 nights. After that the
   moderation queue shows "Can't be reviewed yet: a problem on our side". It sends nothing: the
   18:00 resend sends the job that evening.
9. **`old-media-jobs`**: deletes media jobs 30 days after they ended. Open jobs are never deleted.

**18:00:** **`media-resend`** sends every media job that hasn't ended, and was last sent (or, if
never sent, written) over 12 hours ago, to the `media-jobs` queue again, and records the send.
A job sent the same evening isn't doubled; a duplicate is harmless anyway.

What each chore may touch is also enforced by the database: see
[docs/db-permissions.md](../../docs/db-permissions.md). The rules behind them (draft retention,
upload limits, erasure) are in [docs/how-the-app-works.md](../../docs/how-the-app-works.md).

## Dry run and the per-run limit

Both are set in OpenTofu, per environment, in `infra/terraform/live/<env>/gcp/main.tf`
(`housekeeping = { … }`):

- **`dry_run`**: `true` means every chore only logs what it would do and changes nothing (the
  resend sends nothing). **Dev runs with `dry_run = false`** (Joel, 2026-11-07, once the media
  worker was built): dev holds test data only.
- **`max_deletions`**: at most this many per chore per run, 1 to 500 (dev: 50).

## Running it by hand and reading its log

```bash
# The nightly chores now:
gcloud run jobs execute housekeeping --region europe-west2 --wait
# Only the media resend now:
gcloud run jobs execute housekeeping --region europe-west2 --wait \
  --update-env-vars HOUSEKEEPING_CHORES=media-resend
# The last runs' log: one JSON line per chore, with counts and ids only.
gcloud logging read 'resource.labels.job_name="housekeeping"' --limit 20
```

Each line says the chore, whether it was a dry run, how many it selected, deleted and failed,
whether more were waiting (`more`), and the ids it acted on.

## If something looks wrong

- **A chore's `error`, or `failed` ids:** the next run tries again. The same ids failing night
  after night means a key or an outside service is broken; the chore's line says which.
- **`more: true` every night:** more is waiting than `max_deletions` allows; raise it in OpenTofu.
- **Videos, pictures, media jobs:** [docs/media-runbook.md](../../docs/media-runbook.md) ("Media
  ready", "Replaced and orphaned videos", "Replaced and orphaned images").
- **Setting it up or its accounts and keys:** [infra/terraform/README.md](../../infra/terraform/README.md),
  "Housekeeping".

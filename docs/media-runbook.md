# Media runbook: stories hidden because of their media

Joel, 2026-10-23: an approved story stays approved when its media breaks. We get the media
loading again; we don't approve the story again.

## What happens

- Processing records each video, audio file and image as `ready`, `processing` or `failed`,
  with its size and duration: for video and audio, the media-ready step below (the result
  writer, signed in as `workflow`); for pictures, a later check (M2) and M7's scanning.
- If an approved story's media stops being ready (it fails, it is checked again, or it loses its
  size or duration), the database hides the story in the same write: it adds a `hidden` entry
  (by the system) to the story's status log, so the public site and API no longer show it. Its
  owner still sees it as published.
- When the same media is `ready` again with its size and duration, the database publishes the
  story again in the same write (an `approved` entry by the system). It keeps its first
  `publishedAt` and its old slugs. Nobody has to approve it again.
- The approval's status entry keeps what the moderator reviewed (`reviewedMediaFile`,
  `reviewedImageFile`: the story's file rows, R12); the hide's entry says why (`hiddenReason`)
  and since when. Nobody can write either by hand.

Two cases don't come back on their own:

- **The media changed** (the story points at another video or audio file, or another picture,
  than the approval reviewed). A moderator approved the old media, so the new one needs a
  moderator's review. The list below shows `mediaChanged: true`. This also hides a story that
  was still public.
  A new thumbnail of the same file doesn't count (R12): re-encoding often picks another frame, and
  the story comes back with it. So re-encode a broken video. Don't upload it again (a new Bunny
  video id).
- **The story is no longer approved** (withdrawn, or a moderator's decision since). A media fix
  only brings back a story the system hid, and only while the person still has a testimony
  consent. A story that wasn't public when its media broke is never hidden or published by a
  media fix.

## Find hidden stories

On api-admin's database login (or as a developer on dev):

```sql
RETURN fn::story::hidden_by_media();
```

Each row has the story's `id`, `slug`, `title`, `primaryFormat`, `hiddenSince`, `problem` (what is
still not ready, or none) and `mediaChanged`. Oldest first. There is no history of hides and
republishes (Joel, 2026-11-05: no audit log).

## Get a video loading again

1. Find the story's Bunny video id: `SELECT record::id(mediaFile) FROM story:<id>`.
2. Look at it in Bunny Stream:
   `tools/scripts/tf.sh bunny-cli stream videos show <video id> --library <library id>`.
   The status and encode progress show what went wrong.
3. Re-encode it with the library's settings:
   `tools/scripts/tf.sh bunny-cli stream videos encode <video id> --library <library id>`.
4. If it still fails, contact Bunny support (dashboard → Support) with the library id and video
   id. Never send the person's story text or other personal data.
5. When Bunny has encoded it, processing records it `ready` with its size and duration, and the
   story comes back by itself. Check that `fn::story::hidden_by_media()` no longer lists it.

Images live in the images storage zone (`heisreal-dev-image-store` in dev). If an image fails, check the file at its path there (`SELECT record::id(image.file) FROM story:<id>`).
When processing records it `ready` again, the story comes back.

Until the media worker runs (below), nothing marks media as not ready, so nothing is hidden.

## Media ready

How a video or audio file becomes `ready` (M2 plan item 13; D78, D126, D129; design:
`project/context/research/media-worker-final.html`; OpenTofu: `infra/terraform/modules/gcp/media.tf`):

1. Bunny posts each video event to api-user's `POST /v1/webhooks/bunny` (the library's webhook
   address, set in the bunny root). api-user checks Bunny's signature (the library's read-only
   key, `bunny-stream-readonly-key`) and, for "finished", "failed" or "deleted", **writes a
   check job to the `mediaJob` table first** (or adds the reason to the file's open check job:
   one open job per file and kind), then sends `{ jobId, kind, videoId, eventId }` on the
   Pub/Sub topic `media-jobs` (ordering key: the story's id), then records the send (`sentAt`,
   `sends`). It answers 200 once Pub/Sub has it, 503 otherwise (Bunny retries for about 4 hours;
   the job stays in the table either way), 401 for a bad signature.
2. The media worker (`apps/media-worker`, with Dapr beside it, on Joel's machine; below) pulls
   the job from the `media-worker-media-jobs` subscription, asks Bunny itself for the video's
   status, size, length, thumbnail and title with the library's read-only key, and calls the
   result writer directly, signed in as the `media-worker` Google account:
   `POST /v1/media-jobs/<job id>/answer` (worker.yaml). Bunny still encoding answers `encoding`,
   Bunny's error or failed upload `failed`, and no such video at Bunny (404) `gone`.
3. The result writer (`apps/workflow`, the Cloud Run service `workflow`; only `media-worker` may
   call it) writes the video's `storyFile` row as `service:workflow` and ends the job, in one
   transaction: `applied` (the answer is saved), `stale` (an answer that reached the writer later
   is already in: `storyFile.checkedAt`) or `gone` (the story no longer shows that file, or the
   video's title isn't the story's id). The database then hides or shows the story again as
   above. Its log is one JSON line per call, ids only:
   `gcloud logging read 'resource.labels.service_name="workflow"' --limit 20`.
4. If the worker can't do a job it calls `.../failed` with a short code: `bunny_unreachable`
   (no answer, a timeout, Bunny's 5xx or 429), `bunny_refused` (Bunny refused the read-only key),
   `bunny_error` or `bunny_bad_reply` (an answer it can't use), `bunny_facts_missing` (finished,
   but without a size, length, thumbnail or title), `bunny_unknown_status`, `key_unavailable` (the
   read-only key isn't readable), `answer_rejected` (the writer refused the answer: malformed, or
   its video isn't the job's) or `worker_error` (the worker's own unexpected error); a `render`
   job's codes are below. Every answer and
   failure carries the job's video id, and the writer refuses one that isn't the job's video
   (400 `video_mismatch`; Joel, 2026-11-08).
   The writer counts it on the job (`failures`, `lastError`): under 5 it says "try again" and the
   queue redelivers the job later; at 5 the job ends as `gave_up` and the story's later jobs carry
   on. If the writer can't be reached at all, the worker leaves the job in the queue and it comes
   back later. There are no dead-letter queues (Joel, 2026-11-07): the table is the record.

### Audio picture videos

An audio story is shown as a video of its picture (or the site's default waveform picture,
`apps/media-worker/assets/default-audio-background.jpg`) with its sound (Joel, 2026-11-07:
`project/context/research/audio-picture-video.html`, decisions 1B, 2 = K1 and 4):

1. Jobs: a check that finds an audio file ready leaves it `processing` and opens a `render` job;
   so does an audio story's picture being changed or taken off while it can be edited (the
   database writes that job, and api-user sends it). Sending a video or audio story for review
   writes a check of its file (reason `submitted`), so a moderator never approves before the
   worker has looked.
2. The worker calls `POST /v1/media-jobs/<job id>/upload-pass`. The writer decides in one
   transaction: `gone` (the story no longer shows that audio file), `stale` (its sound isn't ready
   yet, it failed, or it is already a picture video made with the story's picture now) or
   `render`. For `render` it makes one new Bunny video titled with the story's id (or reuses the
   one an earlier try made: `mediaJob.madeFile`) with the full library key, which never leaves
   Google Cloud, and answers a TUS pass for that one video, valid an hour, and a 10-minute link
   to the picture.
3. Holding its render slot, the worker reads Bunny's largest MP4 copy of the audio file. Just
   before each download it asks `POST .../sound-link` (`{ videoId, height }`) for a link to that
   one MP4 copy (Joel, 2026-11-08, R3: single-file links on a need-to-use basis). The writer signs
   it with the sound zone's token key (`bunny-sound-token-key`, readable by the writer only),
   valid 2 minutes, on `heisreal-dev-sound.b-cdn.net`: a pull zone over the library's storage zone
   with no cache, so it always reads the stored file, never an old copy (Bunny's Stream CDN keeps
   copies for up to 30 days). A copy that isn't there (404) means a new link for the next size;
   a link is never asked for up front, kept or used twice. The worker holds no key to Bunny's
   storage. It then downloads the picture, checks it really is a WebP (the default is a JPEG), and
   runs ffmpeg with each input's format named and local files only (so no uploaded file can
   make ffmpeg read anything else): one frame a second, the picture's own shape at most 1280 px
   on its longer side, the sound copied unchanged, every tag dropped. Files live in a folder of
   their own under `$XDG_RUNTIME_DIR` (memory) and are removed when the job ends. It uploads the
   result with the pass and calls `.../rendered`.
4. The writer, in one transaction: adds the new video's `storyFile` row (`renderOf`: the audio
   file; `thumbnailOf`: the picture it was made with), moves `story.mediaFile` to it only while
   the story still shows the audio file (no new edit number; the audio file is detached and the
   nightly clean-up deletes it at Bunny), opens a check of the new video (reason `rendered`) and
   ends the job. The check then works like any other, and the story is approvable once it is
   ready.

A video's own picture (video-bundle-rethink part A; Joel, 2026-11-08, T1 option C: database
first). When a check finds a video ready, the writer:

1. Records the answer and the story's picture now as `storyFile.thumbnailOf` in the answer's
   transaction, but leaves the job open. An open job keeps a moderator from approving
   (`media_still_processing`). A stale answer (a newer one is in) stops here and never calls Bunny.
2. Sets that picture with Bunny's "set thumbnail" call (or Bunny's own first frame,
   `thumbnail_1.jpg`, when the story has no picture). It does so on every ready check, so if
   Bunny was left showing something else, the next check puts it right.
3. Closes the job (`applied`) only if the story's picture is still the one Bunny now shows, in
   one transaction. If it changed meanwhile, it records the new one, sets Bunny again and checks
   again (up to three tries).

If Bunny won't take the picture, the writer answers `{ retry: true }`: the job stays open, nothing
is counted as a failure, and the redelivery (or the 18:00 resend) finishes it (log
`thumbnail: <code>`). A redelivery of a job that has already ended still sets Bunny's picture
before it is acknowledged. Two deliveries of the same job can overlap (the queue delivered it
twice, or a new reason came in): if the job is open, an answer arrived after it was queued, and
the recorded picture differs from the story's, an earlier delivery may still be setting the old
one at Bunny. The later delivery then sets Bunny but doesn't close the job (`{ retry: true }`,
log `jobAfter: pending`); the earlier one finds the picture changed, puts Bunny right and closes
it, or a redelivery does. Left open: a delivery stalled for longer than Pub/Sub's redelivery
(10 seconds or more) can still reach Bunny after a later delivery closed the job; it then puts
Bunny right as soon as it continues.

A render job's failure codes: `source_gone` / `source_not_ready` (Bunny no longer has the audio
file, or hasn't finished it), `source_missing` (no MP4 copy in storage: is the library's MP4
fallback on?), `source_unreachable`, `sound_rejected` / `sound_malformed` (the writer refused the
sound link, or answered one for another file),
`picture_unreachable`, `picture_not_webp`, `picture_too_big` (its WebP header says it is over
4096 px on a side; refused before ffmpeg decodes it), `too_large` (a download, or ffmpeg's output
reaching its 2 GB `-fs` limit), `ffmpeg_missing` (install ffmpeg),
`render_failed` (ffmpeg's exit code; its output is kept out of the log, as it can name files),
`upload_refused` / `upload_unreachable` (Bunny's upload), `pass_rejected` / `pass_malformed` (the
writer refused, or answered a pass the worker can't use), and the writer's own `bunny_refused`,
`bunny_unreachable`, `bunny_error`, `bunny_bad_reply`, `key_unavailable` and `picture_unsafe` (it
couldn't make the video or sign a link). A video made for a job that then gave up is deleted by the nightly
clean-up once it is 48 hours old at Bunny (counted from the Bunny video's creation, not from
when the job gave up; an open job's video is kept).

The worker renders one picture video at a time. A render job that arrives while another renders
isn't kept waiting on the machine: it goes straight back to the queue (log step `busy`, RETRY),
which redelivers it 10 seconds to 10 minutes later, and only the job that has the render slot asks
the writer for its upload pass and picture link, and then for each sound link just before its
download, so all are fresh when they are used. Check
jobs never wait behind renders. ffmpeg uses at most two threads, so a render never takes over Joel's machine.
ffmpeg's picture decoder also refuses anything over 4096 × 4096 pixels (`-max_pixels`, in case a
WebP's frame claims more than its header), and `-xerror` makes it stop at the first decoding error
(`render_failed`) instead of retrying a looped picture until its 15-minute timeout.

### Running the media worker

The worker runs on Joel's machine against dev, and only while he runs it. It reaches out to
Google and Bunny; nothing can reach it (it and Dapr listen on 127.0.0.1 only; the worker refuses any call without the secret Dapr's sidecar sends, `APP_API_TOKEN`, and the sidecar offers only its health check, behind its own `DAPR_API_TOKEN`; both new each run, so neither another program nor a web page can hand it a job). It never touches
the database, holds only Bunny's read-only key (read from Secret Manager while it runs), and writes
nothing to disk. Uploads use a one-hour pass for one video that the writer signs, and it reads an
audio file's sound through a 2-minute link to that one file, asked for just before the download. Dapr is used for its Pub/Sub part only (D129): no state store, no
actors, no control plane.

**What it needs (once):**

- gcloud, signed in as Joel with application default credentials:
  `gcloud auth login --update-adc`. OpenTofu lets Joel's login act as `media-worker`
  (`media_ready.worker_impersonators`), so there is no key file (D126).
- Dapr's runtime: `mise install` (the pinned `dapr` CLI), then
  `dapr init --slim --runtime-version 1.19.1` (puts `daprd` in `~/.dapr/bin`; no Docker).
- ffmpeg 6 or later with libx264, from the system's packages (for audio picture videos); the
  script checks the version and the encoder and refuses to start without them.
- The repo's packages: `pnpm install`.
- A desktop session's `XDG_RUNTIME_DIR` (`/run/user/<uid>`, in memory): the script refuses to
  start without it rather than put the sign-in file on disk.

**Start:** `tools/scripts/media-worker.sh` from the monorepo. It builds the worker, looks up the
result writer's address, and starts the worker and Dapr's sidecar together. The worker first
checks that Google signs it in as `media-worker` (never as Joel himself) and stops otherwise. Its
log is one JSON line per job, ids and short codes only (`answered` with the answer and the
writer's outcome, e.g. `ready:applied`; or `failed` with the code). **Stop:** Ctrl+C (either
part stopping stops both).

How it signs in: the script turns Joel's current login into Google's standard "act as
media-worker" credentials (the same `impersonated_service_account` form
`gcloud auth application-default login --impersonate-service-account` writes) in a file in
`$XDG_RUNTIME_DIR` (memory, readable by Joel only) and removes it when it stops. Dapr's GCP
component reads it as application default credentials; the worker uses it for Secret Manager and
for the ID token it calls the writer with.

How it marks jobs: the writer saved the answer, or `/failed` says "give up": taken (acked). The
job doesn't exist any more (404), or the writer refused to count a failure (400): dropped (acked)
and logged. The writer refusing an answer (400) is reported to `/failed` as `answer_rejected`, so
it gives up after 5 like any other failure. The writer unreachable or failing, Google
refusing to sign the worker in, or `/failed` saying "try again": left in the queue, which
redelivers it 10 seconds to 10 minutes later (nacked). A message that isn't a job it can read is
dropped and logged (that includes one without a video id: every call to the writer names the
job's video).

**When Joel's login lapses:** jobs wait in the queue and the table. Sign in again
(`gcloud auth login --update-adc`) and restart the worker.

**When the PC is off:** the same: jobs wait, and the worker catches up when it starts. Approving
a story waits for its open media jobs, so stories with video wait in the moderation queue.

**Is it running?** The worker's last log line, and on Google's side the `media-worker-media-jobs`
subscription's `subscription/num_undelivered_messages` metric in Cloud Monitoring.

Everything is in London (`europe-west2`): the topic stores messages there only, and the writer
runs there. Jobs carry ids only, never a person's name or words. A job is deleted with its file
(erasure, the 7-day tidy-up), and an ended job 30 days after it ended (the nightly
`old-media-jobs` chore).

While a story's file could still be replaced through its upload link (an hour after the link was
signed; 10 minutes for a picture), or one of its files' jobs is open, a moderator can't approve it
(`media_recently_uploaded`, with the time it can be; `media_still_processing`). A SuperAdmin can.

### Processing is stalled

A story's video stays "not processed yet" (no `processing`) or `processing`.

1. Is Bunny done? `tools/scripts/tf.sh bunny-cli stream videos show <video id> --library <library id>`.
   If it's still encoding, wait.
2. Look at the file's jobs (a developer on dev, or api-user's database login):

   ```sql
   SELECT id, kind, reasons, queuedAt, sentAt, sends, failures, lastError, doneAt, outcome
   FROM mediaJob WHERE file = storyFile:`<video id>` ORDER BY queuedAt;
   ```

   - **No job:** Bunny's notice didn't arrive or was refused. api-user logs `Refused a Bunny
webhook` (bad signature: check the secret `bunny-stream-readonly-key` has the library's current
     read-only key, which the bunny root writes):
     `gcloud logging read 'resource.labels.service_name="api-user" AND textPayload:"Bunny"' --limit 20`.
   - **Open, `sentAt` empty:** the send failed (`Couldn't queue a media job` in api-user's log).
     Bunny retries for about 4 hours; the 18:00 resend (below) sends it after that.
   - **Open and sent:** it waits for the worker. The worker is off (Joel's machine) or its login
     lapsed, so jobs wait in the queue up to 31 days, and in the table for good; start it
     (above) and it catches up. How many wait: the `subscription/num_undelivered_messages` metric
     of `media-worker-media-jobs` in Cloud Monitoring.
     Each evening at 18:00 London time (when Joel's machine is on) the housekeeping Job's media
     resend sends every job not ended whose last send (or, never sent, its writing) is over 12
     hours old again, adds the reason `resent` and counts the send. A redelivered duplicate is
     harmless. To resend now: `gcloud run jobs execute housekeeping --region europe-west2 --wait
--update-env-vars HOUSEKEEPING_CHORES=media-resend` ([apps/housekeeping/README.md](../apps/housekeeping/README.md)).
   - **Open with failures:** the worker keeps failing; `lastError` says why, and the worker's own
     log says more.
   - **`gave_up`:** it failed 5 times. Fix the cause, then re-encode the video at Bunny (above):
     Bunny's next "finished" notice opens a fresh job.
   - **`gone` or `stale`:** the story no longer shows that video (replaced, removed), the video's
     title isn't the story's id, or a newer answer was already in. Nothing to do.

## Where uploads land

People's uploads go straight from their browser to Bunny; our services never handle the bytes
(M2). api-user creates each upload and signs a short-lived link for that one item. How it's
signed and what each link enforces: [infra/terraform/README.md](../infra/terraform/README.md),
"Uploads".

| Upload       | Goes to                                                                  | Stored in                                            |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Video, audio | Bunny Stream by TUS (`video.bunnycdn.com/tusupload`), one video per item | Frankfurt, Germany: the library's storage (D89)      |
| Story image  | The images storage zone by S3 PUT (`uk-s3.storage.bunnycdn.com`)         | London: `heisreal-dev-image-store` in dev, no copies |

"Story image" is any story's own picture (M2 plan PR 10): a written story's image, an audio
story's picture, or a video's own thumbnail (Joel, 2026-10-30). It's always `story.image`, at
`stories/<story id>/<32 hex>.webp`, never set at Bunny Stream; cards and the story page show it in
place of Bunny's generated thumbnail (`clipPicture`, `libs/story-cards`). Processing and the
media-ready step can't change it: the story points at the picture's own file row (`image.file`,
R12), and workflow writes only that row's processing fields
(`libs/database/schema/schema-04-stories.surql`).

**MP4 copies (C1, Joel 2026-11-06):** the library also makes an MP4 file of each video and audio
item per encoded resolution (`<video id>/play_<height>p.mp4`, up to 1080p; stored with the video in
Frankfurt), so "Download my data" can give the person their video as a file: a 7-day signed link
to the largest copy (`mp4Url`). api-user asks Bunny's API which copies each video has
(`hasMP4Fallback`, `availableResolutions`), one call per video, because the database doesn't
record it. Videos encoded before the switch have none (`mp4Url` is `null`). The upload itself is
never kept (`original_files_keep = false`).

Bunny's MP4 copies can carry the upload's location: on dev (2026-11-06) the 360p copy of a tagged
MOV kept it as a `loci` box, while the 480p and 720p copies, the HLS playlists and segments, the
thumbnail and the preview kept nothing. So the browser removes it before upload (M2, Joel
2026-11-06; `apps/web/src/lib/strip-media-metadata.ts`): in an MP4, MOV or M4A file, every `udta`,
`meta` and XMP `uuid` box (top level, `moov`, `trak`, `mdia`, `minf`) becomes a `free` box of the
same size, zeroed. No offsets move and the media isn't re-encoded. MP3, WAV and WebM files, and
files whose boxes don't add up, upload as they are.

Opening a link from the file sends no `Referer`, so the library allows requests without
one; the signed token still guards every file. Anyone allowed to watch a published video can also
fetch its MP4 with the player's token: it is the same video they can already watch.

No personal data goes into Bunny names: a video's title is the story id (D69) and an image's path
is under the story's folder (D80). Deleting an image leaves its folder behind, so deletions remove
the folder too. To check uploads still work against dev: `pnpm nx run dev-seed:upload-spike` (a
developer, with gcloud ADC and ffmpeg; it deletes what it uploads).

## Replaced and orphaned videos

Each video or audio story has one Bunny video at a time, titled with the story id (D69). api-user
creates it when the person chooses a file (RequestUpload), and the database puts it on the draft
through its file row (`storyFile`, R12; D80: the person's browser never names a video).

- **Replaced:** choosing another file creates a new video and deletes the old one at Bunny at
  once, because nobody reviewed it. Its file row is marked detached (`detachedAt`); the nightly
  sweep deletes the file again once no upload link for it can be used (2 hours; a 404 counts as
  done) and records `removedAt`, so a delete that failed is retried. The same goes for a replaced
  or removed picture. The row stays until it no longer counts towards the 7-day upload limits.
  A detached row with no `removedAt` a day or two later means the clean-up is failing:
  `SELECT * FROM storyFile WHERE detachedAt < time::now() - 1d AND removedAt = NONE`.
- **Deleted stories:** when a person deletes their draft, withdrawn or rejected story (D71),
  api-user deletes every video it made for that story (its file rows) at Bunny straight
  after the database commits. Only those videos: dev's seeded media and site assets are never
  touched. The rows stay for the upload limits.
- **Orphans** (a video on Bunny that no story shows) happen when that delete fails (api-user
  logs `Couldn’t delete replaced video …` or `… a deleted story’s video …`), when the database refused the file row after the video
  was created and the delete after it failed (`… after a refused upload`), when api-user lost the
  database's answer to the file row and couldn't tell whether it committed (`… has no known outcome;
video kept`: never deleted then, since it may be the draft's file; the person's retry with the
  same Idempotency-Key settles it), or when a person
  abandons a draft whose file never finished (Bunny keeps it at status 0, "created").
- **The nightly sweep** (the `housekeeping` Cloud Run Job, `apps/housekeeping`; set up in
  [infra/terraform/README.md](../infra/terraform/README.md), "Housekeeping") deletes them at
  03:30 London time. A video goes only if all of these hold:
  - it's a story video: its title is a story id, and it's in no collection. So site videos (the
    `site-assets` collection) and dev-seed's clips (titled `dev-seed/clip-NN`) are never touched;
  - Bunny made it more than 48 hours ago. An upload in progress, a draft that has just been given
    it, and a file row with no known outcome (settled by the person's retry within the
    Idempotency-Key's 24 hours) are left alone;
  - no story points at it, and no file row made or renewed (a resume signed its link again) in
    the last 48 hours names it.

  It deletes at most 50 videos a night (`max_deletions`), oldest first; the rest wait for the
  next night. With `dry_run` on it only logs what it would delete; dev runs with it off
  (Joel, 2026-11-07; [apps/housekeeping/README.md](../apps/housekeeping/README.md)).
  Its log is one JSON line per chore with counts and ids only:
  `gcloud logging read 'resource.labels.job_name="housekeeping"' --limit 20`.

- **Abandoned drafts** (D71): the same Job first deletes drafts nobody has touched for 186 days
  (6 months of 31 days, `fn::story::draft_retention`), the way a person deletes their own
  draft. Resuming an upload counts as touching the draft: api-user signs the link only once that
  is recorded, and the two can't both win a race. Their videos are then orphans, and go in the same run once they're 48 hours old.
- To look for orphans by hand: a story id with no story, or a video id that isn't the story's
  `record::id(mediaFile)`:

  ```bash
  tools/scripts/tf.sh bunny-cli api GET '/library/<library id>/videos?itemsPerPage=100' | jq '.items[] | {guid, title, status, dateUploaded}'
  ```

  Delete one with `tools/scripts/tf.sh bunny-cli api DELETE /library/<library id>/videos/<guid>`.
  A Stream video has no storage folder to remove (the empty-folder issue is the images zone's).

- **A link still in use after submit:** a TUS link lasts an hour and binds only the video (D68),
  so a file could be uploaded over an unfinished one until it expires. api-user signs no new
  link once the story is submitted, and submit needs Bunny's own length of the file.

## Replaced and orphaned images

Pictures (M2 plan PR 10) work like videos, but api-user **never deletes a replaced or removed
one itself**: the nightly sweep does, once its PUT link can no longer be used (R12, the
`detached-files` chore: the file `stories/<story id>/<32 hex>.webp`, then `removedAt` on its
row). A deleted story's pictures go a whole folder (`stories/<story id>/`) at a time, through the
deletion queue (`pendingDeletion`, kind `image`). **Every story delete queues its folder**,
whoever deletes it, in the same transaction (the database event `story_picture_folder`, one row
per folder): it works from the story itself, never from its file rows, which are pruned 7 days
after they stop counting (a queue built from those rows missed files).

- **Erasure** (D39, D40): api-user deletes the erased person's stories' folders straight after
  the commit, and the nightly housekeeping retries what failed.
- **A person deleting their own story**, and **abandoned drafts** housekeeping deletes (D71): the
  next night's pending-deletions chore deletes the folder (the dry-run rule applies: in a dry
  run it only logs it).
- **Late uploads:** a picture's PUT link lasts 10 minutes, so one signed just before the story's
  delete could still put a file in the folder after it was deleted. So a folder's row stays
  queued after a delete until its **final pass**, 15 minutes after the story went
  (`finalPassAt`); the database refuses to remove the row before then, and the first delete at
  or after it (housekeeping's next run, or api-user's after a later erasure) removes the row.
  A failed try still waits and counts as usual; dry runs and the per-run limit apply.
- **Reused story ids:** while a folder's row is queued, the database refuses
  to create a story with that id, except for a system user (dev-seed's reset reuses its ids). A
  second delete of the same id moves the final pass to 15 minutes after it and makes the row due
  again, so a recreated story's late upload is still caught.

A story that never had a picture costs one delete answering 404; dev-seed's reset queues one per
seeded story (their pictures live in `dev-seed/`, not in a story folder, so nothing of theirs is
deleted).

Deleting a folder deletes everything in it (Bunny's Edge Storage API,
`DELETE https://uk.storage.bunnycdn.com/<zone>/stories/<story id>/` with the zone password as
`AccessKey`; 200, or 404 once gone), so the picture and any it replaced go together. Housekeeping
reads the zone password through the bunny root's `storage_password_readers`; without it, picture
deletions wait in the queue and the run logs an error.

A picture its story stopped pointing at is deleted by the nightly `detached-files` chore (R12):

- **Replaced:** a new picture for the same story (its row stays 7 days for the hourly limit;
  pictures never count towards the weekly one, Joel 2026-10-30).
- **Removed:** the person removes the picture (`PATCH` `image: null`), or a video's thumbnail
  (the video goes back to Bunny's own).

Otherwise each of these leaves an orphan file in the images zone (D40):

- **Never uploaded:** the file row committed and the picture is on the draft, but the browser's PUT
  never arrived (closed tab, expired 10-minute link). The story then points at a missing file;
  processing (M7) marks it `failed`, and approval waits for `ready` (A2). A picture whose PUT
  arrived after the person replaced it is an orphan too.
- **Lost answers:** api-user lost the database's answer to the file row; the retry with the same
  Idempotency-Key replays the same path, so nothing new is made. The browser keeps the upload's
  request until its PUT succeeds (or answers 412: the file is there), so a PUT that failed or
  whose answer was lost is retried at the same path with a freshly signed link, never a new row.

Find orphans by listing a story's folder and comparing with the story's `record::id(image.file)`, then delete the file and, if it's empty, the folder (the Edge Storage API,
`DELETE https://uk.storage.bunnycdn.com/<zone>/stories/<story id>/`; deleting a folder's last
object by S3 leaves the folder behind).

## The Stream player

Videos and audio play in Bunny's player, a frame from `player.mediadelivery.net`. Its look comes
from the Stream library's settings in OpenTofu (`bunnynet_stream_library.media` in
`infra/terraform/modules/bunny/main.tf`), matched to the site theme (`apps/web/src/app/global.css`).
Change them there, never in Bunny's dashboard: a dashboard change shows up as drift in the next plan.

| Setting                                                          | Value                  | Why                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player_version`                                                 | 2                      | Bunny's current player. `player-head.html` targets its element names.                                                                                                   |
| `player_primary_color`                                           | `#4e9ba0`              | The brand teal: the progress bar, volume level and large play button. Bunny's default is orange.                                                                        |
| `player_font_family`                                             | `inter`                | The time, menus and captions. The site's DM Sans isn't one of Bunny's eight fonts; Inter is the closest. Bunny serves it from fonts.bunny.net.                          |
| `player_captions_font_color`, `player_captions_background_color` | `#ffffff` on `#000000` | Captions sit on the picture, not on the page, so they don't follow the site theme. White on opaque black is readable on any frame.                                      |
| `player_captions_font_size`                                      | 20                     | Bunny's default size.                                                                                                                                                   |
| `player_language`                                                | `en`                   | The player's own labels.                                                                                                                                                |
| `player_controls`                                                | Bunny's set            | Bunny's defaults without AirPlay (no Apple-specific technology). Bunny draws them in its own order.                                                                     |
| `player_watchtime_heatmap_enabled`                               | off                    | No viewing data on the progress bar (no public engagement signals).                                                                                                     |
| `watermark_*`                                                    | 0                      | No watermark.                                                                                                                                                           |
| `vast_tag_url`                                                   | empty                  | No adverts.                                                                                                                                                             |
| `player_custom_head` (`player-head.html`)                        | CSS                    | 44 px touch targets (AGENTS.md), an opaque black background, the site's teal focus ring, and a dark icon on the teal large play button (5.9:1; white on teal is 3.2:1). |

Rules for `player-head.html`, checked by the module's tftest: CSS only, with no script, imports or
external URLs. It relies on the player's element names, so a Bunny player update could undo it;
`apps/dev-seed/behavioural/media.behaviour.ts` measures the real player's controls on a 320 px phone.

The player is dark in both site themes, like the design's player. It can't follow the site's
light/dark switch: it's a frame from another domain, and Bunny's embed has no theme setting or URL
parameter. No autoplay: web asks for `autoplay=false` on story pages, and a card's player starts
only from the visitor's press (`apps/web/src/components/stories/story-media.tsx`).

Not in the OpenTofu provider, so left at Bunny's values (checked 2026-10-25): playback speeds,
compact controls (off), remember position (off: the player stores nothing until a visitor changes
a setting, `/privacy`), and the video metadata exposure.

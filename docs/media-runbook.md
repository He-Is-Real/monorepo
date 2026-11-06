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

How a video or audio file becomes `ready` (M2 plan item 13; D78, D126, D129; plan:
`project/context/research/m2-media-ready-plan.html`; OpenTofu: `infra/terraform/modules/gcp/media.tf`):

1. Bunny posts each video event to api-user's `POST /v1/webhooks/bunny` (the library's webhook
   address, set in the bunny root). api-user checks Bunny's signature (the library's read-only
   key, `bunny-stream-readonly-key`) and, for "finished" or "failed", puts `{ videoId, eventId }`
   on the Pub/Sub topic `media-jobs`. It answers 200 once Pub/Sub has it, 503 otherwise (Bunny
   retries for about 4 hours), 401 for a bad signature.
2. The media worker (Dapr, on Joel's machine; **not built yet**, the next piece) pulls the job
   from the `media-worker` subscription, asks Bunny itself for the video's status, size, length,
   thumbnail and title, and publishes its answer to `media-results`.
3. Pub/Sub pushes the answer to the result writer (`apps/workflow`, the private Cloud Run service
   `workflow`). It writes the video's `storyFile` row as `service:workflow`, only while the
   story still shows that video, and nothing if the row already says the same. The database
   then hides or shows the story again as above. Its log is one JSON line per answer, ids only:
   `gcloud logging read 'resource.labels.service_name="workflow"' --limit 20`.

Everything is in London (`europe-west2`): the topics store messages there only. Jobs and answers
carry ids and facts, never a person's name or words.

### Processing is stalled

A story's video stays "not processed yet" (no `processing`) or `processing`.

1. Is Bunny done? `tools/scripts/tf.sh bunny-cli stream videos show <video id> --library <library id>`.
   If it's still encoding, wait.
2. Did Bunny's notice arrive? api-user logs `Refused a Bunny webhook` (bad signature: check the
   secret `bunny-stream-readonly-key` has the library's current read-only key, which the bunny
   root writes) or `Couldn't queue media job` (Pub/Sub refused):
   `gcloud logging read 'resource.labels.service_name="api-user" AND textPayload:"Bunny"' --limit 20`.
3. Are jobs waiting? The worker is off (Joel's machine), so they wait up to 31 days; start it,
   and it catches up. How many wait:
   `gcloud pubsub subscriptions describe media-worker --format='value(name)'` and the
   `subscription/num_undelivered_messages` metric in Cloud Monitoring.
4. Did the writer drop it? Its log says `"outcome":"ignored"` when the story no longer shows that
   video (replaced, removed) or the video's title isn't the story's id.
5. To queue a job by hand (a developer; ids only):
   `gcloud pubsub topics publish media-jobs --message='{"videoId":"<video id>"}'`.

### A message ended in dead letters

After 5 failed deliveries (a malformed message, or the writer failing every time) Pub/Sub moves
it to `media-dead-letters`, kept 31 days. Look at them (a developer; ack only once dealt with):

```bash
gcloud pubsub subscriptions pull media-dead-letters --limit 10 --format=json \
  | jq '.[] | {ackId, attributes: .message.attributes, data: (.message.data | @base64d)}'
```

The `CloudPubSubDeadLetterSourceSubscription` attribute says where it came from. Fix the cause
(the writer's log names it: `Refused a media result` for a malformed answer), then send it again
to its topic (`gcloud pubsub topics publish media-jobs|media-results --message='<data>'`; an
message needs `--ordering-key=<story id>`) and acknowledge the dead letter
(`gcloud pubsub subscriptions ack media-dead-letters --ack-ids=<ackId>`). A video whose size
is wider than 3:1 or taller than 1:3 is refused by the database (D53) and ends here: re-encode
won't help; tell the person through moderation.

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
  next night. In dev it starts in a dry run: it logs what it would delete and deletes nothing.
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

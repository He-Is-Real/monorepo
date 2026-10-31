# Media runbook: stories hidden because of their media

Joel, 2026-10-23: an approved story stays approved when its media breaks. We get the media
loading again; we don't approve the story again.

## What happens

- Processing (workflow, M7) records each video, audio file and image as `ready`, `processing` or
  `failed`, with its size and duration.
- If an approved story's media stops being ready (it fails, it is checked again, or it loses its
  size or duration), the database hides the story in the same write. Its `publicStory` row is
  deleted, so the public site and API no longer show it. Its status stays `approved`.
- When the same media is `ready` again with its size and duration, the database publishes the
  story again in the same write. It keeps its first `publishedAt` and its old slugs. Nobody has
  to approve it again.
- Each step writes an `auditLog` row: `HideStory` (reason `media_unavailable`) and
  `RepublishStory` (reason `media_restored`). The actor is empty: the database did it.
- A `hiddenStory` row (same id as the story) says it is hidden and since when. Nobody can
  write it by hand.

Two cases don't come back on their own:

- **The media changed** (another Bunny video id or image path, or a thumbnail that isn't one of
  Bunny's generated frames). A moderator approved the old media, so the new one needs a
  moderator's review. The list below shows `mediaChanged: true`. This also hides a story that
  was still public (`auditLog` reason `media_changed`).
  A generated frame of the same video (`thumbnail_1.jpg` to `thumbnail_5.jpg`) doesn't count
  (D60): re-encoding often picks one, and the story comes back with it. So re-encode a broken
  video. Don't upload it again (a new Bunny video id), and don't upload a custom thumbnail.
- **The person withdrew consent.** Consent rules publishing (D17), so the story stays off the
  public site. Withdrawing consent also ends the hide, so giving consent again later doesn't
  publish it. A story that wasn't public when its media broke is never hidden or published by
  a media fix.

## Find hidden stories

On api-admin's database login (or as a developer on dev):

```sql
RETURN fn::story::hidden_by_media();
```

Each row has the story's `id`, `slug`, `title`, `primaryFormat`, `hiddenSince`, `problem` (what is
still not ready, or none) and `mediaChanged`. Oldest first. The `auditLog` rows for the story
(`entity = story:<id>`) show each hide and republish.

## Get a video loading again

1. Find the story's Bunny video id: `SELECT media FROM story:<id>` (`bunnyVideoId`).
2. Look at it in Bunny Stream:
   `tools/scripts/tf.sh bunny-cli stream videos show <video id> --library <library id>`.
   The status and encode progress show what went wrong.
3. Re-encode it with the library's settings:
   `tools/scripts/tf.sh bunny-cli stream videos encode <video id> --library <library id>`.
4. If it still fails, contact Bunny support (dashboard → Support) with the library id and video
   id. Never send the person's story text or other personal data.
5. When Bunny has encoded it, processing records it `ready` with its size and duration, and the
   story comes back by itself. Check that `fn::story::hidden_by_media()` no longer lists it.

Images live in the images storage zone (`heisreal-dev-image-store` in dev). If an image fails, check the file at its `path` there.
When processing records it `ready` again, the story comes back.

Until M7 is built nothing marks media as not ready, so nothing is hidden.

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
media-ready step can't change it: `story.image`'s VALUE keeps workflow to `processing` alone
(`libs/database/schema/schema.surql`).

No personal data goes into Bunny names: a video's title is the story id (D69) and an image's path
is under the story's folder (D80). Deleting an image leaves its folder behind, so deletions remove
the folder too. To check uploads still work against dev: `pnpm nx run dev-seed:upload-spike` (a
developer, with gcloud ADC and ffmpeg; it deletes what it uploads).

## Replaced and orphaned videos

Each video or audio story has one Bunny video at a time, titled with the story id (D69). api-user
creates it when the person chooses a file (RequestUpload), and the database puts it on the draft
through an upload grant (D80; the person's browser never names a video).

- **Replaced:** choosing another file creates a new video and deletes the old one at Bunny at
  once, because nobody reviewed it. Its grant row stays for 7 days so the upload limits still
  count it.
- **Deleted stories:** when a person deletes their draft, withdrawn or rejected story (D71),
  api-user deletes every video it made for that story (its upload grants) at Bunny straight
  after the database commits. Only granted videos: dev's seeded media and site assets are never
  touched. The grants stay for the upload limits.
- **Orphans** (a video on Bunny that no story shows) happen when that delete fails (api-user
  logs `Couldn’t delete replaced video …` or `… a deleted story’s video …`), when the database refused the grant after the video
  was created and the delete after it failed (`… after a refused upload`), when api-user lost the
  database's answer to the grant and couldn't tell whether it committed (`… has no known outcome;
video kept`: never deleted then, since it may be the draft's file; the person's retry with the
  same Idempotency-Key settles it), or when a person
  abandons a draft whose file never finished (Bunny keeps it at status 0, "created").
- **The nightly sweep** (the `housekeeping` Cloud Run Job, `apps/housekeeping`; set up in
  [infra/terraform/README.md](../infra/terraform/README.md), "Housekeeping") deletes them at
  03:30 London time. A video goes only if all of these hold:
  - it's a story video: its title is a story id, and it's in no collection. So site videos (the
    `site-assets` collection) and dev-seed's clips (titled `dev-seed/clip-NN`) are never touched;
  - Bunny made it more than 48 hours ago. An upload in progress, a draft that has just been given
    it, and a grant with no known outcome (settled by the person's retry within the
    Idempotency-Key's 24 hours) are left alone;
  - no story's media, no published story's media and no upload grant made or renewed (a resume
    signed its link again) in the last 48 hours names it.

  It deletes at most 50 videos a night (`max_deletions`), oldest first; the rest wait for the
  next night. In dev it starts in a dry run: it logs what it would delete and deletes nothing.
  Its log is one JSON line per chore with counts and ids only:
  `gcloud logging read 'resource.labels.job_name="housekeeping"' --limit 20`.

- **Abandoned drafts** (D71): the same Job first deletes drafts nobody has touched for as long as
  the testimony forms promise (6 months, counted as 186 days), the way a person deletes their own
  draft. Resuming an upload counts as touching the draft: api-user signs the link only once that
  is recorded, and the two can't both win a race. Their videos are then orphans, and go in the same run once they're 48 hours old.
- To look for orphans by hand: a story id with no story, or a video id that isn't the story's
  `media[0].bunnyVideoId`:

  ```bash
  tools/scripts/tf.sh bunny-cli api GET '/library/<library id>/videos?itemsPerPage=100' | jq '.items[] | {guid, title, status, dateUploaded}'
  ```

  Delete one with `tools/scripts/tf.sh bunny-cli api DELETE /library/<library id>/videos/<guid>`.
  A Stream video has no storage folder to remove (the empty-folder issue is the images zone's).

- **A link still in use after submit:** a TUS link lasts an hour and binds only the video (D68),
  so a file could be uploaded over an unfinished one until it expires. api-user signs no new
  link once the story is submitted, and submit needs Bunny's own length of the file.

## Replaced and orphaned images

Pictures (M2 plan PR 10) work like videos, but api-user **never deletes one**: a story sent back
for changes still has its approved copy public, and that copy may show the old picture. So each of
these leaves an orphan file in the images zone until the clean-up sweep (D40):

- **Replaced:** a new picture for the same story (its grant row stays 7 days for the hourly
  limit; pictures never count towards the weekly one, Joel 2026-10-30).
- **Removed:** the person removes the picture (`PATCH` `image: null`), or a video's thumbnail
  (the video goes back to Bunny's own).
- **Never uploaded:** the grant committed and the picture is on the draft, but the browser's PUT
  never arrived (closed tab, expired 10-minute link). The story then points at a missing file;
  processing (M7) marks it `failed`, and approval waits for `ready` (A2). A picture whose PUT
  arrived after the person replaced it is an orphan too.
- **Lost answers:** api-user lost the database's answer to the grant; the retry with the same
  Idempotency-Key replays the same path, so nothing new is made. The browser keeps the grant's
  request until its PUT succeeds (or answers 412: the file is there), so a PUT that failed or
  whose answer was lost is retried at the same path with a freshly signed link, never a new grant.

Find orphans by listing a story's folder and comparing with `story.image.path` (and the
`publicStory`'s), then delete the file and, if it's empty, the folder (the Edge Storage API,
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

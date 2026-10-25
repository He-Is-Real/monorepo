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

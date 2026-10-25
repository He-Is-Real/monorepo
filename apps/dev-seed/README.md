# dev-seed

Resets the **dev** database to the D47 dummy dataset (D49). A Cloud Run Job, dev only, defined in
`infra/terraform/modules/gcp/dev_seed.tf`. Started by the "Reset dev data" Action (D50) or by a
developer. It never runs anywhere else: OpenTofu refuses it outside `heisreal-dev`, the program
refuses unless its settings say dev, and the reset itself refuses unless the database says dev
and has its consent forms published (dev's placeholders, D75).

## What it does

One transaction, all or nothing (`src/app/seed.ts`):

1. Checks `_setting:consent`: environment `dev`, and a sign-up and a testimony form in force.
2. Wipes the content: `story` (and with it `publicStory` and `moderationReview`), `auditLog`,
   `idempotencyKey`, `tag`, and fixture people (`user:seed_*`) no longer in the dataset.
3. Loads the dataset (`src/app/dataset`): 8 fixture people without Clerk accounts, the browse
   tags, and 26 stories. Each story is created as a draft and walked to its final state the way
   the services will (submit, pick up, decide), so versions, `submittedAt`, locks, feedback and
   reviews look real. Approved stories get their `publicStory` row.
4. Gives every fixture person real consent (D75; D48's relaxed checks are off in dev): grants
   in the append-only ledger for the sign-up form (18+, account) and the testimony form (Art 9,
   publish) in force, with the evidence hash the API records (`@heisreal/consent/evidence`). A
   grant is added only when the person's current one isn't on the version in force, so resets
   don't grow the ledger; a new form version gets new grants at the next reset.
   18+ is ticked on the sign-up form only (D93). Nobody ticks the optional social sharing form,
   so no dummy story may be shared beyond the dev site.

Kept: people who signed in with Clerk, the consent ledger, DPA versions, settings and the
migration ledger.

It signs in as `dev_seed`, a dev-only system user (EDITOR) that SurrealDB's startup init creates
when the cluster root's `dev_seed_login` is on. Table permissions don't apply to it, but every
event does: story types and shapes (D53), text limits, the approval gate (A2) and the read
model's mirror check. `integration/seed.int-spec.ts` loads the dataset into a real SurrealDB with
the real schema on every PR.

## The dataset (D47)

`src/app/dataset/index.ts`. 12 video, 3 audio and 11 written stories; 16 approved, 2 pending,
2 in review, 2 sent back with feedback, 1 rejected, 1 withdrawn, 2 drafts. Edge cases: anonymous
byline, a 140-character title, 0 and 5 tags, non-Latin text, a long description, written text at
exactly 200 and 10,000 characters, and a short draft. `dataset.spec.ts` keeps it covering D47 as it
grows. The walking skeleton's old slug, `test-story-walking-skeleton`, stays published.

## Media (uploaded once)

| What                                                                                    | Where                      |
| --------------------------------------------------------------------------------------- | -------------------------- |
| The spec: 7 video clips, 3 audio clips (at most 20 s), 5 WebP images with fake GPS EXIF | `src/app/media.ts`         |
| The generated files (not committed)                                                     | `tmp/dev-seed-media/`      |
| What Bunny holds: video ids, encode results, image paths (committed, no keys)           | `src/app/bunny-media.json` |

The files aren't committed: about 4 MB of binaries in a public repo for something uploaded once.
The spec regenerates equivalent files any time, and the seed only needs what Bunny reports.

A developer uploads them once (needs ffmpeg with libx264, libwebp, libmp3lame and drawtext, and
access to the dev `bunny-*` secrets):

```bash
pnpm nx run dev-seed:generate-media
tools/scripts/tf.sh bunny output bunny          # note stream_library_id
pnpm nx run dev-seed:upload-media --args="--library-id <id> --dry-run"
pnpm nx run dev-seed:upload-media --args="--library-id <id>"
git add apps/dev-seed/src/app/bunny-media.json  # commit it in a PR
```

For a new library (a new Bunny account or a recreated library), first empty the record, since
`upload-media` refuses a record for another library:
`{ "libraryId": "", "clips": {}, "images": {} }`.

**Uploaded on 2026-10-25** to the dev library (789855) and storage zone
(`heisreal-dev-image-store`), after the first Bunny account was deleted: 7 video clips, 3 audio
clips and 5 images, all encoded with the spec's sizes and lengths. Bunny Stream accepts audio-only
MP3s: it encodes them as a blank 1280x720 video at 360p, 480p and 720p (about 1 MB each), so
`bunny-media.json` keeps their length; their width and height are their thumbnail's (below).

**Audio clips use the site's default audio thumbnail** (since 2026-10-24), not Bunny's speaker
poster: `upload-media` sets `media/default-audio-thumbnail.jpg` on each audio clip that still has
Bunny's `thumbnail.jpg` (Stream API "Set Thumbnail"; Bunny stores it as `thumbnail_<hash>.jpg`)
and records that `thumbnailPath` with the picture's size (1280x720, `DEFAULT_AUDIO_THUMBNAIL`):
an audio story's width and height are its thumbnail's (Joel, 2026-10-24). A new thumbnail is changed media for a story already approved
(D59/D60), so run "Reset dev data" after committing the new `bunny-media.json`: the stories are
seeded again with it. The image's source is `media/default-audio-thumbnail.svg`; render it with
`magick -density 96 default-audio-thumbnail.svg -quality 82 -sampling-factor 4:2:0 -strip
default-audio-thumbnail.jpg` (1280x720, about 26 KB). The waveform stays inside rows 260-460, so
it survives the player's cover crop into a wide audio bar.

`upload-media` finds each clip by its title (`dev-seed/<id>`) and each image by its path
(`dev-seed/<id>.webp`) and uploads only what's missing, so a second run uploads nothing. It waits
for Bunny's encode and refuses a size or length that doesn't match the spec. Until
`bunny-media.json` lists every clip and image the dataset uses, the Job refuses to run (exit 2).

## Running it

| Task                     | Command                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Reset dev                | Actions → "Reset dev data" → Run workflow (main)                                       |
| Reset and test dev       | Actions → "Dev behavioural tests" → Run workflow (main)                                |
| Reset dev by hand        | `gcloud run jobs execute dev-seed --region europe-west2 --project heisreal-dev --wait` |
| Behavioural tests only   | `pnpm nx run dev-seed:behavioural` (after a reset)                                     |
| Unit / integration tests | `pnpm nx test dev-seed`, `pnpm nx run dev-seed:test-integration` (Docker)              |
| Dataset in other tests   | `@heisreal/dev-seed/testing`: `devDatabaseWithDataset()` (test-only; a devDependency)  |

Exit status: 0 done, 1 failed (nothing changed), 2 refused.

The behavioural tests (`behavioural/`) check the API (`api.behaviour.ts`), the pages
(`web.behaviour.ts`) and media token auth (`media.behaviour.ts`, D52): a published video's player,
thumbnail and HLS, an audio player and a written story's image are signed and load; the same links
unsigned or with a moved expiry get 403 from Bunny, and so do the images of unpublished stories
(`image-02`, `image-05`); the story page's player plays (it fetches the HLS playlist); and on a
320 px phone the real player's controls are at least 44 × 44 px and fit inside it (the web e2e
stub can't prove this; the CSS is the library's custom head, `modules/bunny/player-head.html`). The media
checks need signing on in dev (`api_public_read_media`, `infra/terraform/README.md`, "Media token
auth").

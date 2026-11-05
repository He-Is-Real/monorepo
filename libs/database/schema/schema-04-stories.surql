-- schema-04-stories.surql: stories (write model), published stories (read model), hidden
-- stories, draft retention, moderation reviews and upload grants.
-- Part of the declarative schema: every schema-NN-*.surql file, applied in name order in one
-- transaction (see schema-01-system.surql).

-- ---------------------------------------------------------------- story (write model)
-- A person's commands run in their own session (D27), so ownership is checked by the database.
-- api-user's own login can only delete (erasure): it can't read, create, reassign or edit stories.
-- Write scope per field (D41): the person's words (content fields) only by the person; moderation
-- fields only by api-admin; media fields by workflow (processing) and api-user's login, through an
-- upload grant only (D80: never the person's session; uploadGrant_attach), and `processing` (A2)
-- by workflow only. A field write outside its scope is silently dropped (field PERMISSIONS,
-- or the field's VALUE for `processing`), so check the stored state.
DEFINE TABLE OVERWRITE story SCHEMAFULL PERMISSIONS               -- id = story:<ulid>
  -- housekeeping reads every story's status, dates and media ids (never its words: the content
  -- fields below refuse it) to find abandoned drafts and orphaned Bunny videos.
  FOR select WHERE submitter = $auth.id
    OR $auth.id IN [service:api_admin, service:workflow, service:housekeeping],
  FOR create WHERE submitter = $auth.id AND status = 'draft'                -- own draft only,
    AND $auth.status != 'deleted',                -- not erased (agreements: story_agreements)
  FOR update WHERE (submitter = $auth.id AND $auth.status != 'deleted')
    OR $auth.id IN [service:api_admin, service:workflow],
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin]   -- erasure
    -- D71: the owner deletes their own draft, withdrawn or rejected story (DeleteStory), and one
    -- sent back for changes (Joel, 2026-10-30: no need to withdraw it first), never one in
    -- moderation's hands or published (pending, in_review, approved).
    OR (submitter = $auth.id AND $auth.status != 'deleted'
        AND status IN ['draft', 'changes_requested', 'withdrawn', 'rejected'])
    -- D71: the nightly housekeeping Job deletes a draft nobody has touched for as long as the
    -- retention says (fn::story::draft_expired), and nothing else; the same delete as a
    -- person's own (events and cascade included).
    OR ($auth.id = service:housekeeping AND fn::story::draft_expired(id));
DEFINE FIELD OVERWRITE submitter     ON story TYPE record<user> READONLY;   -- owner can never be reassigned
DEFINE FIELD OVERWRITE version       ON story TYPE int VALUE IF $before = NONE { 1 } ELSE { $before + 1 };   -- D29: +1 on every command; ETag
-- Content: what the person wrote. Never api-admin or workflow (D41); moderators request changes.
-- housekeeping never reads the words (select below): it needs only ids, status, dates and media.
DEFINE FIELD OVERWRITE slug          ON story TYPE string           -- generated at create, unique
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE title         ON story TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 140
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE description   ON story TYPE string ASSERT string::len($value) <= 5000
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE body          ON story TYPE option<string>   -- written stories
  -- A hard ceiling; the limit itself is a setting (W3: storyTextMax, story_text_limits).
  ASSERT $value = NONE OR string::len($value) <= 50000
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE bylineName    ON story TYPE option<string>   -- story content chosen per story (D16); NONE = anonymous
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE primaryFormat ON story TYPE string ASSERT $value IN ['video', 'audio', 'written']
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- The story's themes (D15: links, no denormalised names). 20 is a hard ceiling; the number a
-- story needs is a setting, checked at submission only (story_text_limits).
DEFINE FIELD OVERWRITE themeRefs     ON story TYPE array<record<theme>> DEFAULT []
  ASSERT array::len($value) <= 20 AND array::len(array::distinct($value)) = array::len($value)
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- Status: the owner (submit/withdraw, checked by the events below) and api-admin (moderation).
DEFINE FIELD OVERWRITE status        ON story TYPE string DEFAULT 'draft'
  ASSERT $value IN ['draft', 'pending', 'in_review', 'approved', 'rejected', 'changes_requested', 'withdrawn']
  PERMISSIONS FOR update WHERE $auth != service:workflow;
-- D53: the optional image of a written story, an audio story's own picture (M2 plan PR 10; it
-- becomes the clip's thumbnail through processing, M7), or a video's own thumbnail (Joel,
-- 2026-10-30): readers show it in place of Bunny's generated thumbnail. One image system: it is
-- never set at Bunny. Processing and the media-ready step (PR 13) can never overwrite it: this
-- VALUE keeps workflow to `processing` alone, and media writes never touch `image`. path = its file in the images storage
-- zone; width/height = the real pixel size; alt = the person's short description (NONE: readers
-- show a neutral default).
-- D65/D80 (M2 plan PR 10): the file is server-assigned like a video. Only an upload grant puts
-- one on a story (uploadGrant_attach, on api-user's login: path, size and alt together); the
-- person's session may then change only `alt`, or remove the image (NONE), never add one or
-- change its path or size. story_media_granted refuses a new path without a grant for the story.
-- A2: image.processing is workflow's (the server-side check before approval), so workflow may
-- write `image`, but its VALUE keeps only workflow's `processing` and the stored other fields.
-- Every other writer's `processing` is ignored: it stays as it was while the file (path, size)
-- is unchanged, and goes back to NONE (not processed) when a new file comes. System users ($auth
-- NONE, the migrator, dev-seed) write it as given.
DEFINE FIELD OVERWRITE image         ON story TYPE option<object>
  VALUE IF $auth = NONE { $value }
    ELSE IF $auth = service:workflow {
      IF $before = NONE OR $value = NONE { $before }
      ELSE { object::extend(object::remove($before, 'processing'), { processing: $value.processing }) }
    }
    ELSE IF $value = NONE { NONE }
    ELSE IF $auth = service:api_user {
      object::extend(object::remove($value, 'processing'), {
        processing: IF $before != NONE
          AND [$before.path, $before.width, $before.height] = [$value.path, $value.width, $value.height]
          { $before.processing } ELSE { NONE }
      })
    }
    ELSE IF $before = NONE { NONE }
    ELSE { object::extend($before, { alt: $value.alt }) }
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
-- The path is always the story's own folder's, as api-user names it (fn::media::own_image),
-- whoever writes, so nothing that signs or deletes a story's picture (its owner's link, erasure,
-- housekeeping) can be pointed at another story's file. The one exception is dev-seed's own fixed
-- files, `dev-seed/<name>.webp`, which only a system user can put on (story_media_granted refuses
-- any other writer a new path outside the story's folder); later writes keep them.
DEFINE FIELD OVERWRITE image.path    ON story TYPE string
  ASSERT fn::media::own_image($this.id, $value)
    OR string::matches($value, '^dev-seed/[a-z0-9-]{1,64}[.]webp$')
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.width   ON story TYPE int ASSERT $value > 0
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.height  ON story TYPE int ASSERT $value > 0
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.alt     ON story TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 500
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- A2: NONE = not processed yet (just uploaded or replaced); then 'processing', 'ready' or
-- 'failed'. Only 'ready' can be approved and published (fn::story::approval_problem).
DEFINE FIELD OVERWRITE image.processing ON story TYPE option<string>
  ASSERT $value = NONE OR $value IN ['processing', 'ready', 'failed']
  PERMISSIONS FOR update WHERE $auth != service:api_admin;
-- Media and processing fields (D80, Joel 2026-10-25): never the person's session, never api-admin.
-- Workflow writes them (M7 processing). An upload reaches them only through an upload grant that
-- api-user's own login creates: its event (uploadGrant_attach, elevated) puts the video on the
-- draft. A person's write to them is dropped. Each nested field carries the same rule, so
-- `SET media[0].x = ...` is covered too; story_media_granted refuses a new Bunny id without a
-- grant for that story, whoever writes it (system users aside).
-- 3.2.4 stores undefined keys inside array<object> items (tested), so fn::story::shape_problem
-- allows only the fields defined here ($mediaFields there).
-- A2: media[*].processing is workflow's. For everyone else (the person) the VALUE keeps an item's
-- stored `processing` only while the item is otherwise unchanged; a new or changed item (another
-- upload, a different size) starts again at NONE, and a person's own `processing` is ignored.
-- A person's session gets its stored media back (none on create); api-user's login (only ever
-- through uploadGrant_attach) gets the new item, processing NONE.
DEFINE FIELD OVERWRITE media                    ON story TYPE array<object> DEFAULT []
  VALUE IF $auth = NONE OR $auth = service:workflow { $value }
    ELSE IF $auth != service:api_user { $before ?? [] }
    ELSE {
      $value.map(|$m| object::extend(object::remove($m, 'processing'), {
        processing: ($before ?? []).find(|$b|
          object::remove($b, 'processing') = object::remove($m, 'processing')).processing
      }))
    }
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].format          ON story TYPE string ASSERT $value IN ['video', 'audio']
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].bunnyVideoId    ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].thumbnailPath   ON story TYPE option<string>
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- D53: the real pixel size, replacing the aspectRatio label. A video's is Bunny's encode result.
-- An audio file's is its thumbnail's, the picture shown for it (Joel, 2026-10-24): the person's
-- own image, or the site's default audio thumbnail; never Bunny's audio placeholder.
DEFINE FIELD OVERWRITE media[*].width           ON story TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].height          ON story TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE media[*].durationSeconds ON story TYPE option<int>
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- A2: NONE = not processed yet; then 'processing', 'ready' or 'failed' (set by workflow, M7).
DEFINE FIELD OVERWRITE media[*].processing      ON story TYPE option<string>
  ASSERT $value = NONE OR $value IN ['processing', 'ready', 'failed']
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- M7 adds media[*].rawTranscriptText / transcriptText / captionsUrl / aiSummary, with the same
-- rule (and adds them to $mediaFields in fn::story::shape_problem).
-- Plan 4e: the optional social media sharing consent, per story: NONE until the person ticks
-- the box at the end of the upload (one box naming every platform; it gives the charity copyright
-- permission to share and can't be withdrawn: deleting or withdrawing the story stops future
-- use). Recorded with the submission, by the person's own session, on the latest version, with
-- the database's time (fn::legal::check_pointer, from story_agreements). Gone with the story.
DEFINE FIELD OVERWRITE socialMediaSharingConsent ON story TYPE option<record<socialMediaSharingConsent>>;
DEFINE FIELD OVERWRITE socialMediaSharingConsentAgreedAt ON story TYPE option<datetime>
  VALUE IF $this.socialMediaSharingConsent = NONE { NONE } ELSE IF $value != $before { time::now() } ELSE { $before };
DEFINE FIELD OVERWRITE submittedAt   ON story TYPE option<datetime>   -- set by the server on first submit
  VALUE IF $this.status = 'pending' { $before OR time::now() } ELSE { $before };
DEFINE FIELD OVERWRITE createdAt     ON story TYPE datetime VALUE $before OR time::now() READONLY;
-- The server time on every write. Only a system user ($auth = NONE: the migrator, dev's seed)
-- may keep or supply another: so a migration doesn't make a draft look touched, and tests can
-- age a draft for D71's 6-month expiry (housekeeping).
DEFINE FIELD OVERWRITE updatedAt     ON story TYPE datetime
  VALUE IF $auth = NONE AND $value != NONE { $value } ELSE { time::now() };
-- Moderation fields: only api-admin (D41; not workflow).
DEFINE FIELD OVERWRITE lockedBy      ON story TYPE option<record<user>>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
DEFINE FIELD OVERWRITE lockedAt      ON story TYPE option<datetime>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
DEFINE FIELD OVERWRITE rejectionFeedback ON story TYPE option<string>
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
DEFINE FIELD OVERWRITE approvedAt    ON story TYPE option<datetime>
  PERMISSIONS FOR create, update WHERE $auth = service:api_admin OR $auth = NONE;
-- The content fields as one value, for comparing before/after.
DEFINE FUNCTION OVERWRITE fn::story::content($s: any) {
  RETURN {
    slug: $s.slug, title: $s.title, description: $s.description, body: $s.body,
    bylineName: $s.bylineName, primaryFormat: $s.primaryFormat, themeRefs: $s.themeRefs, media: $s.media,
    image: $s.image
  };
};
-- D53: whether a picture's pixel size is allowed: positive, and no taller than 1:3 or wider
-- than 3:1 (strips, not photos). Cards clamp further, between 9:16 and 2:1 (the readers' job).
DEFINE FUNCTION OVERWRITE fn::shape::allowed($width: any, $height: any) {
  RETURN type::is_int($width) AND type::is_int($height) AND $width > 0 AND $height > 0
    AND $height <= $width * 3 AND $width <= $height * 3;
};
-- The length of a text without the spaces around it, as readers see it. One policy for every
-- length rule: string::trim strips Unicode White_Space (U+0085 too), and JavaScript's trim()
-- also strips U+FEFF, which string::trim keeps (3.2.4, tested). So U+FEFF counts as a space
-- (interior ones too: the length is the same), and nothing invisible pads a text past a minimum
-- or makes an empty one look written. Mirrored by trimmedTextLength in libs/database.
DEFINE FUNCTION OVERWRITE fn::text::trimmed_length($text: option<string>) {
  RETURN string::len(string::trim(string::replace($text ?? '', '\u{FEFF}', ' ')));
};
-- D53: what's wrong with a story's type and shape, or NONE. Three types, each with one main part
-- and one optional part:
--   written: text (body, not blank), no video or audio; optional image
--   video / audio: one media item of that format, optional text; an optional image (M2 plan
--   PR 10): an audio story's picture, or a video's own thumbnail (Joel, 2026-10-30), shown in
--   place of Bunny's generated thumbnail
-- A draft is created before its upload (CreateDraftStory), so video and audio need their media
-- item from submit on (pending, in_review, approved), and may lack it while editable or after
-- (draft, changes_requested, rejected, withdrawn: a draft can be withdrawn before its upload).
-- A written story's minimum length (Joel, 2026-10-23, from the POC; a setting since W3) is
-- checked when it's submitted (story_text_limits), so a short draft can still be saved.
-- Used by the story_shape event.
DEFINE FUNCTION OVERWRITE fn::story::shape_problem($s: any) {
  LET $media = $s.media ?? [];
  LET $mediaFields = ['format', 'bunnyVideoId', 'thumbnailPath', 'width', 'height', 'durationSeconds',
    'processing'];
  IF $media.any(|$m| object::keys($m).any(|$k| $k NOT IN $mediaFields)) {
    RETURN 'a media item has a field the schema doesn’t define (D53: width and height replace aspectRatio)';
  };
  IF $media.any(|$m| ($m.width = NONE) != ($m.height = NONE)) {
    RETURN 'a media item needs both width and height, or neither';
  };
  IF $media.any(|$m| $m.width != NONE AND !fn::shape::allowed($m.width, $m.height)) {
    RETURN 'a video’s or audio thumbnail’s shape is beyond 1:3 or 3:1';
  };
  IF $s.image != NONE AND !fn::shape::allowed($s.image.width, $s.image.height) {
    RETURN 'an image’s shape is beyond 1:3 or 3:1';
  };
  IF $s.primaryFormat = 'written' {
    LET $length = fn::text::trimmed_length($s.body);
    IF $length = 0 { RETURN 'a written story needs its text' };
    IF array::len($media) > 0 { RETURN 'a written story has no video or audio' };
  } ELSE {
    IF array::len($media) > 1 { RETURN 'a ' + $s.primaryFormat + ' story has exactly one media item' };
    IF $media.any(|$m| $m.format != $s.primaryFormat) {
      RETURN 'a ' + $s.primaryFormat + ' story’s media must be ' + $s.primaryFormat;
    };
    IF array::len($media) = 0 AND $s.status IN ['pending', 'in_review', 'approved'] {
      RETURN 'a ' + $s.primaryFormat + ' story needs its ' + $s.primaryFormat + ' before it is submitted';
    };
  };
  RETURN NONE;
};
-- An audio file's thumbnail (Joel, 2026-10-24): exactly the paths api-public-read signs
-- (MediaUrls.thumbnailUrl, bunny-tokens.ts safePath), so a published audio story always has a
-- picture: `<bunnyVideoId>/<file>`, at most 500 characters, each segment only A-Z a-z 0-9 . _ -,
-- no `.` or `..` segment. Both are tested against one table of cases
-- (libs/contracts/src/media-paths.ts; Codex, #79).
DEFINE FUNCTION OVERWRITE fn::media::safe_segment($s: any) {
  RETURN type::is_string($s) AND string::matches($s, '^[A-Za-z0-9._-]+$')
    AND $s NOT IN ['.', '..'];
};
-- A story's own picture's path (M2 plan PR 10, D80): `stories/<that story's id>/<32 hex>.webp`,
-- the only name api-user gives one (uploadGrant_attach checks the same at the grant).
DEFINE FUNCTION OVERWRITE fn::media::own_image($story: any, $path: any) {
  RETURN type::is_record($story) AND type::is_string($path)
    AND string::matches($path, '^stories/[A-Za-z0-9_]{1,64}/[0-9a-f]{32}[.]webp$')
    AND string::starts_with($path, 'stories/' + <string> record::id($story) + '/');
};
DEFINE FUNCTION OVERWRITE fn::media::own_thumbnail($m: any) {
  IF !type::is_string($m.thumbnailPath) OR !type::is_string($m.bunnyVideoId)
    OR string::len($m.thumbnailPath) > 500 { RETURN false };
  LET $parts = string::split($m.thumbnailPath, '/');
  RETURN array::len($parts) = 2 AND $parts[0] = $m.bunnyVideoId
    AND fn::media::safe_segment($parts[0]) AND fn::media::safe_segment($parts[1]);
};
-- A2 (Joel, 2026-10-23): what keeps a story from being approved or published, or NONE. Every
-- upload must be processed by workflow (M7: size, duration, the malware and content checks) and
-- carry the facts processing found: a video its width, height and duration, an audio file its
-- duration and its thumbnail with that picture's width and height (the person's image or the
-- site's default, set by processing; Joel, 2026-10-24), an image (already sized by the person's
-- browser) processing = 'ready'. So nothing
-- unprocessed, or possibly malicious, reaches the public view. Messages start with
-- 'media_not_ready:' so api-admin answers 409 (libs/database isMediaNotReadyError).
DEFINE FUNCTION OVERWRITE fn::story::approval_problem($s: any) {
  LET $media = $s.media ?? [];
  IF $media.any(|$m| $m.processing != 'ready') {
    RETURN 'media_not_ready: the story’s video or audio hasn’t finished processing';
  };
  IF $media.any(|$m| $m.format = 'video' AND !(type::is_int($m.width) AND type::is_int($m.height)
       AND type::is_int($m.durationSeconds) AND $m.durationSeconds > 0)) {
    RETURN 'media_not_ready: a video needs its width, height and duration';
  };
  IF $media.any(|$m| $m.format = 'audio' AND !(type::is_int($m.durationSeconds) AND $m.durationSeconds > 0)) {
    RETURN 'media_not_ready: an audio file needs its duration';
  };
  IF $media.any(|$m| $m.format = 'audio' AND !(fn::media::own_thumbnail($m)
       AND type::is_int($m.width) AND type::is_int($m.height))) {
    RETURN 'media_not_ready: an audio file needs its thumbnail and that picture’s width and height';
  };
  IF $s.image != NONE AND $s.image.processing != 'ready' {
    RETURN 'media_not_ready: the story’s image hasn’t finished processing';
  };
  RETURN NONE;
};
-- D65, D80: a story's video, audio or image is only ever what was uploaded for it. A Bunny id a write
-- adds (one the story didn't have) needs an upload grant naming this story (uploadGrant, made by
-- api-user's login when it created that video at Bunny), whoever writes: workflow, api-user's
-- grant, and a person's write if a permission ever let one through. System users (the migrator,
-- dev-seed's dummy data) load data as given. Thumbnails stay workflow's (M7) and are checked at
-- approval (fn::media::own_thumbnail); the person can't write them (field permissions).
DEFINE EVENT OVERWRITE story_media_granted ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND $auth != NONE
  THEN {
    LET $had = ($before.media ?? []).map(|$m| $m.bunnyVideoId);
    FOR $m IN ($after.media ?? []) {
      IF $m.bunnyVideoId != NONE AND $m.bunnyVideoId NOT IN $had
        AND (SELECT VALUE story FROM ONLY type::record('uploadGrant', <string> $m.bunnyVideoId)) != $after.id {
        THROW 'media_not_granted: a story’s video or audio must be one api-user created for it (D80)';
      };
    };
    -- Its image likewise (M2 plan PR 10): a new path must be in the story's own folder and
    -- granted to it.
    IF $after.image.path != NONE AND $after.image.path != $before.image.path
      AND (!fn::media::own_image($after.id, $after.image.path)
        OR (SELECT VALUE story FROM ONLY type::record('uploadGrant', $after.image.path)) != $after.id) {
      THROW 'media_not_granted: a story’s image must be one api-user picked for it, in its own folder (D80)';
    };
  };
-- Every write, by anyone (system users too): the stored story always has a valid type and shape.
DEFINE EVENT OVERWRITE story_shape ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $problem = fn::story::shape_problem($after);
    IF $problem != NONE { THROW $problem };
  };
-- Once a story leaves draft/changes_requested, its owner can no longer change its content
-- (only withdraw it); what a moderator reviewed is what gets published.
DEFINE EVENT OVERWRITE story_owner_content_lock ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth
   AND $before.status NOT IN ['draft', 'changes_requested']
   AND fn::story::content($before) != fn::story::content($after)
  THEN { THROW 'story content is locked after submission' };
-- The owner may only move their story draft/changes_requested -> pending, or withdraw it.
DEFINE EVENT OVERWRITE story_owner_transitions ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth AND $before.status != $after.status
   AND !(($before.status IN ['draft', 'changes_requested'] AND $after.status = 'pending')
         OR $after.status = 'withdrawn')
  THEN { THROW 'status change not allowed for the story owner' };
-- Plan 4e, Joel 2026-11-01 (Q2): "agree first", in the database. The person's own writes to their
-- story (create, edit, submit; plus the sharing pointer) need the terms of use and the testimony
-- consent at the latest version (fn::legal::require_testimony). Withdrawing (-> withdrawn,
-- content unchanged) and deleting need neither. Other writers (workflow's media processing,
-- api-admin's moderation and theme deletions, system users) aren't the person agreeing: the
-- testimony consent is checked once more when a story is approved (story_approval_testimony).
DEFINE EVENT OVERWRITE story_agreements ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    fn::legal::check_pointer('socialMediaSharingConsent', $after.submitter,
      $before.socialMediaSharingConsent, $after.socialMediaSharingConsent,
      $before.socialMediaSharingConsentAgreedAt, $after.socialMediaSharingConsentAgreedAt, false);
    IF $auth != NONE AND $auth = $after.submitter
       AND !($event = 'UPDATE' AND $after.status = 'withdrawn' AND $before.status != 'withdrawn'
             AND fn::story::content($before) = fn::story::content($after)) {
      fn::legal::require_testimony($after.submitter);
    };
  };
-- D94, D112 (founder, 2026-10-25/28): limits on what a person starts, from the settings an admin
-- adjusts (submissionSettings, below) and the person's own overrides (submitterLimits): open
-- drafts (default 3) and stories submitted for review in any rolling 7 days (default 1). A trusted
-- submitter has neither. Only the person's own writes are limited ($auth = submitter): the
-- migrator and dev-seed load data as themselves. A submission counts from its first submit, kept
-- in submissionLog (D113) for 7 days whatever happens to the story since (withdrawn, rejected,
-- deleted), so withdrawing or deleting and submitting again doesn't get round it; sending a story
-- back after "changes requested" isn't a new one. Messages start with a code so api-user answers
-- 409 with it (libs/database submissionLimitOf). Both checks read the person's other rows; every
-- story write bumps their fence (story_fence), so two overlapping creates or submissions conflict
-- at commit and the retry sees the other.
-- The limits that apply to a person: their override where an admin set one, else the setting.
-- Trusted: no open-drafts, weekly or weekly-upload limit (NONE = unlimited), and the uploads'
-- size and length limits are the hard ceilings (D113's video limits, Joel 2026-10-30: "trusted
-- submitters are exempt, as with the other limits"); the hourly upload limit still applies (an
-- abuse guard, raised per person if needed).
-- Runs with the caller's permissions: a person reads the settings and their own override row.
DEFINE FUNCTION OVERWRITE fn::limits::effective($user: option<record<user>>) {
  LET $set = fn::settings::submission();
  LET $o = IF $user = NONE { NONE } ELSE {
    (SELECT * FROM ONLY type::record('submitterLimits', record::id($user)))
  };
  LET $trusted = $o.trusted = true;
  LET $ceil = fn::settings::upload_ceilings();
  RETURN {
    trusted: $trusted,
    openDraftsMax: IF $trusted { NONE } ELSE { $o.openDraftsMax ?? $set.openDraftsMax },
    submissionsPer7Days: IF $trusted { NONE } ELSE { $o.submissionsPer7Days ?? $set.submissionsPer7Days },
    uploadRequestsPerHour: $o.uploadRequestsPerHour ?? $set.uploadRequestsPerHour,
    uploadsPer7Days: IF $trusted { NONE } ELSE { $o.uploadsPer7Days ?? $set.uploadsPer7Days },
    videoMaxBytes: IF $trusted { $ceil.videoMaxBytes } ELSE { $set.videoMaxBytes },
    audioMaxBytes: IF $trusted { $ceil.audioMaxBytes } ELSE { $set.audioMaxBytes },
    mediaMaxSeconds: IF $trusted { $ceil.mediaMaxSeconds } ELSE { $set.mediaMaxSeconds }
  };
};
-- When the person may next submit a story for review: 7 days after the submission that fills
-- their allowance, or NONE if that's now (or they're unlimited). Their own session reads their
-- own submissionLog.
DEFINE FUNCTION OVERWRITE fn::story::next_submission_at($user: option<record<user>>) {
  IF $user = NONE { RETURN NONE };
  LET $max = fn::limits::effective($user).submissionsPer7Days;
  IF $max = NONE { RETURN NONE };
  LET $times = (SELECT VALUE at FROM submissionLog
    WHERE person = $user AND at > time::now() - 7d ORDER BY at ASC);
  IF array::len($times) < $max { RETURN NONE };
  RETURN $times[array::len($times) - $max] + 7d;
};
DEFINE EVENT OVERWRITE story_limits ON story
  WHEN $after.submitter = $auth
   AND ($event = 'CREATE'
        OR ($event = 'UPDATE' AND $after.status = 'pending' AND $before.status != 'pending'
            AND $before.submittedAt = NONE))
  THEN {
    IF $event = 'CREATE' {
      LET $max = fn::limits::effective($after.submitter).openDraftsMax;
      LET $open = (SELECT VALUE id FROM story
        WHERE submitter = $after.submitter AND status = 'draft' AND id != $after.id);
      IF $max != NONE AND array::len($open) >= $max {
        THROW 'limit_open_drafts: the person has as many open drafts as they may (D94)';
      };
    } ELSE {
      IF fn::story::next_submission_at($after.submitter) != NONE {
        THROW 'limit_weekly_submission: the person has submitted as many stories as they may in 7 days (D94)';
      };
      -- D113: the submission is recorded for 7 days; older entries of theirs go now.
      DELETE submissionLog WHERE person = $after.submitter AND at <= time::now() - 7d;
      CREATE submissionLog CONTENT { person: $after.submitter } RETURN NONE;
    };
  };
-- W3 (Joel, 2026-10-28): the text and theme limits come from the settings an admin adjusts.
-- No grandfathering (Joel, 2026-10-30: "make people stick to new rules even if they had
-- progress under old rule"): every later action meets the limits in force, drafts started under
-- older ones included. Which action checks what, by whoever writes:
--   - a change of text is refused only if it's over the maximum AND makes it longer, so someone
--     over a newly lowered maximum can still trim their draft;
--   - the number of themes is checked only at submission (themes plan v3, 2026-10-31): a draft
--     may hold any number up to the field's hard ceiling;
--   - submitting (entering pending, in_review or approved from an editable status, or created
--     there by a system user) needs the text's minimum and maximum length, from themesMin to
--     themesMax themes, and every theme still there, as they are now. A story already submitted
--     or published is never re-checked (a deleted theme may leave it under the minimum).
-- Hard ceilings stay on the fields (body, themeRefs). Messages start with a code for api-user.
DEFINE EVENT OVERWRITE story_text_limits ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $set = fn::settings::submission();
    LET $len = string::len($after.body ?? '');
    LET $was_len = IF $event = 'CREATE' { 0 } ELSE { string::len($before.body ?? '') };
    IF $len > $set.storyTextMax AND $len > $was_len {
      THROW 'story_text_too_long: the story’s body is longer than the setting allows (W3)';
    };
    IF $after.status IN ['pending', 'in_review', 'approved']
       AND ($event = 'CREATE' OR $before.status NOT IN ['pending', 'in_review', 'approved']) {
      IF $len > $set.storyTextMax {
        THROW 'story_text_too_long: the story’s body is longer than the setting allows (W3)';
      };
      -- Themes (plan v3): checked when the person submits (into pending) only, never again
      -- later (deleting a theme may leave a published story under the minimum).
      IF $after.status = 'pending' {
        LET $themes = $after.themeRefs ?? [];
        IF $themes.any(|$t| !record::exists($t)) {
          THROW 'story_themes_changed: a story’s theme no longer exists';
        };
        IF array::len($themes) < $set.themesMin OR array::len($themes) > $set.themesMax {
          THROW 'story_theme_count: a story needs from ' + <string> $set.themesMin + ' to '
            + <string> $set.themesMax + ' themes when it is submitted';
        };
      };
      IF $after.primaryFormat = 'written' AND fn::text::trimmed_length($after.body) < $set.storyTextMin {
        THROW 'a written story needs at least ' + <string> $set.storyTextMin
          + ' characters before it is submitted';
      };
    };
  };
DEFINE EVENT OVERWRITE story_approval_media ON story          -- A2: whoever approves (system users too)
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status = 'approved' AND $before.status != 'approved'
  THEN {
    LET $problem = fn::story::approval_problem($after);
    IF $problem != NONE { THROW $problem };
  };
-- Joel, 2026-10-23: an approved story stays approved when its media stops being ready ('failed',
-- back to 'processing', a size fact removed): "we need to ... get it loading again instead of
-- approving again". While any item isn't ready the story is hidden: the same write deletes its
-- publicStory row and creates hiddenStory (below). When the same media is ready again (Bunny
-- re-encodes it; workflow or a system user sets processing back to 'ready' with its facts) the
-- same write re-creates the row, with its first publishedAt and its slugHistory, and deletes
-- hiddenStory. No new approval. Only workflow and system users can cause either: the person's
-- content is locked after submission and api-admin can't write media. If the media differs from the row that was hidden (another
-- bunnyVideoId or image path, or a thumbnail that isn't a frame Bunny generated, D60), it stays
-- hidden: a moderator must review it (fn::story::hidden_by_media lists it with mediaChanged).
-- A public story whose media changes that way is hidden too (reason media_changed; D59: changed
-- after going public needs approving again). Only a story that was public is hidden and
-- restored. The event never writes the story itself, so the command's own write is
-- the story's only version step (D29) and returns the committed version.
-- Which media is shown: formats, Bunny ids and the image's path. Works on a story or a
-- publicStory row. The hide stores the identity of the row it deletes (what a moderator
-- approved), never the story's: workflow may have swapped the media in that write.
-- Thumbnails are compared on their own (fn::story::shows_reviewed_media), not hashed here.
DEFINE FUNCTION OVERWRITE fn::story::media_identity($s: any) {
  RETURN crypto::sha256(<string> {
    media: ($s.media ?? []).map(|$m| [$m.format, $m.bunnyVideoId]),
    image: $s.image.path
  });
};
-- D60 (Joel, 2026-10-23): re-encoding a video on Bunny can give it another thumbnail. A frame
-- Bunny generated from the reviewed video is still reviewed media. Bunny's generated frames are
-- thumbnail_1.jpg to thumbnail_5.jpg in the video's folder (Stream docs: storage structure, set
-- thumbnail). A custom upload is stored in the same folder, and the selected-thumbnail file
-- (thumbnail.jpg) isn't proof of a generated frame, so no other name counts (Codex, #67).
DEFINE FUNCTION OVERWRITE fn::media::generated_thumbnail($m: any) {
  RETURN type::is_string($m.bunnyVideoId) AND type::is_string($m.thumbnailPath)
    AND $m.thumbnailPath IN ['1', '2', '3', '4', '5'].map(|$n|
      $m.bunnyVideoId + '/thumbnail_' + $n + '.jpg');
};
-- Whether a story's media is still what was reviewed: the same identity (formats, Bunny ids,
-- image path), and each thumbnail either the reviewed one or a frame Bunny generated for that
-- video. $thumbnails: the reviewed row's thumbnail paths, in media order.
DEFINE FUNCTION OVERWRITE fn::story::shows_reviewed_media($identity: string, $thumbnails: any, $s: any) {
  LET $media = $s.media ?? [];
  RETURN $identity = fn::story::media_identity($s)
    AND type::is_array($thumbnails) AND array::len($thumbnails) = array::len($media)
    AND array::all($media.map(|$m, $i|
      $m.thumbnailPath = $thumbnails[$i] OR fn::media::generated_thumbnail($m)));
};
DEFINE FUNCTION OVERWRITE fn::story::thumbnails($s: any) {
  RETURN ($s.media ?? []).map(|$m| $m.thumbnailPath);
};
-- Hides a public story (Joel, 2026-10-23): deletes its publicStory row and keeps what
-- re-publishing needs in hiddenStory, in the caller's transaction.
-- $reason: media_unavailable or media_changed. Called by events only (they run elevated).
-- Nothing to do if the story isn't public.
DEFINE FUNCTION OVERWRITE fn::story::hide($story: record<story>, $reason: string) {
  LET $public = type::record('publicStory', record::id($story));
  LET $hidden = type::record('hiddenStory', record::id($story));
  LET $row = (SELECT * FROM ONLY $public);
  IF $row = NONE { RETURN NONE };
  DELETE $public;
  DELETE $hidden;
  CREATE $hidden CONTENT {
    publishedAt: $row.publishedAt, slugHistory: $row.slugHistory,
    identity: fn::story::media_identity($row), thumbnails: fn::story::thumbnails($row)
  } RETURN NONE;
};
-- Brings a hidden story back once nothing keeps it hidden: still approved, its media ready and
-- still what was reviewed, and its uploader has the testimony consent (plan 4e). The same write
-- re-creates the publicStory row with its first publishedAt and its slugHistory, and deletes
-- hiddenStory; no new approval. $reason: media_restored. Returns whether it did. Called by
-- events only.
DEFINE FUNCTION OVERWRITE fn::story::restore($story: record<story>, $reason: string) {
  LET $public = type::record('publicStory', record::id($story));
  LET $hidden = type::record('hiddenStory', record::id($story));
  LET $h = (SELECT * FROM ONLY $hidden);
  LET $s = (SELECT * FROM ONLY $story);
  IF $h = NONE OR $s = NONE OR $s.status != 'approved' OR record::exists($public)
    OR fn::story::approval_problem($s) != NONE
    OR !fn::story::shows_reviewed_media($h.identity, $h.thumbnails, $s)
    OR $s.submitter.testimonyConsent = NONE {
    RETURN false;
  };
  DELETE $hidden;
  CREATE $public CONTENT {
    version: $s.version, slug: $s.slug, slugHistory: $h.slugHistory,
    title: $s.title, description: $s.description, body: $s.body,
    bylineName: $s.bylineName, primaryFormat: $s.primaryFormat,
    themeRefs: $s.themeRefs, publishedAt: $h.publishedAt,
    image: IF $s.image != NONE { { path: $s.image.path, width: $s.image.width,
      height: $s.image.height, alt: $s.image.alt } },
    media: $s.media.map(|$m| { format: $m.format, bunnyVideoId: $m.bunnyVideoId,
      thumbnailPath: $m.thumbnailPath, width: $m.width, height: $m.height })
  } RETURN NONE;
  RETURN true;
};
DEFINE EVENT OVERWRITE story_media_availability ON story
  WHEN $event = 'UPDATE' AND $before.status = 'approved'
  THEN {
    LET $public = type::record('publicStory', record::id($after.id));
    LET $hidden = type::record('hiddenStory', record::id($after.id));
    IF $after.status != 'approved' {
      -- Left approved (withdrawn): nothing is hidden any more.
      DELETE $hidden;
    } ELSE IF record::exists($public) AND (fn::story::approval_problem($after) != NONE
      OR !fn::story::shows_reviewed_media(fn::story::media_identity($public),
        fn::story::thumbnails($public), $after)) {
      -- Only what is public gets hidden (and so restored): a story that wasn't public is
      -- never published by a media fix. A marker left from an earlier hide never
      -- stops this one (Codex, #61): it is replaced by what is public now.
      fn::story::hide($after.id, IF fn::story::approval_problem($after) != NONE
        { 'media_unavailable' } ELSE { 'media_changed' });
    } ELSE IF record::exists($hidden) {
      fn::story::restore($after.id, 'media_restored');
    };
  };
-- Plan 4e: publishing needs the submitter's testimony consent (any version: it covers every
-- story they submit; a newer version only gates new stories), whoever approves (system users
-- too). It can't have gone since submission (only erasure clears it, and erasure deletes the
-- story); this is defence in depth, as publicStory_mirrors_story's.
DEFINE EVENT OVERWRITE story_approval_testimony ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.status = 'approved' AND $before.status != 'approved'
   AND $after.submitter.testimonyConsent = NONE
  THEN { THROW 'testimony_consent_required: approving a story needs its submitter’s testimony consent (plan 4e)' };
-- Erasure: api-user's login may delete stories but can't read them, so it can't find their
-- read-model rows or reviews (both are reached through story.submitter). Deleting a story
-- removes them in the same transaction, whoever deletes it.
DEFINE EVENT OVERWRITE story_fence ON story                       -- create, edit, submit, approve, delete
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.submitter) }   -- erasure: no live check
    ELSE { fn::person::live($after.submitter) };
  };
-- A story write that adds themes writes each one's fence (fence:theme-<id>), so it conflicts
-- with that theme's deletion if the two overlap. A link to a theme already gone needs none (the
-- submission refuses it).
DEFINE EVENT OVERWRITE story_theme_fence ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    FOR $t IN array::complement($after.themeRefs ?? [], $before.themeRefs ?? []) {
      IF record::exists($t) { fn::fence::touch('theme', $t) };
    };
  };
DEFINE EVENT OVERWRITE story_erasure_cascade ON story
  WHEN $event = 'DELETE'
  THEN {
    DELETE type::record('publicStory', record::id($before.id));
    DELETE type::record('hiddenStory', record::id($before.id));
    DELETE moderationReview WHERE story = $before.id;
    DELETE favourite WHERE story = $before.id;                  -- others' hearts on it
  };
-- Every deleted story's picture folder in the images zone (M2 plan PR 10, D82, D40), whoever
-- deletes it (its owner, erasure, housekeeping's expired drafts, dev-seed): every picture of a
-- story lives in `stories/<its id>/`, so the folder is queued from the story row itself, never
-- from its upload grants (a grant that is no longer the story's picture is pruned after 7 days,
-- Codex #140 r4). One queue row per folder (its key is the story's id), with its final pass
-- (fn::erasure::final_pass_after): a PUT link signed just before the delete stays valid for
-- 10 minutes, so the row isn't done until a delete after that (pendingDeletion FOR delete).
-- A story without pictures costs one delete that answers 404.
-- A repeat delete of the same id (Codex #140 round 6) moves the final pass to the later of the
-- two and makes the row due now, so a link signed for the newer story is covered too.
-- An id is never reused while its folder is still queued: the outstanding row would delete the
-- new story's pictures, and an old final pass could let the row go before a new link expires.
-- Ordinary stories get fresh ULIDs, so only a system user ($auth = NONE: the migrator, dev's
-- seed, which resets with the same ids) may recreate one. That is safe: dev-seed's pictures live
-- under `dev-seed/`, never `stories/<id>/`, and any real upload to a recreated story makes its
-- next delete refresh the final pass, as above.
DEFINE EVENT OVERWRITE story_picture_folder ON story
  WHEN $event IN ['CREATE', 'DELETE']
  THEN {
    LET $id = IF $event = 'CREATE' { $after.id } ELSE { $before.id };
    LET $row = type::record('pendingDeletion', fn::erasure::folder_key($id));
    IF $event = 'CREATE' {
      IF $auth != NONE AND record::exists($row) {
        THROW 'this story id’s picture folder is still being deleted';
      };
    } ELSE IF record::exists($row) {
      LET $later = time::now() + fn::erasure::final_pass_after();
      UPDATE $row SET finalPassAt = IF finalPassAt > $later { finalPassAt } ELSE { $later },
        nextAttemptAt = time::now() RETURN NONE;
    } ELSE {
      CREATE $row CONTENT { kind: 'image',
        ref: 'stories/' + <string> record::id($id) + '/',
        finalPassAt: time::now() + fn::erasure::final_pass_after() } RETURN NONE;
    };
  };
DEFINE INDEX OVERWRITE story_slug      ON story FIELDS slug UNIQUE;
DEFINE INDEX OVERWRITE story_queue     ON story FIELDS status, submittedAt;
DEFINE INDEX OVERWRITE story_submitter ON story FIELDS submitter, createdAt;

-- ---------------------------------------------------------------- publicStory (read model, D25/D26)
-- Approved stories only, written in the same transaction as the command that changes them.
-- Same id as the story (publicStory:<ulid>). No submitter, consent, raw transcript,
-- moderation or quality data. An Art 9 location: erasure deletes it in the same transaction.
DEFINE TABLE OVERWRITE publicStory SCHEMAFULL PERMISSIONS
  FOR select FULL,                                                      -- api-public-read and everyone
  FOR create, update WHERE $auth.id = service:api_admin,                -- approve, edit
  FOR delete WHERE $auth.id IN [service:api_user, service:api_admin]    -- erasure
    OR (type::record('story', record::id(id)).submitter = $auth.id      -- owner withdraws
        AND $auth.status != 'deleted');
DEFINE FIELD OVERWRITE version       ON publicStory TYPE int;           -- mirrors story.version (ETag)
DEFINE FIELD OVERWRITE slug          ON publicStory TYPE string;
DEFINE FIELD OVERWRITE slugHistory   ON publicStory TYPE array<string> DEFAULT [];  -- D30: old slugs -> 301
DEFINE FIELD OVERWRITE title         ON publicStory TYPE string;
DEFINE FIELD OVERWRITE description   ON publicStory TYPE string;
DEFINE FIELD OVERWRITE body          ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE bylineName    ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE primaryFormat ON publicStory TYPE string;
DEFINE FIELD OVERWRITE themeRefs     ON publicStory TYPE array<record<theme>> DEFAULT [];
DEFINE FIELD OVERWRITE media         ON publicStory TYPE array<object>;  -- playback fields only
DEFINE FIELD OVERWRITE media[*].format        ON publicStory TYPE string;
DEFINE FIELD OVERWRITE media[*].bunnyVideoId  ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE media[*].thumbnailPath ON publicStory TYPE option<string>;
DEFINE FIELD OVERWRITE media[*].width         ON publicStory TYPE option<int>;
DEFINE FIELD OVERWRITE media[*].height        ON publicStory TYPE option<int>;
DEFINE FIELD OVERWRITE image                  ON publicStory TYPE option<object>;   -- D53
DEFINE FIELD OVERWRITE image.path             ON publicStory TYPE string;
DEFINE FIELD OVERWRITE image.width            ON publicStory TYPE int;
DEFINE FIELD OVERWRITE image.height           ON publicStory TYPE int;
DEFINE FIELD OVERWRITE image.alt              ON publicStory TYPE option<string>;
-- Cards show a clip's length (M1 step 6a). Computed from the story on every write, so no
-- publisher copies it and none can change it. The approval gate (A2) means a published video or
-- audio story always has it; NONE for written stories.
DEFINE FIELD OVERWRITE durationSeconds ON publicStory TYPE option<int>
  VALUE type::record('story', record::id(id)).media[0].durationSeconds;
-- The themes' ids as text, computed on every write (no writer sets them), for ?theme= and for
-- whether a published story uses a theme (D63: /v1/themes lists a theme that isn't highlighted
-- only then). 3.2.4 returns no rows from an element index over record links (`themeRefs.*`),
-- but indexes strings correctly (see the gotchas).
DEFINE FIELD OVERWRITE themeIds      ON publicStory TYPE array<string>
  VALUE (themeRefs ?? []).map(|$t| record::id($t));
DEFINE FIELD OVERWRITE publishedAt   ON publicStory TYPE datetime;
DEFINE FIELD OVERWRITE updatedAt     ON publicStory TYPE datetime VALUE time::now();
-- A full-text index covers one field, so search goes over a computed field.
DEFINE FIELD OVERWRITE searchText    ON publicStory TYPE string
  VALUE string::join(' ', title, description, body ?? '');
-- D41 + plan 4e: the read model can only publish what the person wrote, for an approved story whose
-- submitter has the testimony consent (checked when the row is created: it can't go while the
-- story exists). Otherwise api-admin (which writes this table) could publish text the person
-- never wrote.
DEFINE EVENT OVERWRITE publicStory_fence ON publicStory           -- publish, re-sync, unpublish
  WHEN true THEN {
    IF $event = 'DELETE' {
      fn::fence::touch('person', type::record('story', record::id($before.id)).submitter);
    } ELSE {
      fn::person::live(type::record('story', record::id($after.id)).submitter);
    };
  };
DEFINE EVENT OVERWRITE publicStory_mirrors_story ON publicStory
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $s = (SELECT * FROM ONLY type::record('story', record::id($after.id)));
    IF $s = NONE OR $s.status != 'approved' {
      THROW 'publicStory needs an approved story with the same id';
    };
    -- A2, defence in depth: never publish unprocessed media, even for a story approved earlier.
    LET $unready = fn::story::approval_problem($s);
    IF $unready != NONE { THROW $unready };
    IF [$after.slug, $after.title, $after.description, $after.body, $after.bylineName,
        $after.primaryFormat, $after.themeRefs]
       != [$s.slug, $s.title, $s.description, $s.body, $s.bylineName, $s.primaryFormat, $s.themeRefs]
       OR $after.media.map(|$m| [$m.format, $m.bunnyVideoId, $m.thumbnailPath, $m.width, $m.height])
       != $s.media.map(|$m| [$m.format, $m.bunnyVideoId, $m.thumbnailPath, $m.width, $m.height])
       -- array<object> items take undefined keys (3.2.4): playback fields only, nothing else
       OR $after.media.any(|$m| object::keys($m).any(|$k|
            $k NOT IN ['format', 'bunnyVideoId', 'thumbnailPath', 'width', 'height']))
       OR [$after.image.path, $after.image.width, $after.image.height, $after.image.alt]
       != [$s.image.path, $s.image.width, $s.image.height, $s.image.alt] {
      THROW 'publicStory must mirror the approved story’s content';
    };
    IF $event = 'CREATE' AND $s.submitter.testimonyConsent = NONE {
      THROW 'testimony_consent_required: publishing needs the submitter’s testimony consent (plan 4e)';
    };
  };
-- Any publication (ApproveStory, a moderator's re-publish, or the media restore) ends a media
-- hide: the row now shows what was reviewed, so a later failure hides it afresh (Codex, #61:
-- a stale marker for replaced media blocked the next hide).
DEFINE EVENT OVERWRITE publicStory_clears_hide ON publicStory
  WHEN $event = 'CREATE'
  THEN { DELETE type::record('hiddenStory', record::id($after.id)) };
-- Processing (workflow, M7) may correct a published clip's size or duration, and a re-encode may
-- give it another frame Bunny generated as its thumbnail (D60). The same write copies them into
-- the published row (durationSeconds is recomputed there), so cards never keep old facts or a
-- dead thumbnail link. Only while the clip is ready and the story's media is still what was
-- reviewed (fn::story::shows_reviewed_media against the published row). Anything else (another
-- clip or image, a custom thumbnail) is never copied: story_media_availability hides the story
-- in the same write, for a moderator to review.
DEFINE EVENT OVERWRITE story_published_media_facts ON story
  WHEN $event = 'UPDATE' AND $after.status = 'approved'
    AND $after.media.map(|$m| [$m.width, $m.height, $m.durationSeconds, $m.thumbnailPath])
      != $before.media.map(|$m| [$m.width, $m.height, $m.durationSeconds, $m.thumbnailPath])
    AND fn::story::approval_problem($after) = NONE
  THEN {
    LET $public = type::record('publicStory', record::id($after.id));
    LET $row = (SELECT media, image FROM ONLY $public);
    IF $row != NONE AND fn::story::shows_reviewed_media(fn::story::media_identity($row),
      fn::story::thumbnails($row), $after) {
      UPDATE $public SET media = $row.media.map(|$m, $i| object::extend($m, {
        width: $after.media[$i].width, height: $after.media[$i].height,
        thumbnailPath: $after.media[$i].thumbnailPath })) RETURN NONE;
    };
  };
DEFINE ANALYZER OVERWRITE story_en TOKENIZERS blank, class FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX OVERWRITE publicStory_slug     ON publicStory FIELDS slug UNIQUE;
-- An element index (`slugHistory.*`): the old-slug lookup's `CONTAINS` uses it; a plain index over
-- the array is never used (EXPLAIN on 3.2.4, 2026-11-05: a table scan).
DEFINE INDEX OVERWRITE publicStory_slughist ON publicStory FIELDS slugHistory.*;
DEFINE INDEX OVERWRITE publicStory_browse   ON publicStory FIELDS publishedAt;
DEFINE INDEX OVERWRITE publicStory_theme_ids ON publicStory FIELDS themeIds.*;  -- D63
DEFINE INDEX OVERWRITE publicStory_fts      ON publicStory FIELDS searchText
  FULLTEXT ANALYZER story_en BM25 HIGHLIGHTS;                -- 3.x syntax (was SEARCH ANALYZER)

-- ---------------------------------------------------------------- hiddenStory (Joel, 2026-10-23)
-- An approved story hidden because its media isn't ready or changed (story_media_availability).
-- It comes back on its own once its media is ready again (fn::story::restore). Same id as the story
-- (hiddenStory:<ulid>). Keeps what re-publishing needs: the deleted row's publishedAt and
-- slugHistory, and the identity of its media. A table of its own, not a story field, so
-- hiding and restoring add no story write (D29: one version step per command). Written by the
-- event only (events run elevated); erasure deletes it with the story.
DEFINE TABLE OVERWRITE hiddenStory SCHEMAFULL PERMISSIONS
  FOR select WHERE $auth.id IN [service:api_admin, service:workflow],
  FOR create, update, delete NONE;
DEFINE FIELD OVERWRITE since       ON hiddenStory TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE publishedAt ON hiddenStory TYPE datetime;
DEFINE FIELD OVERWRITE slugHistory ON hiddenStory TYPE array<string>;
DEFINE FIELD OVERWRITE identity    ON hiddenStory TYPE string ASSERT string::len($value) = 64;
-- D60: the hidden row's thumbnail paths, in media order (rows from before D60 have none, so
-- they stay hidden for a moderator).
DEFINE FIELD OVERWRITE thumbnails  ON hiddenStory TYPE option<array<option<string>>>;
DEFINE INDEX OVERWRITE hiddenStory_since ON hiddenStory FIELDS since;
DEFINE EVENT OVERWRITE hiddenStory_fence ON hiddenStory          -- hide, restore
  WHEN true THEN {
    IF $event = 'DELETE' {
      fn::fence::touch('person', type::record('story', record::id($before.id)).submitter);
    } ELSE {
      fn::person::live(type::record('story', record::id($after.id)).submitter);
    };
  };
-- For api-admin (someone chases Bunny): approved stories hidden because of their media, oldest
-- first. problem = what's still not ready; mediaChanged = the media differs from what was
-- public, so it needs a moderator rather than Bunny. A story whose media is fine but still hidden
-- (its uploader has no testimony consent: only rows from before plan 4e) isn't listed. Runs with
-- the caller's permissions (only
-- api-admin and workflow read hiddenStory).
DEFINE FUNCTION OVERWRITE fn::story::hidden_by_media() {
  LET $hidden = (SELECT since, identity, thumbnails, type::record('story', record::id(id)) AS story
    FROM hiddenStory ORDER BY since ASC);
  RETURN $hidden.map(|$h| {
    LET $s = (SELECT * FROM ONLY $h.story);
    RETURN IF $s.status = 'approved' {
      { id: $s.id, slug: $s.slug, title: $s.title, primaryFormat: $s.primaryFormat,
        hiddenSince: $h.since, problem: fn::story::approval_problem($s),
        mediaChanged: !fn::story::shows_reviewed_media($h.identity, $h.thumbnails, $s) }
    };
  }).filter(|$r| $r != NONE AND ($r.problem != NONE OR $r.mediaChanged));
};

-- ---------------------------------------------------------------- draft retention (D71)
-- D71: an untouched draft is deleted after 6 months (186 days: a month counted as 31 days). It was
-- the testimony form's draftRetentionMonths; plan 4e's version tables hold only the text, so the
-- period lives here, unchanged.
DEFINE FUNCTION OVERWRITE fn::story::draft_retention() {
  RETURN 186d;
};
-- D71: a draft last touched before this has expired, and housekeeping deletes it (story FOR
-- delete).
DEFINE FUNCTION OVERWRITE fn::story::drafts_expire_before() {
  RETURN time::now() - fn::story::draft_retention();
};
-- D71: when `$story` expires if nobody touches it again: fn::story::draft_retention() after its
-- last activity, the later of its last edit (updatedAt) and the last time an upload link was
-- signed for it again (uploadGrant.renewedAt, a resume). NONE if it isn't a draft. The one rule:
-- housekeeping deletes by it (draft_expired) and the profile shows it (api-user's
-- StoryMine.draftExpiresAt, R5). The owner's session reads its own grants.
DEFINE FUNCTION OVERWRITE fn::story::draft_expires_at($story: record<story>) {
  LET $s = (SELECT status, updatedAt FROM ONLY $story);
  IF $s = NONE OR $s.status != 'draft' { RETURN NONE };
  LET $renewed = array::max(SELECT VALUE renewedAt FROM uploadGrant
    WHERE story = $story AND renewedAt != NONE);
  LET $last = IF $renewed != NONE AND $renewed > $s.updatedAt { $renewed } ELSE { $s.updatedAt };
  RETURN $last + fn::story::draft_retention();
};
-- D71: whether `$story` is a draft past fn::story::draft_expires_at, i.e. nobody has touched it
-- since fn::story::drafts_expire_before(). story FOR delete (housekeeping) and the chore both
-- ask this. Both writes fence the person (story_fence, uploadGrant_renew), so a resume racing
-- the delete conflicts and one of them loses.
DEFINE FUNCTION OVERWRITE fn::story::draft_expired($story: record<story>) {
  LET $at = fn::story::draft_expires_at($story);
  RETURN $at != NONE AND $at < time::now();
};

-- ---------------------------------------------------------------- moderationReview (M3)
-- The story's owner reads the outcomes on their own story ("Download my data", Art 15; M2 plan
-- PR 12), never who decided: `moderator` is api-admin's alone.
DEFINE TABLE OVERWRITE moderationReview SCHEMAFULL PERMISSIONS
  FOR select WHERE $auth.id = service:api_admin OR story.submitter = $auth.id,
  FOR create WHERE $auth.id = service:api_admin,
  FOR update NONE,
  FOR delete WHERE $auth.id = service:api_user;                        -- erasure
DEFINE FIELD OVERWRITE story       ON moderationReview TYPE record<story>;
DEFINE FIELD OVERWRITE moderator   ON moderationReview TYPE record<user>
  PERMISSIONS FOR select WHERE $auth.id = service:api_admin;
DEFINE FIELD OVERWRITE decision    ON moderationReview TYPE string
  ASSERT $value IN ['approve', 'reject', 'request_changes', 'escalate'];  -- one per command (D28)
DEFINE FIELD OVERWRITE feedbackToSubmitter ON moderationReview TYPE option<string>;
DEFINE FIELD OVERWRITE storyVersion ON moderationReview TYPE int;      -- the version reviewed (D29)
DEFINE FIELD OVERWRITE decidedAt   ON moderationReview TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE INDEX OVERWRITE review_story ON moderationReview FIELDS story, decidedAt;
-- Review round 3: a review must belong to an existing story of a live person, and bumps that
-- person's fence, so a review racing erasure can't outlive it (the cascade deletes the rest).
DEFINE EVENT OVERWRITE review_live_story ON moderationReview
  WHEN true
  THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.story.submitter) }   -- NONE in the erasure cascade
    ELSE {
      IF !record::exists($after.story) { THROW 'a moderation review needs an existing story' };
      fn::person::live($after.story.submitter);
    };
  };
DEFINE EVENT OVERWRITE review_append_only ON moderationReview
  WHEN $event = 'UPDATE' THEN { THROW 'moderation reviews are append-only' };  -- DELETE allowed for erasure

-- ---------------------------------------------------------------- uploadGrant (D65, D80, D113)
-- One row per video or audio file api-user created at Bunny Stream for a story (RequestUpload,
-- M2 plan PR 7). id = uploadGrant:<bunnyVideoId>, so a Bunny video is granted once, to one story.
-- Only api-user's own login creates it, after creating the video itself (title = the story id,
-- D69); its event checks the draft and the person's upload limits and puts the video on the draft
-- in the same write (D80: the browser never names a video, and a person's session never writes
-- media). story_media_granted then refuses any Bunny id without a grant for that story.
-- Also the per-person record of uploads (D113, Joel 2026-10-28: the limits must hold when stories
-- or videos are deleted): replacing a draft's file deletes the old video at Bunny but keeps its
-- grant, so the hourly and weekly counts stay honest. A grant that's no longer its story's media
-- goes after 7 days (pruned here); a story's current one stays while the story does. Person-linked:
-- erasure deletes them all. The person reads their own (the limits page, the submit checks).
-- storyVersion: the `If-Match` the command was given: the event refuses another (412).
-- sizeBytes / durationSeconds: what the browser declared (the TUS link binds neither, D68); the
-- limits are checked on them here and again at submit, with Bunny's own length once it has one.
-- housekeeping reads them (ids and dates) so a video with a recent grant is never an orphan.
-- renewedAt: when api-user last signed a link for it again (a resume, or a replayed request;
-- fn::upload::renew), the only thing anyone may change. It counts as touching the draft (D71).
-- Images (M2 plan PR 10): id = uploadGrant:`stories/<story id>/<random>.webp`, the file's path in
-- the images storage zone, which api-user picks (D80); the presigned PUT it signs binds that path,
-- the type and the exact size (D68). width/height/alt: the picture's real size (D53, 1:3..3:1) and
-- its description, put on the story with it. Images count towards the hourly upload limit only,
-- never the weekly one (Joel, 2026-10-30: uploadsPer7Days is for video and audio files); their
-- size and pixel bounds are fixed (fn::upload::image_limits).
-- expectedImage: the path of the picture the person's page showed when they chose theirs (NONE:
-- none). The event refuses the grant (image_changed) if the story's picture is another one by
-- then, whatever its version: a picture another tab put on (or took off) is replaced only when
-- the person chooses to, never by a request the page rebased onto a newer version (Codex #140 r3).
DEFINE TABLE OVERWRITE uploadGrant SCHEMAFULL PERMISSIONS
  FOR select WHERE person = $auth.id
    OR $auth.id IN [service:api_user, service:api_admin, service:housekeeping],
  FOR create WHERE $auth.id = service:api_user,
  FOR update WHERE $auth.id = service:api_user,
  FOR delete WHERE $auth.id = service:api_user;                        -- erasure
DEFINE FIELD OVERWRITE story           ON uploadGrant TYPE record<story> READONLY;
DEFINE FIELD OVERWRITE person          ON uploadGrant TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE format          ON uploadGrant TYPE string READONLY
  ASSERT $value IN ['video', 'audio', 'image'];
DEFINE FIELD OVERWRITE contentType     ON uploadGrant TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 100;
DEFINE FIELD OVERWRITE sizeBytes       ON uploadGrant TYPE int READONLY ASSERT $value > 0;
DEFINE FIELD OVERWRITE durationSeconds ON uploadGrant TYPE option<int> READONLY
  ASSERT $value = NONE OR $value > 0;
DEFINE FIELD OVERWRITE width           ON uploadGrant TYPE option<int> READONLY;   -- images
DEFINE FIELD OVERWRITE height          ON uploadGrant TYPE option<int> READONLY;
DEFINE FIELD OVERWRITE alt             ON uploadGrant TYPE option<string> READONLY
  ASSERT $value = NONE OR string::len($value) <= 500;
DEFINE FIELD OVERWRITE expectedImage   ON uploadGrant TYPE option<string> READONLY;   -- images
DEFINE FIELD OVERWRITE storyVersion    ON uploadGrant TYPE int READONLY;
DEFINE FIELD OVERWRITE at              ON uploadGrant TYPE datetime VALUE $before OR time::now() READONLY;
DEFINE FIELD OVERWRITE renewedAt       ON uploadGrant TYPE option<datetime>   -- server time only
  VALUE IF $value = NONE OR $value = $before { $before } ELSE { time::now() };
DEFINE INDEX OVERWRITE uploadGrant_person ON uploadGrant FIELDS person, at;
DEFINE INDEX OVERWRITE uploadGrant_story  ON uploadGrant FIELDS story;
-- When the person may next start an upload of `$format` ('video', 'audio' or 'image'): NONE if
-- now, else when the hourly count (every grant) or, for a video or audio file, the weekly count
-- (video and audio grants only) frees a place (the later of the two). Their own session reads
-- their own grants.
DEFINE FUNCTION OVERWRITE fn::upload::next_allowed_at($user: option<record<user>>, $format: string) {
  IF $user = NONE { RETURN NONE };
  LET $l = fn::limits::effective($user);
  LET $grants = (SELECT at, format FROM uploadGrant
    WHERE person = $user AND at > time::now() - 7d ORDER BY at ASC);
  LET $hour = $grants.filter(|$g| $g.at > time::now() - 1h).map(|$g| $g.at);
  LET $week = $grants.filter(|$g| $g.format != 'image').map(|$g| $g.at);
  LET $byHour = IF array::len($hour) < $l.uploadRequestsPerHour { NONE }
    ELSE { $hour[array::len($hour) - $l.uploadRequestsPerHour] + 1h };
  LET $byWeek = IF $format = 'image' OR $l.uploadsPer7Days = NONE
    OR array::len($week) < $l.uploadsPer7Days { NONE }
    ELSE { $week[array::len($week) - $l.uploadsPer7Days] + 7d };
  RETURN IF $byHour = NONE { $byWeek } ELSE IF $byWeek = NONE { $byHour }
    ELSE IF $byHour > $byWeek { $byHour } ELSE { $byWeek };
};
-- An image's fixed bounds (M2 plan PR 10): the browser re-encodes it to WebP at most 2048 px on its
-- longer side, so these only stop what no browser of ours sends. Mirrored in api-user (uploads.ts).
DEFINE FUNCTION OVERWRITE fn::upload::image_limits() {
  RETURN { maxBytes: 5242880, minSide: 200, maxSide: 4096 };
};
DEFINE EVENT OVERWRITE uploadGrant_attach ON uploadGrant
  WHEN $event IN ['CREATE', 'DELETE'] THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.person) }
    ELSE {
      fn::person::live($after.person);
      LET $s = (SELECT * FROM ONLY $after.story);
      IF $s = NONE OR $s.submitter != $after.person {
        THROW 'upload_refused: the story isn’t this person’s';
      };
      IF $s.version != $after.storyVersion { THROW 'story_cmd:stale_version' };
      IF $s.status NOT IN ['draft', 'changes_requested'] { THROW 'story_cmd:locked' };
      -- Plan 4e (Q2): an upload is the person's write, made for them by api-user's login: the
      -- latest terms of use and testimony consent first.
      fn::legal::require_testimony($after.person);
      LET $l = fn::limits::effective($after.person);
      IF $after.format = 'image' {
        -- A written story's image, an audio story's picture or a video's own thumbnail, in the
        -- story's own folder, named by api-user (a 32-hex random name), a WebP of a size and
        -- shape we take (D53).
        LET $path = record::id($after.id);
        LET $name = string::replace($path, 'stories/' + record::id($s.id) + '/', '');
        IF !string::starts_with($path, 'stories/' + record::id($s.id) + '/')
          OR string::len($name) != 37 OR !string::ends_with($name, '.webp')
          OR !string::is_hexadecimal(string::slice($name, 0, 32)) {
          THROW 'upload_refused: an image goes in its story’s own folder, under a name api-user picks';
        };
        IF $after.contentType != 'image/webp' { THROW 'upload_refused: an image is a WebP' };
        IF $s.image.path != $after.expectedImage {
          THROW 'image_changed: the story’s picture isn’t the one the person was shown';
        };
        LET $il = fn::upload::image_limits();
        IF $after.sizeBytes > $il.maxBytes {
          THROW 'limit_upload_size: the image is bigger than we take (M2 plan PR 10)';
        };
        IF $after.width = NONE OR $after.height = NONE
          OR $after.width < $il.minSide OR $after.height < $il.minSide
          OR $after.width > $il.maxSide OR $after.height > $il.maxSide
          OR !fn::shape::allowed($after.width, $after.height) {
          THROW 'upload_refused: an image’s pixel size or shape is outside what we take (D53)';
        };
      } ELSE {
        IF $s.primaryFormat != $after.format {
          THROW 'upload_refused: a ' + $s.primaryFormat + ' story takes no ' + $after.format;
        };
        IF $after.sizeBytes > (IF $after.format = 'video' { $l.videoMaxBytes } ELSE { $l.audioMaxBytes }) {
          THROW 'limit_upload_size: the file is bigger than the person may upload (D113)';
        };
        IF $after.durationSeconds != NONE AND $after.durationSeconds > $l.mediaMaxSeconds {
          THROW 'limit_upload_duration: the file is longer than the person may upload (D113)';
        };
      };
      -- Counted without this row; the fence above makes two overlapping grants conflict. Every
      -- grant counts per hour; only video and audio files per 7 days (Joel, 2026-10-30).
      LET $grants = (SELECT at, format FROM uploadGrant
        WHERE person = $after.person AND id != $after.id AND at > time::now() - 7d);
      IF array::len($grants.filter(|$g| $g.at > time::now() - 1h)) >= $l.uploadRequestsPerHour {
        THROW 'limit_upload_hourly: the person has started as many uploads as they may in an hour (D113)';
      };
      IF $after.format != 'image' AND $l.uploadsPer7Days != NONE
        AND array::len($grants.filter(|$g| $g.format != 'image')) >= $l.uploadsPer7Days {
        THROW 'limit_upload_weekly: the person has started as many uploads as they may in 7 days (D113)';
      };
      -- The draft's one video or audio file, or its image, is now this one (D80). The story's
      -- media or image VALUE starts its processing again (A2); its version steps once, to
      -- storyVersion + 1. A replaced image's file stays where it is: an approved story's public
      -- copy may still show it, so the clean-up sweep removes it later (media-runbook).
      IF $after.format = 'image' {
        UPDATE $after.story SET image = { path: record::id($after.id), width: $after.width,
          height: $after.height, alt: IF fn::text::trimmed_length($after.alt) = 0 { NONE }
            ELSE { string::trim($after.alt) } } RETURN NONE;
      } ELSE {
        UPDATE $after.story SET media = [{ format: $after.format, bunnyVideoId: record::id($after.id) }]
          RETURN NONE;
      };
      -- Older grants that are no longer any story's media or image.
      DELETE uploadGrant WHERE person = $after.person AND at <= time::now() - 7d
        AND record::id(id) NOT IN (story.media ?? []).map(|$m| $m.bunnyVideoId)
        AND record::id(id) != story.image.path;
    };
  };
-- A resume (D71): the link is signed again only if this commits. The story must still be the
-- person's, editable and showing this file, and the person must have the latest terms of use and
-- testimony consent, as for a new grant (plan 4e, Q2). The fence bump makes it conflict with a
-- draft's deletion (story_fence), so housekeeping never deletes a draft whose link was just
-- signed, and a resume never signs a link for a draft that was just deleted.
DEFINE EVENT OVERWRITE uploadGrant_renew ON uploadGrant
  WHEN $event = 'UPDATE' THEN {
    fn::person::live($after.person);
    LET $s = (SELECT submitter, status, media FROM ONLY $after.story);
    IF $s = NONE OR $s.submitter != $after.person
      OR $s.media[0].bunnyVideoId != record::id($after.id) {
      THROW 'nothing_to_resume: the story is gone or no longer shows this file';
    };
    IF $s.status NOT IN ['draft', 'changes_requested'] { THROW 'story_cmd:locked' };
    fn::legal::require_testimony($after.person);
  };
-- api-user's login, before it signs a link for `$video` again: renews the grant (above). NONE
-- if there is no such grant for this person's story.
DEFINE FUNCTION OVERWRITE fn::upload::renew($story: record<story>, $person: record<user>, $video: string) {
  RETURN (UPDATE type::record('uploadGrant', $video) SET renewedAt = time::now()
    WHERE story = $story AND person = $person RETURN VALUE renewedAt)[0];
};

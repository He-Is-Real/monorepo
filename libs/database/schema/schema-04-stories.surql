-- schema-04-stories.surql: stories (one table, R11), their status log (R6), their files (R12)
-- and draft retention.
-- Part of the declarative schema: every schema-NN-*.surql file, applied in name order in one
-- transaction (see schema-01-system.surql).

-- ---------------------------------------------------------------- story (R11: the one story table)
-- A story is its content only (R6, Joel 2026-11-05). Its status is its status log's newest entry
-- (storyStatusLog, below), which story.currentStatus points at; no entry = editing, never sent
-- (a "Draft"). Its picture and
-- its video or audio file are rows of storyFile (R12, below), which image.file and mediaFile point
-- at. Everyone, signed in or not, reads the published fields of an approved story (R11 B; db
-- review 2, section 6 item 4); the private fields only the owner and the services that need them.
-- A person's commands run in their own session (D27), so ownership is checked by the database.
-- api-user's own login reads only what everyone reads, and deletes (erasure): it can't create,
-- reassign or edit stories.
-- Write scope per field (D41): the person's words (content fields) only by the person; the file
-- pointers only by a new upload's storyFile row (D80: api-user's login, never the person's
-- session; storyFile_attach), except that the person may take their picture off or change its
-- description; the status pointer by the status log's event only. A field write outside its
-- scope is silently dropped (field PERMISSIONS or VALUE), so check the stored state.
DEFINE TABLE OVERWRITE story SCHEMAFULL PERMISSIONS               -- id = story:<ulid>
  -- housekeeping reads every story's status pointer, dates and file pointers (never its words: the
  -- content fields below refuse it) to find abandoned drafts and stories, rejected stories and
  -- orphaned Bunny videos.
  -- Everyone else: their own stories, and any story whose newest status entry says approved
  -- (R11's row rule; the status log's own rule lets them read that entry, and only that one).
  FOR select WHERE submitter = $auth
    OR $auth IN [service:api_admin, service:workflow, service:housekeeping]
    OR currentStatus.status = 'approved',
  FOR create WHERE submitter = $auth                -- own story only (no status entry yet),
    AND $auth.status != 'deleted',                     -- not erased (agreements: story_agreements)
  FOR update WHERE (submitter = $auth AND $auth.status != 'deleted')
    OR $auth IN [service:api_admin, service:workflow],
  FOR delete WHERE $auth IN [service:api_user, service:api_admin]   -- erasure
    -- ED-3 (Joel, 2026-11-11): the owner deletes their own story in every state, straight away
    -- (DeleteStory).
    OR (submitter = $auth AND $auth.status != 'deleted')
    -- D71 and G3 B (Joel, 2026-11-11): the nightly housekeeping Job deletes a story past its
    -- deletion date (fn::story::deletes_at: a draft nobody has touched for 186 days, a rejected
    -- story the settings' days after its rejection, a story left in editing after it was sent the
    -- settings' days after it was last touched), and nothing else; the same delete as a person's
    -- own (events and cascade included).
    OR ($auth = service:housekeeping AND fn::story::deletion_due(id));
-- Private (R11's field rule): the owner and the services that need it, never everyone else.
-- api-user's login reads it only on an erased person's stories, which fn::account::erase deletes
-- in the same transaction as it marks them erased (its DELETE ... WHERE submitter: a WHERE sees
-- only fields the caller may read). Never a published story's while its owner exists.
DEFINE FIELD OVERWRITE submitter     ON story TYPE record<user> READONLY   -- owner can never be reassigned
  PERMISSIONS FOR select WHERE submitter = $auth
    OR $auth IN [service:api_admin, service:workflow, service:housekeeping]
    OR ($auth = service:api_user AND submitter.status = 'deleted');
-- D29: +1 on every write; the owner's ETag. One exception (Joel, 2026-11-07, audio-picture-video
-- decision 1B): the result writer moving an audio story to its picture video isn't the person's
-- edit, so that write (workflow's login, with the query parameter $renderMove) keeps the version.
DEFINE FIELD OVERWRITE version       ON story TYPE int
  VALUE IF $before = NONE { 1 } ELSE IF $auth = service:workflow AND $renderMove = true { $before }
    ELSE { $before + 1 };
-- Content: what the person wrote. Never api-admin or workflow (D41); moderators request changes.
-- housekeeping never reads the words (select below): it needs only ids, the status, dates and files.
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
-- R6 (Joel, 2026-11-05): the story's newest status entry that moved it (history-only entries
-- don't); NONE = editing, never sent (a draft). Only the status log's
-- event moves it (storyStatusLog_step: events run elevated, so this rule doesn't stop it), always
-- to an entry of this story (story_status_pointer); nobody's session can write it (dropped).
DEFINE FIELD OVERWRITE currentStatus ON story TYPE option<record<storyStatusLog>>
  PERMISSIONS FOR create, update NONE;
-- D53: the optional picture of a written story, an audio story's own picture (M2 plan PR 10; it
-- becomes the clip's thumbnail through processing, M7), or a video's own thumbnail (Joel,
-- 2026-10-30): readers show it in place of Bunny's generated thumbnail. One image system: it is
-- never set at Bunny. R12 (Joel, 2026-11-05): the picture is a storyFile row (its path in the
-- images storage zone is the row's id; its pixel size and processing state live there), and the
-- story keeps only the pointer and the person's description (alt: NONE = readers show a neutral
-- default), which they may change without uploading again.
-- D65/D80: only a new upload's row puts a picture on (storyFile_attach, on api-user's login); the
-- person's session may then change only `alt`, or take the picture off (NONE), never point at
-- another file. System users ($auth NONE: the migrator, dev-seed) write it as given, still only to
-- the story's own rows (story_files).
DEFINE FIELD OVERWRITE image         ON story TYPE option<object>
  VALUE IF $auth = NONE OR $auth = service:api_user { $value }
    ELSE IF $value = NONE OR $before = NONE { NONE }
    ELSE { { file: $before.file, alt: $value.alt } }
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.file    ON story TYPE record<storyFile>
  PERMISSIONS FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
DEFINE FIELD OVERWRITE image.alt     ON story TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 500
  PERMISSIONS FOR select WHERE $auth != service:housekeeping,
    FOR update WHERE $auth NOT IN [service:api_admin, service:workflow];
-- R12: the story's one video or audio file, a storyFile row (its id is the Bunny video id; its
-- thumbnail, size, real length and processing state live there). D80 (Joel, 2026-10-25): never
-- the person's session or api-admin: a new upload's row moves it (storyFile_attach, elevated),
-- and system users load it as given. One more (Joel, 2026-11-07, audio-picture-video decision
-- 1B): workflow's login moves an audio story from its file to that file's own picture video
-- (storyFile.renderOf), only while it still points at that file (story_files checks it).
DEFINE FIELD OVERWRITE mediaFile     ON story TYPE option<record<storyFile>>
  -- Anything else workflow writes here is dropped, like any write outside its scope.
  PERMISSIONS FOR create NONE, FOR update WHERE $auth = service:workflow AND $value != NONE
    AND $before != NONE AND (SELECT VALUE renderOf FROM ONLY $value) = $before;
-- Plan 4e: the optional social media sharing consent, per story: NONE until the person ticks
-- the box at the end of the upload (one box naming every platform; it gives the charity copyright
-- permission to share and can't be withdrawn: deleting the story stops future
-- use). Recorded with the submission, by the person's own session, on the latest version, with
-- the database's time (fn::legal::check_pointer, from story_agreements). Gone with the story.
-- Private (R11's field rule).
DEFINE FIELD OVERWRITE socialMediaSharingConsent ON story TYPE option<record<socialMediaSharingConsent>>
  PERMISSIONS FOR select WHERE submitter = $auth
    OR $auth IN [service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE socialMediaSharingConsentAgreedAt ON story TYPE option<datetime>
  VALUE IF $this.socialMediaSharingConsent = NONE { NONE } ELSE IF $value != $before { time::now() } ELSE { $before }
  PERMISSIONS FOR select WHERE submitter = $auth
    OR $auth IN [service:api_admin, service:workflow, service:housekeeping];
-- Private (R11's field rule): an internal date.
DEFINE FIELD OVERWRITE createdAt     ON story TYPE datetime VALUE $before OR time::now() READONLY
  PERMISSIONS FOR select WHERE submitter = $auth
    OR $auth IN [service:api_admin, service:workflow, service:housekeeping];
-- The server time on every write. Only a system user ($auth = NONE: the migrator, dev's seed)
-- may keep or supply another: so a migration doesn't make a draft look touched, and tests can
-- age a draft for D71's 6-month expiry (housekeeping).
DEFINE FIELD OVERWRITE updatedAt     ON story TYPE datetime
  VALUE IF $auth = NONE AND $value != NONE { $value } ELSE { time::now() };
-- D30: the story's old slugs, so an old link answers 301 to the current one (R11: moved from
-- the published copy). Only a system user writes it (nothing in the services changes a
-- published story's slug); anyone else's value is ignored.
DEFINE FIELD OVERWRITE slugHistory   ON story TYPE array<string>
  VALUE IF $auth = NONE { $value ?? [] } ELSE { $before ?? [] };
-- The themes' ids as text, computed on every write (no writer sets them), for ?theme= and for
-- whether a published story uses a theme (D63: /v1/themes lists a theme that isn't highlighted
-- only then). 3.2.4 returns no rows from an element index over record links (`themeRefs.*`),
-- but indexes strings correctly (see the gotchas). Kept stored, not computed on read: computed
-- fields can't be indexed the same way (db review 2, section 6).
DEFINE FIELD OVERWRITE themeIds      ON story TYPE array<string>
  VALUE (themeRefs ?? []).map(|$t| record::id($t));
-- R6: a story's status (a story value already read, e.g. $before / $after in events, or its
-- record): its newest status entry's that moved it, or 'editing' with none (never sent: the
-- person sees a "Draft", Joel 2026-11-11).
DEFINE FUNCTION OVERWRITE fn::story::status_of($s: any) {
  RETURN $s.currentStatus.status ?? 'editing';
};
-- Story states (Joel, 2026-11-11): the state each status log action leaves a story in. A
-- history-only action (fn::story::history_only) leaves it as it is: $story's state now.
DEFINE FUNCTION OVERWRITE fn::story::action_status($action: string, $story: any) {
  RETURN IF $action = 'sent' { 'pending' }
    ELSE IF $action IN ['editStarted', 'changesRequested', 'fileUnusable'] { 'editing' }
    ELSE IF $action IN ['approved', 'shownBySystem', 'shownByModerator'] { 'approved' }
    ELSE IF $action = 'rejected' { 'rejected' }
    ELSE IF $action IN ['hiddenBySystem', 'hiddenByModerator'] { 'hidden' }
    ELSE { fn::story::status_of($story) };
};
-- The status log actions that leave a story approved (on the site). The log's own fields use
-- this rather than the entry's `status`: 3.2.4 computes a row's fields in name order, so
-- publishedAt and reviewed* are computed before status.
DEFINE FUNCTION OVERWRITE fn::story::approves($action: any) {
  RETURN $action IN ['approved', 'shownBySystem', 'shownByModerator'];
};
-- The status log actions that record a change without moving the story (history only).
DEFINE FUNCTION OVERWRITE fn::story::history_only($action: string) {
  RETURN $action IN ['fileReplaced', 'pictureReplaced', 'wordsChanged'];
};
-- Who may take which action from which state (the log-entry table of "Story states"; Joel,
-- 2026-11-11). $from: the story's state before the entry.
-- A history-only entry's actor is whoever's write caused it (a person's own edit is 'person'), but
-- only the database's events write one: the storyStatusLog create permission refuses it directly.
DEFINE FUNCTION OVERWRITE fn::story::step_allowed($actor: string, $action: string, $from: string) {
  IF fn::story::history_only($action) {
    RETURN $actor IN ['person', 'system'] AND $from = 'editing';
  };
  RETURN IF $actor = 'person' {
      ($action = 'sent' AND $from = 'editing')
        OR ($action = 'editStarted' AND $from IN ['pending', 'approved', 'hidden'])
    } ELSE IF $actor = 'moderator' {
      ($action IN ['approved', 'changesRequested', 'rejected'] AND $from = 'pending')
        OR ($action = 'hiddenByModerator' AND $from = 'approved')
        OR ($action = 'shownByModerator' AND $from = 'hidden')
    } ELSE {
      ($action = 'hiddenBySystem' AND $from = 'approved')
        OR ($action = 'shownBySystem' AND $from = 'hidden')
        OR ($action = 'fileUnusable' AND $from IN ['pending', 'approved', 'hidden'])
    };
};
-- The content fields as one value, for comparing before/after.
DEFINE FUNCTION OVERWRITE fn::story::content($s: any) {
  RETURN {
    slug: $s.slug, title: $s.title, description: $s.description, body: $s.body,
    bylineName: $s.bylineName, primaryFormat: $s.primaryFormat, themeRefs: $s.themeRefs,
    mediaFile: $s.mediaFile, image: $s.image
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
--   written: text (body, not blank), no video or audio; optional picture
--   video / audio: one file of that format (mediaFile), optional text; an optional picture (M2
--   plan PR 10): an audio story's picture, or a video's own thumbnail (Joel, 2026-10-30), shown
--   in place of Bunny's generated thumbnail
-- A draft is created before its upload (CreateDraftStory), so video and audio need their file
-- once sent (pending, approved, hidden), and may lack it while editing or rejected.
-- The status is the story's newest status entry's (R6), so moving the pointer is checked too.
-- The files' own sizes and shapes are checked on their rows (storyFile_shape).
-- A written story's minimum length (Joel, 2026-10-23, from the POC; a setting since W3) is
-- checked when it's submitted (story_text_limits), so a short draft can still be saved.
-- Used by the story_shape event.
DEFINE FUNCTION OVERWRITE fn::story::shape_problem($s: any) {
  LET $format = $s.mediaFile.format;
  IF $s.image != NONE AND $s.image.file.format != 'image' {
    RETURN 'a story’s picture must be an image file';
  };
  IF $s.primaryFormat = 'written' {
    LET $length = fn::text::trimmed_length($s.body);
    IF $length = 0 { RETURN 'a written story needs its text' };
    IF $s.mediaFile != NONE { RETURN 'a written story has no video or audio' };
  } ELSE {
    IF $s.mediaFile != NONE AND $format != $s.primaryFormat {
      RETURN 'a ' + $s.primaryFormat + ' story’s media must be ' + $s.primaryFormat;
    };
    IF $s.mediaFile = NONE
      AND fn::story::status_of($s) IN ['pending', 'approved', 'hidden'] {
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
-- the only name api-user gives one (storyFile_attach checks it when the row is made).
DEFINE FUNCTION OVERWRITE fn::media::own_image($story: any, $path: any) {
  RETURN type::is_record($story) AND type::is_string($path)
    AND string::matches($path, '^stories/[A-Za-z0-9_]{1,64}/[0-9a-f]{32}[.]webp$')
    AND string::starts_with($path, 'stories/' + <string> record::id($story) + '/');
};
-- $f: a video or audio file's storyFile row (its id is the Bunny video id).
DEFINE FUNCTION OVERWRITE fn::media::own_thumbnail($f: any) {
  LET $video = <string> record::id($f.id);
  IF !type::is_string($f.thumbnailPath) OR string::len($f.thumbnailPath) > 500 { RETURN false };
  LET $parts = string::split($f.thumbnailPath, '/');
  RETURN array::len($parts) = 2 AND $parts[0] = $video
    AND fn::media::safe_segment($parts[0]) AND fn::media::safe_segment($parts[1]);
};
-- A2 (Joel, 2026-10-23): what keeps a story from being approved or published, or NONE. Every
-- upload must be processed by workflow (M7: size, duration, the malware and content checks) and
-- carry the facts processing found: a video its width, height and length, an audio file its
-- length and its thumbnail with that picture's width and height (the person's image or the
-- site's default, set by processing; Joel, 2026-10-24), a picture (already sized by the person's
-- browser) processing = 'ready'. So nothing unprocessed, or possibly malicious, reaches the
-- public view. R12: read from the files the story points at. Messages start with
-- 'media_not_ready:' so api-admin answers 409 (libs/database isMediaNotReadyError).
DEFINE FUNCTION OVERWRITE fn::story::approval_problem($s: any) {
  LET $m = IF $s.mediaFile != NONE { (SELECT * FROM ONLY $s.mediaFile) };
  LET $i = IF $s.image != NONE { (SELECT * FROM ONLY $s.image.file) };
  IF $s.mediaFile != NONE AND $m.processing != 'ready' {
    RETURN 'media_not_ready: the story’s video or audio hasn’t finished processing';
  };
  IF $m.format = 'video' AND !(type::is_int($m.width) AND type::is_int($m.height)
       AND type::is_int($m.lengthSeconds) AND $m.lengthSeconds > 0) {
    RETURN 'media_not_ready: a video needs its width, height and length';
  };
  IF $m.format = 'audio' AND !(type::is_int($m.lengthSeconds) AND $m.lengthSeconds > 0) {
    RETURN 'media_not_ready: an audio file needs its length';
  };
  IF $m.format = 'audio' AND !(fn::media::own_thumbnail($m)
       AND type::is_int($m.width) AND type::is_int($m.height)) {
    RETURN 'media_not_ready: an audio file needs its thumbnail and that picture’s width and height';
  };
  IF $s.image != NONE AND $i.processing != 'ready' {
    RETURN 'media_not_ready: the story’s image hasn’t finished processing';
  };
  -- The picture Bunny shows (Joel: video-bundle-rethink part A, 2026-11-06, for a video's own
  -- picture; audio-picture-video decision 1B, 2026-11-07, for an audio story's picture video):
  -- the video or audio file's thumbnailOf is the story's picture now, or both are empty (a video
  -- shows Bunny's own frame; an audio story's picture video has the site's default background).
  -- The result writer sets it once Bunny has that picture, so the public never sees another.
  IF $s.mediaFile != NONE AND $m.thumbnailOf != $s.image.file {
    RETURN 'media_not_ready: Bunny doesn’t show the story’s picture yet';
  };
  RETURN NONE;
};
-- What keeps a moderator from approving the story yet, or NONE (Joel, 2026-11-07: decision 5
-- and J6, media-worker-final.html section 3). Unlike approval_problem it is about the review, not
-- about the files being fit to show, so only a moderator's approval checks it (storyStatusLog_step):
-- a system restore and the hiding of an approved story never do.
-- - The upload cooldown: a file's upload link may still be used to replace what the moderator
--   watched, until the last link signed for it (storyFile at, or renewedAt for a resume) has run
--   its length (fn::upload::link_lifetime). Refused while $now is before that; the message gives
--   the time, rounded up to the second, from which it can be approved.
-- - An open media job (J6): a check or render for the story's media file or picture that hasn't
--   ended (mediaJob doneAt), e.g. the picture video of an audio story whose picture changed.
-- - A video's picture at Bunny not confirmed (Joel, 2026-11-08, T3; 2026-11-09, T4 = A): its
--   storyFile thumbnailLockedUntil is set, whether in the future (a writer is at work) or past (an
--   unfinished write: Bunny may show another picture). Only a write Bunny confirmed and the result
--   writer recorded empties it. Here, not in approval_problem: like an open job it is a moment of
--   the review, not the files being unfit to show, so it must never hide an approved story or stop
--   one coming back (check_files, restorable).
-- An Admin may approve anyway, and the entry records it (storyStatusLog.skippedMediaWait).
-- Messages start with a code for api-admin (409). $now: the time to judge at (the approval's).
-- Runs elevated from the event (only the services read mediaJob).
DEFINE FUNCTION OVERWRITE fn::story::approval_wait($s: any, $now: datetime) {
  LET $files = [$s.mediaFile, $s.image.file].filter(|$f| $f != NONE);
  LET $until = array::max($files.map(|$f| {
    LET $r = (SELECT format, at, renewedAt FROM ONLY $f);
    RETURN IF $r = NONE { NONE } ELSE {
      array::max([$r.at, $r.renewedAt].filter(|$t| $t != NONE)) + fn::upload::link_lifetime($r.format)
    };
  }).filter(|$t| $t != NONE));
  IF $until != NONE AND $now < $until {
    RETURN 'media_recently_uploaded: the story’s file was uploaded recently; it can be approved after '
      + <string> time::ceil($until, 1s);
  };
  -- T3/T4 (Joel, 2026-11-08/09): the video's picture at Bunny isn't confirmed yet (a writer at
  -- work, or one that ran out unfinished).
  LET $lock = IF $s.mediaFile != NONE { (SELECT VALUE thumbnailLockedUntil FROM ONLY $s.mediaFile) };
  IF $lock != NONE {
    RETURN 'media_still_processing: the story’s media is still being processed';
  };
  IF $files != [] AND (SELECT VALUE id FROM mediaJob WHERE file IN $files AND doneAt = NONE LIMIT 1) != [] {
    RETURN 'media_still_processing: the story’s media is still being processed';
  };
  RETURN NONE;
};
-- D65, D80, R12: a story points only at files uploaded for it. The pointers are the permission
-- slip: a new pointer must name a storyFile row of this story, of the right kind, not detached
-- (one story per file: its id is the Bunny video id or the picture's path), whoever writes,
-- system users too (Codex, #188 review: a row two stories share is hidden, detached and
-- deleted through one while the other still shows it; dev-seed gives each story its own rows).
-- Only storyFile_attach moves them (the person can only take their picture off), so this
-- guards against a bug or a misused login.
-- R12 / db review 2, section 6 item 7: whenever a story stops pointing at a file (a new upload
-- replaced it, or the person took their picture off), the file's row gets detachedAt in the same
-- write, whoever writes; the nightly clean-up deletes the file once no upload link for it can
-- still be used, and records removedAt.
-- And whenever its pointers change (only system users can do that to a published story), an
-- approved story whose files are no longer the reviewed ones is hidden, and a hidden one shown
-- again when they are (the same rule as for a file's processing, storyFile_availability).
DEFINE FUNCTION OVERWRITE fn::story::pointer_problem($story: record<story>, $file: any, $kinds: array) {
  LET $f = (SELECT story, format, detachedAt FROM ONLY $file);
  RETURN $f = NONE OR $f.story != $story OR $f.format NOT IN $kinds OR $f.detachedAt != NONE;
};
DEFINE EVENT OVERWRITE story_files ON story
  WHEN $event IN ['CREATE', 'UPDATE']
    AND ($before.mediaFile != $after.mediaFile OR $before.image.file != $after.image.file)
  THEN {
    LET $media = $after.mediaFile;
    LET $image = $after.image.file;
    -- 1B: workflow only moves the story from a file to that file's own picture video.
    IF $auth = service:workflow AND $media != $before.mediaFile
      AND ($before.mediaFile = NONE OR $media = NONE
        OR (SELECT VALUE renderOf FROM ONLY $media) != $before.mediaFile) {
      THROW 'media_not_granted: workflow moves a story only to its file’s own picture video (1B)';
    };
    IF $media != NONE AND $media != $before.mediaFile
      AND fn::story::pointer_problem($after.id, $media, ['video', 'audio']) {
      THROW 'media_not_granted: a story’s video or audio must be one uploaded for it (D80)';
    };
    IF $image != NONE AND $image != $before.image.file
      AND fn::story::pointer_problem($after.id, $image, ['image']) {
      THROW 'media_not_granted: a story’s picture must be one uploaded for it (D80)';
    };
    FOR $old IN [$before.mediaFile, $before.image.file] {
      IF $old != NONE AND $old NOT IN [$media, $image] {
        UPDATE $old SET detachedAt = time::now() WHERE detachedAt = NONE AND story = $after.id
          RETURN NONE;
      };
    };
    IF $event = 'UPDATE' { fn::story::check_files($after) };
  };
-- R6: the status pointer only ever moves to an entry of this story that moved it, whoever writes
-- (system users too; sessions can't write it at all), and a new story starts as a draft (editing,
-- never sent) unless a system user loads it otherwise.
DEFINE EVENT OVERWRITE story_status_pointer ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND $after.currentStatus != $before.currentStatus
    AND $after.currentStatus != NONE
  THEN {
    IF $after.currentStatus.story != $after.id {
      THROW 'a story’s status points only at an entry of its own status log (R6)';
    };
    IF fn::story::history_only($after.currentStatus.action) {
      THROW 'a story’s status points only at an entry that moved it (R6)';
    };
  };
-- Every write, by anyone (system users too): the stored story always has a valid type and shape.
DEFINE EVENT OVERWRITE story_shape ON story
  WHEN $event IN ['CREATE', 'UPDATE']
  THEN {
    LET $problem = fn::story::shape_problem($after);
    IF $problem != NONE { THROW $problem };
  };
-- Only while a story is being edited can its owner change its content (M3-6 A: everything; G15:
-- its contents and themes); once sent it is locked, so what a moderator reviewed is what gets
-- published. To change a sent or published story the person presses Edit first (editStarted).
-- Which steps the owner may take is the status log's rule (storyStatusLog_step).
DEFINE EVENT OVERWRITE story_owner_content_lock ON story
  WHEN $event = 'UPDATE' AND $after.submitter = $auth
   AND fn::story::status_of($before) != 'editing'
   AND fn::story::content($before) != fn::story::content($after)
  THEN { THROW 'story content is locked after submission' };
-- The story's history (Story states, Joel 2026-11-11: "Send again with different words or
-- themes"): the first change to the title, description, body or themes of a story that was
-- sent before, in each round of editing (none yet since the entry that moved it to editing),
-- adds one history-only wordsChanged entry. Whoever writes but api-admin: its only story writes
-- are a moderator's theme deletions, which aren't the person's words and which a moderator
-- can't record as history (fn::story::step_allowed). System users write as the system.
DEFINE EVENT OVERWRITE story_words_changed ON story
  WHEN $event = 'UPDATE' AND $auth != service:api_admin
   AND fn::story::status_of($after) = 'editing'
   AND ($before.title != $after.title OR $before.description != $after.description
     OR $before.body != $after.body OR $before.themeRefs != $after.themeRefs)
  THEN {
    LET $round = $after.currentStatus.at;
    IF $round != NONE
      AND (SELECT VALUE id FROM storyStatusLog WITH INDEX storyStatusLog_story
        WHERE story = $after.id AND action = 'sent' LIMIT 1) != []
      AND (SELECT VALUE id FROM storyStatusLog WITH INDEX storyStatusLog_story
        WHERE story = $after.id AND at >= $round AND action = 'wordsChanged' LIMIT 1) = [] {
      CREATE type::record('storyStatusLog', rand::ulid()) CONTENT { story: $after.id,
        action: 'wordsChanged', actor: 'system' } RETURN NONE;
    };
  };
-- Plan 4e, Joel 2026-11-01 (Q2): "agree first", in the database. The person's own writes to their
-- story (create, edit, submit; plus the sharing pointer) need the terms of use and the testimony
-- consent at the latest version (fn::legal::require_testimony). Pressing Edit (-> editing,
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
       AND !($event = 'UPDATE' AND fn::story::status_of($after) = 'editing'
             AND fn::story::status_of($before) != 'editing'
             AND fn::story::content($before) = fn::story::content($after)) {
      fn::legal::require_testimony($after.submitter);
    };
  };
-- D94, D112 (founder, 2026-10-25/28): limits on what a person starts, from the settings an admin
-- adjusts (submissionSettings, below) and the person's own overrides (submitterLimits): open
-- drafts (default 3) and stories submitted for review in any rolling 7 days (default 1). A trusted
-- submitter has neither. Only the person's own writes are limited ($auth = submitter): the
-- migrator and dev-seed load data as themselves. A submission counts from its first submit, kept
-- in submissionLog (D113) for 7 days whatever happens to the story since (edited, rejected,
-- deleted), so deleting and submitting again doesn't get round it; sending a story again after
-- an edit or "changes requested" isn't a new one (R6: a story's first submission is its first
-- `sent` status entry). Open drafts are stories never sent (no status entry). Messages start with a code so api-user answers
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
        OR ($event = 'UPDATE' AND fn::story::status_of($after) = 'pending'
            AND fn::story::status_of($before) != 'pending'))
  THEN {
    IF $event = 'CREATE' {
      LET $max = fn::limits::effective($after.submitter).openDraftsMax;
      LET $open = (SELECT VALUE id FROM story
        WHERE submitter = $after.submitter AND currentStatus = NONE AND id != $after.id);
      IF $max != NONE AND array::len($open) >= $max {
        THROW 'limit_open_drafts: the person has as many open drafts as they may (D94)';
      };
    } ELSE IF count(SELECT id FROM storyStatusLog WITH INDEX storyStatusLog_story
        WHERE story = $after.id AND action = 'sent') = 1 {
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
--   - sending (its `sent` status entry moving the pointer from editing) needs
--     the text's minimum and maximum length, from themesMin to
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
    LET $status = fn::story::status_of($after);
    IF $status IN ['pending', 'approved']
       AND ($event = 'CREATE' OR fn::story::status_of($before) NOT IN ['pending', 'approved', 'hidden']) {
      IF $len > $set.storyTextMax {
        THROW 'story_text_too_long: the story’s body is longer than the setting allows (W3)';
      };
      -- Themes (plan v3): checked when the person submits (into pending) only, never again
      -- later (deleting a theme may leave a published story under the minimum).
      IF $status = 'pending' {
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
  WHEN $event IN ['CREATE', 'UPDATE'] AND fn::story::status_of($after) = 'approved'
    AND fn::story::status_of($before) != 'approved'
  THEN {
    LET $problem = fn::story::approval_problem($after);
    IF $problem != NONE { THROW $problem };
  };
-- Joel, 2026-10-23: an approved story stays approved when its media stops being ready ('failed',
-- back to 'processing', a fact removed): "we need to ... get it loading again instead of
-- approving again". While a file isn't ready the story is hidden: the same write adds a system
-- `hidden` entry to its status log (R6), so it leaves the public's view at once. When the same
-- files are ready again (Bunny re-encodes the video; workflow sets processing back to 'ready'
-- with its facts) the same write adds a system shownBySystem entry: it comes back with its first
-- publishedAt and no new review. Only workflow and system users can cause either: the person's
-- content is locked unless they press Edit (which takes the story off the site first) and
-- api-admin can't write files.
-- What was reviewed (R6/R12; db review 2, section 6 item 1): each approved entry records the
-- exact files the story pointed at (reviewedMediaFile, reviewedImageFile). It comes back without
-- a new review only while it still points at both; a new picture or video is a new file row, so
-- it needs a review. Bunny's thumbnails of the same file (thumbnailPath, set by processing) may
-- change, as before. A story whose files differ from the reviewed ones (only a system user can
-- point a published story elsewhere) is hidden too (reason media_changed; D59: changed after
-- going public needs approving again).
DEFINE FUNCTION OVERWRITE fn::story::reviewed_files($s: any) {
  -- Bound first: inside the SELECT, $this is the row being read.
  LET $story = $s.id;
  RETURN (SELECT reviewedMediaFile, reviewedImageFile, at FROM storyStatusLog
    WITH INDEX storyStatusLog_story
    WHERE story = $story AND status = 'approved' ORDER BY at DESC LIMIT 1)[0];
};
DEFINE FUNCTION OVERWRITE fn::story::shows_reviewed_files($s: any) {
  LET $r = fn::story::reviewed_files($s);
  RETURN $r != NONE AND $r.reviewedMediaFile = $s.mediaFile
    AND $r.reviewedImageFile = $s.image.file;
};
-- Hides an approved story: a system hiddenBySystem entry, in the caller's transaction. $reason:
-- media_unavailable or media_changed. Called by events only (they run elevated).
DEFINE FUNCTION OVERWRITE fn::story::hide($s: any, $reason: string) {
  CREATE type::record('storyStatusLog', rand::ulid()) CONTENT {
    story: $s.id, action: 'hiddenBySystem', actor: 'system', hiddenReason: $reason
  } RETURN NONE;
};
-- Whether a hidden story may come back without a new review: the system hid it (a moderator's
-- hide stays until a moderator ends it), its files are ready and still the reviewed ones, and
-- its uploader has the testimony consent (plan 4e). Elevated in events; with the caller's
-- permissions elsewhere.
DEFINE FUNCTION OVERWRITE fn::story::restorable($s: any) {
  RETURN fn::story::status_of($s) = 'hidden'
    AND $s.currentStatus.action = 'hiddenBySystem'
    AND fn::story::approval_problem($s) = NONE
    AND fn::story::shows_reviewed_files($s)
    AND $s.submitter.testimonyConsent != NONE;
};
-- After a write to a story's files (a file row's processing, storyFile_availability; or its
-- pointers, story_files): hide it or show it again as above. $s: the story as it is now.
DEFINE FUNCTION OVERWRITE fn::story::check_files($s: any) {
  LET $status = fn::story::status_of($s);
  IF $status = 'approved' {
    LET $problem = fn::story::approval_problem($s);
    IF $problem != NONE OR !fn::story::shows_reviewed_files($s) {
      fn::story::hide($s, IF $problem != NONE { 'media_unavailable' } ELSE { 'media_changed' });
    };
  } ELSE IF fn::story::restorable($s) {
    CREATE type::record('storyStatusLog', rand::ulid()) CONTENT {
      story: $s.id, action: 'shownBySystem', actor: 'system'
    } RETURN NONE;
  };
};
-- Plan 4e: publishing needs the submitter's testimony consent (any version: it covers every
-- story they submit; a newer version only gates new stories), whoever approves (system users
-- too). It can't have gone since submission (only erasure clears it, and erasure deletes the
-- story); this is defence in depth.
DEFINE EVENT OVERWRITE story_approval_testimony ON story
  WHEN $event IN ['CREATE', 'UPDATE'] AND fn::story::status_of($after) = 'approved'
   AND fn::story::status_of($before) != 'approved'
   AND $after.submitter.testimonyConsent = NONE
  THEN { THROW 'testimony_consent_required: approving a story needs its submitter’s testimony consent (plan 4e)' };
DEFINE EVENT OVERWRITE story_fence ON story              -- create, edit, status steps, delete
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
-- Erasure: api-user's login may delete stories but can't read their status log. Deleting a story
-- removes it in the same transaction, whoever deletes it (R6: a status entry goes only with its
-- story). Its storyFile rows stay: the upload limits count them for 7 days (D113), and its files
-- go as before (pendingDeletion; db review 2, section 6 item 7).
DEFINE EVENT OVERWRITE story_erasure_cascade ON story
  WHEN $event = 'DELETE'
  THEN {
    DELETE storyStatusLog WHERE story = $before.id;
    DELETE favourite WHERE story = $before.id;                  -- others' hearts on it
  };
-- Every deleted story's picture folder in the images zone (M2 plan PR 10, D82, D40), whoever
-- deletes it (its owner, erasure, housekeeping's expired drafts, dev-seed): every picture of a
-- story lives in `stories/<its id>/`, so the folder is queued from the story row itself, never
-- from its storyFile rows (they are pruned after 7 days, Codex #140 r4). One queue row per folder (its key is the story's id), with its final pass
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
DEFINE ANALYZER OVERWRITE story_en TOKENIZERS blank, class FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX OVERWRITE story_slug      ON story FIELDS slug UNIQUE;
DEFINE INDEX OVERWRITE story_submitter ON story FIELDS submitter, createdAt;
-- An element index (`slugHistory.*`): the old-slug lookup's `CONTAINS` uses it; a plain index over
-- the array is never used (EXPLAIN on 3.2.4, 2026-11-05: a table scan).
DEFINE INDEX OVERWRITE story_slughist  ON story FIELDS slugHistory.*;
DEFINE INDEX OVERWRITE story_theme_ids ON story FIELDS themeIds.*;     -- D63
-- No search index on story: search goes over storySearch (below), which holds published stories'
-- words only.

-- ---------------------------------------------------------------- storySearch (search option A)
-- Search option A (Joel, 2026-11-06; search-drafts-decision.html): one row per PUBLISHED story,
-- holding only its search words and the story it belongs to; id = storySearch:<the story's key>.
-- The full-text index lives here, so BM25's scores and the "best match" order are computed over
-- published stories only: a draft being created or deleted can't move a score or a page (Codex,
-- #187 review). It is not a public copy of the story: only the words, which the public already
-- reads on the story and its themes.
-- searchText (search-ranking-design.html; Joel, 2026-11-06: "include story themes inside the
-- terms search is ranked on too"): the title, description, written text and the current names of
-- its themes, as one text, all counting equally (one field, one analyzer). Category names aren't
-- included.
-- Joel, 2026-11-06 ("store each story's additional fields on search row"): the row also holds
-- what the public lists filter and sort on (primaryFormat, themeIds, publishedAt: the current
-- approved entry's), so search filters, scores, sorts and pages inside storySearch and builds
-- story cards for one page only.
-- The database alone writes it (fn::story::sync_search), in the same write that publishes the
-- story or stops it being published (Edit, hidden), deletes it (DeleteStory,
-- erasure, housekeeping), changes its words or themes, or renames or deletes one of its themes:
-- no service path can forget it. Everyone may read a row only while its story is published now
-- (the story's own row rule); nobody writes one directly.
DEFINE TABLE OVERWRITE storySearch SCHEMAFULL PERMISSIONS
  FOR select WHERE story.currentStatus.status = 'approved',
  FOR create, update, delete NONE;
DEFINE FIELD OVERWRITE story      ON storySearch TYPE record<story> READONLY;
DEFINE FIELD OVERWRITE searchText    ON storySearch TYPE string;
DEFINE FIELD OVERWRITE primaryFormat ON storySearch TYPE string;
DEFINE FIELD OVERWRITE themeIds      ON storySearch TYPE array<string>;
DEFINE FIELD OVERWRITE publishedAt   ON storySearch TYPE datetime;
DEFINE INDEX OVERWRITE storySearch_fts ON storySearch FIELDS searchText
  FULLTEXT ANALYZER story_en BM25 HIGHLIGHTS;                -- 3.x syntax (was SEARCH ANALYZER)
-- A story's search words: title, description, written text and its themes' current names.
DEFINE FUNCTION OVERWRITE fn::story::search_text($s: any) {
  LET $refs = $s.themeRefs ?? [];
  LET $themes = (SELECT VALUE name FROM theme WHERE id IN $refs ORDER BY name);
  RETURN array::join(array::concat([$s.title, $s.description, $s.body ?? ''], $themes), ' ');
};
-- Puts the story's row in step with it: its words if it is published now, no row otherwise
-- (including a story that is gone). Called by events only (they run elevated).
-- Writing the words reads the themes' names, so it bumps each theme's fence (fence:theme-<id>),
-- as a rename and a delete do (storySearch_theme_renamed, theme_delete): a row built from a
-- snapshot can't commit alongside a rename or delete of one of its themes (Codex, #188 review).
-- The second to commit conflicts, and its retry reads the other's result. $fenced: the caller
-- (a rename) has bumped the fence already.
DEFINE FUNCTION OVERWRITE fn::story::sync_search($id: record<story>, $fenced: option<bool>) {
  LET $s = (SELECT * FROM ONLY $id);
  LET $row = type::record('storySearch', record::id($id));
  IF $s != NONE AND fn::story::status_of($s) = 'approved' {
    IF $fenced != true {
      FOR $t IN $s.themeRefs ?? [] { IF record::exists($t) { fn::fence::touch('theme', $t) } };
    };
    LET $fields = {
      searchText: fn::story::search_text($s), primaryFormat: $s.primaryFormat,
      themeIds: $s.themeIds, publishedAt: $s.currentStatus.publishedAt
    };
    IF record::exists($row) { UPDATE $row MERGE $fields RETURN NONE }
    ELSE { CREATE $row CONTENT object::extend($fields, { story: $id }) RETURN NONE };
  } ELSE IF record::exists($row) {
    DELETE $row RETURN NONE;
  };
};
DEFINE EVENT OVERWRITE story_search ON story
  WHEN $event = 'DELETE' OR ($event = 'UPDATE' AND (
    fn::story::status_of($before) != fn::story::status_of($after)
    OR $before.title != $after.title OR $before.description != $after.description
    OR $before.body != $after.body OR $before.themeIds != $after.themeIds
    OR $before.primaryFormat != $after.primaryFormat))
  THEN {
    IF $event = 'DELETE' { DELETE type::record('storySearch', record::id($before.id)) RETURN NONE }
    ELSE { fn::story::sync_search($after.id) };
  };
-- A renamed theme: the published stories that carry it get its new name (deleting a theme takes
-- it off its stories, theme_delete, which story_search follows). Only those stories: the
-- story_theme_ids index finds them. The rename bumps the theme's fence, so it conflicts with a
-- search row being written from the old name meanwhile (fn::story::sync_search).
DEFINE EVENT OVERWRITE storySearch_theme_renamed ON theme
  WHEN $event = 'UPDATE' AND $before.name != $after.name
  THEN {
    fn::fence::touch('theme', $after.id);
    LET $key = record::id($after.id);
    FOR $s IN (SELECT VALUE id FROM story WHERE themeIds CONTAINS $key) {
      IF record::exists(type::record('storySearch', record::id($s))) {
        fn::story::sync_search($s, true);
      };
    };
  };

-- ---------------------------------------------------------------- storyStatusLog (R6)
-- The story's status log (Joel, 2026-11-05): everything that happens to a story is a row here,
-- never changed afterwards, and story.currentStatus points at the newest row that moved it; its
-- status is the story's (no entry yet = editing, never sent: a "Draft"). The same pattern as the
-- legal-text agreements (plan 4e).
-- Five states (Joel, 2026-11-11, "Story states"; m3-plan-and-m2-extras.html): editing (the person
-- can change it and send it), pending (sent, waiting for a moderator, locked), approved (on the
-- site), hidden (approved but off the site), rejected (final: the person can only delete it).
-- Each row's `action` says how the story got there (ED-2 B: "easier for moderators to understand
-- why things are happening"); the row's status follows from it (fn::story::action_status).
-- Who adds which action (fn::story::step_allowed), checked by storyStatusLog_step whoever writes:
--   the person (their own session, own story): sent (editing -> pending) and editStarted
--     (pending, approved or hidden -> editing: Edit, ED-1/ED-4; it leaves the site at once);
--   a moderator (api-admin, naming the moderator in `by`): approved, changesRequested or rejected
--     (from pending: the first decision wins, D-1; a second finds the story no longer pending),
--     hiddenByModerator (from approved) and shownByModerator (from hidden); changesRequested,
--     rejected and hiddenByModerator carry the moderator's note (`comment`);
--   the system: hiddenBySystem (from approved) when the media fails or changes, shownBySystem
--     (from hidden) when the same media is ready again, fileUnusable (pending, approved or hidden
--     -> editing; reserved for Part 1a, not written yet);
--   history only (no change of state, the pointer stays): fileReplaced and pictureReplaced
--     (written by storyFile_attach when a story that was sent before gets a new file) and
--     wordsChanged (written by story_words_changed, once per round of editing, when its words or
--     themes change); only while the story is being edited.
-- Directly, a person's session creates only its own steps (sent, editStarted) and api-admin only a
-- moderator's; the system's entries and the history-only ones are written by the database's own
-- events (which run elevated, past these permissions), never directly by anyone.
-- The database sets each entry's status, time, who wrote it and, on approval, publishedAt; refuses
-- a step the current status doesn't allow; and moves the pointer, in the same write. No session can
-- move the pointer, or change or delete an entry; entries go only with their story.
-- Everyone (R11; db review 2, section 6 items 3 and 4) may read an entry's story, status and
-- publishedAt only while it is its story's current, approved entry; older entries, comments,
-- names and reasons never. The owner reads their own story's entries, never who wrote them; only
-- api-admin reads `by` and `senderIp`.
-- One exception to "never changed": the nightly housekeeping clears `senderIp` (the IP address a
-- story was sent from, block list) 30 days after the entry, and may read and change nothing
-- else: of the pending entries it sees only those still holding an address that old, and
-- storyStatusLog_append_only
-- refuses any other change.
DEFINE TABLE OVERWRITE storyStatusLog SCHEMAFULL PERMISSIONS        -- id = storyStatusLog:<ulid>
  -- housekeeping, two needs, kept apart by status (only a "sent" entry is pending, and only a
  -- "sent" entry holds senderIp):
  --   G3 B (Joel 2026-11-11): every entry that isn't pending, for its story, status and time, to
  --     find rejected stories and stories left in editing that are due for deletion
  --     (fn::story::deletes_at; a pending story is never due, so it needs none of those);
  --   block list: a pending entry only while it still holds an address 30 days old, so the
  --     chore can pick the ones to clear without reading the address (a field it may not read
  --     is NONE in its WHERE).
  -- Every other field refuses it (who, what was said, the action, the files, publishedAt, the
  -- address).
  FOR select WHERE story.submitter = $auth OR $auth = service:api_admin
    OR (status = 'approved' AND story.currentStatus = id)
    OR ($auth = service:housekeeping AND (status != 'pending'
        OR (senderIp != NONE AND at < fn::story::sender_ips_expire_before()))),
  FOR create WHERE (story.submitter = $auth AND $auth.status != 'deleted'
      AND action IN ['sent', 'editStarted'])
    OR ($auth = service:api_admin AND action IN ['approved', 'changesRequested', 'rejected',
      'hiddenByModerator', 'shownByModerator']),
  FOR update WHERE $auth = service:housekeeping AND at < fn::story::sender_ips_expire_before(),
  FOR delete NONE;
DEFINE FIELD OVERWRITE story        ON storyStatusLog TYPE record<story> READONLY;
-- What happened (the log-entry table of "Story states"). Defined before `status`, which follows
-- from it.
DEFINE FIELD OVERWRITE action       ON storyStatusLog TYPE string READONLY
  ASSERT $value IN ['sent', 'editStarted', 'changesRequested', 'fileUnusable', 'approved',
    'rejected', 'hiddenBySystem', 'shownBySystem', 'hiddenByModerator', 'shownByModerator',
    'fileReplaced', 'pictureReplaced', 'wordsChanged']
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
-- The state the action leaves the story in, set by the database from the action (a history-only
-- entry carries the story's state unchanged); any value a writer gives is ignored.
DEFINE FIELD OVERWRITE status       ON storyStatusLog TYPE string READONLY
  VALUE fn::story::action_status($this.action, $this.story)
  ASSERT $value IN ['editing', 'pending', 'approved', 'hidden', 'rejected'];
-- Who wrote it, set by the database: what the person's page shows ("Moderator", Q6c). System
-- users (the migrator, dev-seed) say it themselves.
DEFINE FIELD OVERWRITE actor        ON storyStatusLog TYPE string READONLY
  VALUE IF $auth = NONE { $value }
    ELSE IF $auth = service:api_admin { 'moderator' }
    ELSE IF record::tb($auth) = 'user' { 'person' }
    ELSE { 'system' }
  ASSERT $value IN ['person', 'moderator', 'system']
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
-- Which person or moderator: the person's own session is the person; api-admin names the
-- moderator (its login is a service); the system has none. api-admin's alone to read, so people
-- never see a moderator's name.
DEFINE FIELD OVERWRITE by           ON storyStatusLog TYPE option<record<user>> READONLY
  VALUE IF $auth = NONE OR $auth = service:api_admin { $value }
    ELSE IF record::tb($auth) = 'user' { $auth }
    ELSE { NONE }
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
-- Which edit of the story this was about: its version when the entry was made (the next
-- "sent" after edits shows they happened). 0 only for a caller who can't read the
-- story, whose write the permissions refuse anyway.
DEFINE FIELD OVERWRITE storyVersion ON storyStatusLog TYPE int READONLY
  VALUE IF $auth = NONE AND $value != NONE { $value } ELSE { $this.story.version ?? 0 }
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
-- The moderator's note to the person (moderator entries only; required on changesRequested,
-- rejected and hiddenByModerator).
DEFINE FIELD OVERWRITE comment      ON storyStatusLog TYPE option<string> READONLY
  ASSERT $value = NONE OR (string::len($value) > 0 AND string::len($value) <= 5000)
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
-- When, set by the database. A system user may supply it (dev-seed's history), never anyone else.
DEFINE FIELD OVERWRITE at           ON storyStatusLog TYPE datetime READONLY
  VALUE IF $auth = NONE AND $value != NONE { $value } ELSE { time::now() }
  PERMISSIONS FOR select WHERE story.submitter = $auth
    OR $auth IN [service:api_admin, service:housekeeping];
-- On approved entries: when the story was first published (the first approval's time, kept on
-- later approvals, after an edit too: "newest first" on the website). A system user may supply
-- the first one (dev-seed's dates).
DEFINE FIELD OVERWRITE publishedAt  ON storyStatusLog TYPE option<datetime> READONLY
  VALUE IF !fn::story::approves($this.action) { NONE }
    ELSE {
      -- Bound first: inside the SELECT, $this is the row being read.
      LET $story = $this.story;
      -- WITH INDEX: left to itself, 3.2.4 picks (status, publishedAt) and reads every approved
      -- entry of every story (local scale test, B2: 18 ms at 5,000 stories, growing with each).
      array::min(SELECT VALUE publishedAt FROM storyStatusLog WITH INDEX storyStatusLog_story
        WHERE story = $story AND status = 'approved' AND publishedAt != NONE)
        ?? (IF $auth = NONE AND $value != NONE { $value } ELSE { $this.at })
    }
  -- Everyone the table lets read the entry, except housekeeping (G3 B: story, status, at only).
  PERMISSIONS FOR select WHERE $auth != service:housekeeping;
-- On the system's hiddenBySystem entries: why (media_unavailable or media_changed; a moderator's
-- own words go in `comment`).
DEFINE FIELD OVERWRITE hiddenReason ON storyStatusLog TYPE option<string> READONLY
  ASSERT $value = NONE OR $value IN ['media_unavailable', 'media_changed']
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
-- On approved entries (R6/R12; db review 2, section 6 item 1): the exact files the story pointed
-- at when it was approved, set by the database. A hidden story comes back without a new review
-- only while it still points at both (fn::story::restorable).
DEFINE FIELD OVERWRITE reviewedMediaFile ON storyStatusLog TYPE option<record<storyFile>> READONLY
  VALUE IF fn::story::approves($this.action) { $this.story.mediaFile }
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
DEFINE FIELD OVERWRITE reviewedImageFile ON storyStatusLog TYPE option<record<storyFile>> READONLY
  VALUE IF fn::story::approves($this.action) { $this.story.image.file }
  PERMISSIONS FOR select WHERE story.submitter = $auth OR $auth = service:api_admin;
-- On a moderator's approved entry: true when an Admin approved while the media wait (the
-- upload cooldown or an open media job, fn::story::approval_wait) would have refused it (Joel,
-- 2026-11-07: decision 5 and J6, "an Admin may skip both; the approval records that it did").
-- Roles live in Clerk (D1), so api-admin sets it, only for an Admin (as it names the
-- moderator in `by`); the database refuses it on any other entry, or when there was nothing to
-- skip, so it is true exactly when the wait was skipped. api-admin's alone to read.
DEFINE FIELD OVERWRITE skippedMediaWait ON storyStatusLog TYPE option<bool> READONLY
  ASSERT $value = NONE OR $value = true
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
-- On a person's "sent" entry (pending): the IP address the story was sent from (block list,
-- G21 D; Joel 2026-11-11), so an Admin can block a recent abuser's address. api-user supplies it
-- (the client address Cloud Run passes, docs/how-the-app-works.md); kept only on the person's own
-- "sent" entries (anything else is dropped), lower-case. api-admin's alone to read (Admins only:
-- api-admin shows it to an Admin, never a Moderator). The nightly housekeeping clears it 30 days
-- after the entry (fn::story::sender_ips_expire_before). Goes with the story, like the entry.
DEFINE FIELD OVERWRITE senderIp     ON storyStatusLog TYPE option<string>
  VALUE IF $auth = NONE OR (record::tb($auth) = 'user' AND $this.action = 'sent'
    AND $this.actor = 'person') { $value }
  ASSERT $value = NONE OR (string::len($value) <= 45 AND string::is_ip($value)
    AND $value = string::lowercase($value))
  PERMISSIONS FOR select WHERE $auth = service:api_admin;
-- Public lists, newest or oldest first (db review 2, section 6 items 5 and 6).
DEFINE INDEX OVERWRITE storyStatusLog_published ON storyStatusLog FIELDS status, publishedAt;
-- The moderators' queue (pending, oldest first; M3).
DEFINE INDEX OVERWRITE storyStatusLog_queue     ON storyStatusLog FIELDS status, at;
-- One story's log, in order.
DEFINE INDEX OVERWRITE storyStatusLog_story     ON storyStatusLog FIELDS story, at;
-- Adding an entry checks the step and moves the pointer in the same write (db review 2, section 6
-- item 2); a history-only entry leaves it. Every entry bumps the story's owner's fence
-- (fn::person::live), as every write to the story, to its files (storyFile_fence) and its erasure
-- do, so two steps at once (two moderators deciding, D-1), or a step racing erasure or a file's
-- processing, can't both commit: the second conflicts, and its retry checks again from scratch
-- (and finds the story decided). The moved pointer is a story write, so the story's own events
-- check it too: the shape and the text and theme limits on sending, the weekly limit on a first
-- send, the agreements on the person's writes, and the media and testimony consent on approval.
DEFINE EVENT OVERWRITE storyStatusLog_step ON storyStatusLog
  WHEN $event = 'CREATE'
  THEN {
    LET $s = (SELECT * FROM ONLY $after.story);
    IF $s = NONE { THROW 'a status entry needs an existing story' };
    fn::person::live($s.submitter);
    LET $from = fn::story::status_of($s);
    LET $action = $after.action;
    LET $history = fn::story::history_only($action);
    IF !fn::story::step_allowed($after.actor, $action, $from) {
      THROW 'status_step: a ' + $after.actor + ' can’t ' + $action + ' a story that is ' + $from;
    };
    IF $after.actor != 'moderator' AND $after.comment != NONE {
      THROW 'status_step: only a moderator’s entry has a comment';
    };
    IF $action IN ['changesRequested', 'rejected', 'hiddenByModerator'] AND $after.comment = NONE {
      THROW 'status_step: ' + $action + ' needs the moderator’s note';
    };
    IF $after.actor = 'moderator' AND $after.by = NONE {
      THROW 'status_step: a moderator’s entry names the moderator (by)';
    };
    IF ($after.hiddenReason != NONE) != ($action = 'hiddenBySystem') {
      THROW 'status_step: the system’s hidden entry, and only it, has a reason';
    };
    -- A moderator's approval waits for the media (decision 5, J6): refused while
    -- fn::story::approval_wait says so, unless an Admin skips it (skippedMediaWait). System
    -- users (the migrator, dev-seed) load approved stories as given.
    LET $wait = IF $action IN ['approved', 'shownByModerator'] AND $auth != NONE {
      fn::story::approval_wait($s, time::now())
    };
    IF $after.skippedMediaWait = true AND $wait = NONE {
      THROW 'status_step: skippedMediaWait is only for a moderator’s approval that the media wait would refuse';
    };
    IF $wait != NONE AND $after.skippedMediaWait != true { THROW $wait };
    -- Shown again: by the system only with the files that were reviewed, ready; a moderator's
    -- "show again" is their review of what the story shows now (its approval checks still run,
    -- on the moved pointer, and the entry records the files it shows), so a hidden story with
    -- other files comes back only that way.
    IF $action = 'shownBySystem' AND !fn::story::restorable($s) {
      THROW 'story_not_restorable: a hidden story comes back only with the files that were reviewed, ready';
    };
    IF !$history { UPDATE $s.id SET currentStatus = $after.id RETURN NONE };
  };

-- Append-only, for system users too: an entry goes only with its story (the erasure cascade).
-- The one change allowed is clearing senderIp, and nothing else with it.
DEFINE EVENT OVERWRITE storyStatusLog_append_only ON storyStatusLog
  WHEN ($event = 'UPDATE' AND !($before.senderIp != NONE AND $after.senderIp = NONE
      AND object::remove($before, 'senderIp') = object::remove($after, 'senderIp')))
    OR ($event = 'DELETE' AND record::exists($before.story))
  THEN { THROW 'a story’s status log is append-only: entries go only with their story' };
-- Block list (Joel 2026-11-11): the IP address a story was sent from is kept 30 days; entries
-- older than this have it cleared by the nightly housekeeping (and api-admin shows none older).
DEFINE FUNCTION OVERWRITE fn::story::sender_ips_expire_before() {
  RETURN time::now() - 30d;
};

-- For api-admin (someone chases Bunny): stories the system hid because of their files, oldest
-- first. problem = what's still not ready; mediaChanged = the files differ from the reviewed ones,
-- so it needs a moderator rather than Bunny. A hidden story whose files are fine (its uploader has
-- no testimony consent) isn't listed, nor one a moderator hid. Runs with the caller's permissions
-- (api-admin reads the status log, the stories and their files).
DEFINE FUNCTION OVERWRITE fn::story::hidden_by_media() {
  LET $hidden = (SELECT VALUE story FROM storyStatusLog
    WHERE action = 'hiddenBySystem' AND story.currentStatus = id ORDER BY at ASC);
  RETURN $hidden.map(|$id| {
    LET $s = (SELECT * FROM ONLY $id);
    RETURN { id: $s.id, slug: $s.slug, title: $s.title, primaryFormat: $s.primaryFormat,
      hiddenSince: $s.currentStatus.at, problem: fn::story::approval_problem($s),
      mediaChanged: !fn::story::shows_reviewed_files($s) };
  }).filter(|$r| $r.problem != NONE OR $r.mediaChanged);
};

-- ---------------------------------------------------------------- draft retention (D71)
-- D71: an untouched draft (never sent) is deleted after 6 months (186 days: a month counted as 31 days). It was
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
-- signed for it again (storyFile.renewedAt, a resume). NONE if it isn't a draft. The one rule:
-- housekeeping deletes by it (draft_expired) and the profile shows it (api-user's
-- StoryMine.deletesAt, R5). The owner's session reads its own files.
DEFINE FUNCTION OVERWRITE fn::story::draft_expires_at($story: record<story>) {
  LET $s = (SELECT currentStatus, updatedAt FROM ONLY $story);
  IF $s = NONE OR $s.currentStatus != NONE { RETURN NONE };
  LET $renewed = array::max(SELECT VALUE renewedAt FROM storyFile
    WHERE story = $story AND renewedAt != NONE);
  LET $last = IF $renewed != NONE AND $renewed > $s.updatedAt { $renewed } ELSE { $s.updatedAt };
  RETURN $last + fn::story::draft_retention();
};
-- G3 B (Joel, 2026-11-11, "More M3 answers"): when the nightly housekeeping deletes `$story`, or
-- NONE if it never does. One rule, which housekeeping deletes by (deletion_due) and the person
-- sees on My submissions (api-user's StoryMine.deletesAt):
--   a draft (never sent): fn::story::draft_expires_at (D71: 186 days after it was last touched);
--   rejected: the settings' rejectedRetentionDays (90) after its rejection (its status entry's
--     time; it can't change after that);
--   editing after being sent at least once (sent back, its file unusable, or taken down to edit):
--     the settings' editingRetentionDays (186) after it was last touched, by the drafts' clock
--     (the later of its last write, updatedAt, which moving it to editing also sets, and the last
--     upload link signed for it again);
--   pending, approved or hidden: never.
-- The settings in force now: changing them moves every date at once.
DEFINE FUNCTION OVERWRITE fn::story::deletes_at($story: record<story>) {
  LET $s = (SELECT currentStatus, currentStatus.status AS status, currentStatus.at AS at,
    updatedAt FROM ONLY $story);
  IF $s = NONE { RETURN NONE };
  IF $s.currentStatus = NONE { RETURN fn::story::draft_expires_at($story) };
  LET $set = fn::settings::submission();
  IF $s.status = 'rejected' {
    RETURN $s.at + type::duration(string::concat($set.rejectedRetentionDays, 'd'));
  };
  IF $s.status != 'editing' { RETURN NONE };
  LET $renewed = array::max(SELECT VALUE renewedAt FROM storyFile
    WHERE story = $story AND renewedAt != NONE);
  LET $last = IF $renewed != NONE AND $renewed > $s.updatedAt { $renewed } ELSE { $s.updatedAt };
  RETURN $last + type::duration(string::concat($set.editingRetentionDays, 'd'));
};
-- G3 B: whether `$story` is past fn::story::deletes_at. story FOR delete (housekeeping) and the
-- chores ask this. Both writes fence the person, so an edit or resume racing the delete
-- conflicts and one of them loses.
DEFINE FUNCTION OVERWRITE fn::story::deletion_due($story: record<story>) {
  LET $at = fn::story::deletes_at($story);
  RETURN $at != NONE AND $at < time::now();
};
-- D71: whether `$story` is a draft past fn::story::draft_expires_at, i.e. nobody has touched it
-- since fn::story::drafts_expire_before(). story FOR delete (housekeeping) and the chore both
-- ask this. Both writes fence the person (story_fence, storyFile_fence), so a resume racing
-- the delete conflicts and one of them loses.
DEFINE FUNCTION OVERWRITE fn::story::draft_expired($story: record<story>) {
  LET $at = fn::story::draft_expires_at($story);
  RETURN $at != NONE AND $at < time::now();
};


-- ---------------------------------------------------------------- storyFile (R12; D65, D80, D113)
-- One row per file uploaded for a story (R12, Joel 2026-11-05): a video or
-- audio file api-user created at Bunny Stream (RequestUpload, M2 plan PR 7; id =
-- storyFile:<bunnyVideoId>), or a picture in the images storage zone (M2 plan PR 10; id =
-- storyFile:`stories/<story id>/<random>.webp`, its path, which api-user picks, D80). So a file
-- belongs to one story. The story points at its current files (story.mediaFile, story.image.file:
-- the permission slip, story_files); the row holds what is known about the file.
-- Only api-user's own login creates a row, after creating the video itself (title = the story
-- id, D69) or picking the picture's path; its event checks the draft and the person's upload
-- limits and points the draft at the file in the same write (D80: the browser never names a
-- file, and a person's session never writes the pointers). The upload links stay as they were:
-- a TUS link for one video until it expires, a single-use presigned PUT for one picture.
-- Also the per-person record of uploads (D113, Joel 2026-10-28: the limits must hold when stories
-- or videos are deleted): rows stay when a file is replaced or a story deleted, so the hourly and
-- weekly counts stay honest. Person-linked: erasure deletes them all. The person reads their own
-- (the limits page, the submit checks, "download my data").
-- Replaced files are tracked until they are really gone (R12; db review 2, section 6 item 7):
-- when a story stops pointing at a file, its row gets detachedAt (story_files); the nightly
-- housekeeping deletes the file at Bunny or in the images zone once no upload link for it can
-- still be used (fn::upload::links_expire_after), then sets removedAt. A row detached but not
-- removed a day or two later means the clean-up is failing. housekeeping deletes a row once it no
-- longer counts towards the limits (7 days) and its file is removed or its story gone (a deleted
-- story's files go as before: api-user's delete at Bunny, the orphan sweep and pendingDeletion).
-- Fields: storyVersion: the `If-Match` the command was given: the event refuses another (412).
-- sizeBytes / durationSeconds: what the browser declared (the TUS link binds neither, D68); the
-- limits are checked on them here and again at submit, with Bunny's own length once it has one.
-- width/height: a picture's real size (D53, 1:3..3:1), from the person's browser; a video's (and
-- an audio file's thumbnail's) from processing. lengthSeconds, thumbnailPath, processing:
-- processing's (workflow, M7; A2). renewedAt: when api-user last signed a link for it again (a
-- resume, or a replayed request; fn::upload::renew). It counts as touching the draft (D71).
-- expectedImage: the path of the picture the person's page showed when they chose theirs (NONE:
-- none). The event refuses the row (image_changed) if the story's picture is another one by
-- then, whatever its version: a picture another tab put on (or took off) is replaced only when
-- the person chooses to, never by a request the page rebased onto a newer version (Codex #140 r3).
-- Everyone reads the published fields (format, width, height, lengthSeconds, thumbnailPath, and
-- the id: the Bunny video id or the picture's path) of a file an approved story points at now
-- (R12; db review 2, section 6 item 4); the rest only the person and the services.
DEFINE TABLE OVERWRITE storyFile SCHEMAFULL PERMISSIONS
  FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping]
    OR (story.currentStatus.status = 'approved' AND (story.mediaFile = id OR story.image.file = id)),
  -- api-user: a person's upload (storyFile_attach). workflow: an audio file's picture video
  -- (renderOf, storyFile_render; Joel, 2026-11-07, audio-picture-video decision 1B).
  FOR create WHERE $auth = service:api_user OR ($auth = service:workflow AND renderOf != NONE),
  FOR update WHERE $auth IN [service:api_user, service:workflow, service:housekeeping],
  FOR delete WHERE $auth = service:api_user                          -- erasure
    -- The nightly clean-up: a row that no longer counts towards the limits, once its file is
    -- removed or its story is gone.
    OR ($auth = service:housekeeping AND at <= time::now() - 7d
        AND (removedAt != NONE OR !record::exists(story)));
DEFINE FIELD OVERWRITE story           ON storyFile TYPE record<story> READONLY
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE person          ON storyFile TYPE record<user> READONLY
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE format          ON storyFile TYPE string READONLY
  ASSERT $value IN ['video', 'audio', 'image'];
DEFINE FIELD OVERWRITE contentType     ON storyFile TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 100
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE sizeBytes       ON storyFile TYPE int READONLY ASSERT $value > 0
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE durationSeconds ON storyFile TYPE option<int> READONLY
  ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE expectedImage   ON storyFile TYPE option<string> READONLY   -- pictures
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE storyVersion    ON storyFile TYPE int READONLY
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
-- A picture's size is the person's browser's, never changed; a video's comes from processing.
DEFINE FIELD OVERWRITE width           ON storyFile TYPE option<int> ASSERT $value = NONE OR $value > 0
  VALUE IF $auth = service:workflow AND $this.format = 'image' { $before } ELSE { $value }
  PERMISSIONS FOR update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE height          ON storyFile TYPE option<int> ASSERT $value = NONE OR $value > 0
  VALUE IF $auth = service:workflow AND $this.format = 'image' { $before } ELSE { $value }
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- Bunny's real length (cards show it, M1 step 6a; the approval gate means a published clip has
-- it) and the thumbnail's path at Bunny (D53/D60: Bunny's generated frame, or for audio the
-- picture shown for it, Joel 2026-10-24).
DEFINE FIELD OVERWRITE lengthSeconds   ON storyFile TYPE option<int> ASSERT $value = NONE OR $value > 0
  PERMISSIONS FOR create, update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE thumbnailPath   ON storyFile TYPE option<string>
  PERMISSIONS FOR create, update WHERE $auth = service:workflow;
-- A2: NONE = not processed yet (just uploaded); then 'processing', 'ready' or 'failed'. Only
-- 'ready' can be approved and published (fn::story::approval_problem). Workflow writes it (M7).
-- A picture is also marked 'ready' by api-user's login, only as part of submitting (Joel,
-- 2026-10-30, m2-remaining-decisions R3 = A; m2-media-ready-plan D128 B): its 40-byte check at
-- submit found the file there, of its recorded size, a WebP of its recorded width and height,
-- with no hidden metadata or animation. storyFile_update holds api-user to that one step.
DEFINE FIELD OVERWRITE processing      ON storyFile TYPE option<string>
  ASSERT $value = NONE OR $value IN ['processing', 'ready', 'failed']
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create WHERE $auth = service:workflow,
    FOR update WHERE $auth = service:workflow
      OR ($auth = service:api_user AND format = 'image');
-- Media ready (Joel, 2026-11-07, F1 and media-worker-final section 3): the time the newest answer
-- the result writer applied reached the writer (the writer's clock, taken when the worker's call
-- arrives). The writer applies an answer only if it arrived later, in the same transaction that
-- writes it, so an older answer can't undo a newer one. Like processing: only workflow writes it,
-- and it isn't public.
DEFINE FIELD OVERWRITE checkedAt       ON storyFile TYPE option<datetime>
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create, update WHERE $auth = service:workflow;
-- The server time. Only a system user ($auth = NONE: the migrator, dev-seed, the scale test) may
-- supply another, for dummy data and tests.
DEFINE FIELD OVERWRITE at              ON storyFile TYPE datetime READONLY
  VALUE IF $auth = NONE AND $value != NONE { $value } ELSE { $before OR time::now() }
  PERMISSIONS FOR select WHERE person = $auth
    OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping];
DEFINE FIELD OVERWRITE renewedAt       ON storyFile TYPE option<datetime>   -- server time only
  VALUE IF $value = NONE OR $value = $before { $before } ELSE { time::now() }
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create NONE, FOR update WHERE $auth = service:api_user;
-- Audio picture video (Joel, 2026-11-07, audio-picture-video decision 1B): on a picture video the
-- result writer made of an audio file (a new Bunny video), the file whose sound it holds. Only
-- workflow sets it, when it makes the row (storyFile_render); never changed. Such a row isn't the
-- person's upload, so the upload limits skip it.
DEFINE FIELD OVERWRITE renderOf        ON storyFile TYPE option<record<storyFile>> READONLY
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create WHERE $auth = service:workflow, FOR update NONE;
-- The picture Bunny shows for this video or audio file (Joel: video-bundle-rethink part A,
-- 2026-11-06; audio-picture-video 1B, 2026-11-07): a picture row of the same story, or NONE
-- (Bunny's own frame for a video; the site's default background for a picture video). Set by the
-- result writer once Bunny has it: a video's thumbnail it set at Bunny, or the picture a picture
-- video was made with. Approval needs it to be the story's picture now (approval_problem).
DEFINE FIELD OVERWRITE thumbnailOf     ON storyFile TYPE option<record<storyFile>>
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create, update WHERE $auth = service:workflow;
-- T3 (Joel, 2026-11-08, org-setup-and-picture-video.html): the lock a result writer holds on a
-- video's row while it changes the video's picture at Bunny, so only one writer at a time does:
-- until when it is held (the database's clock, now + 2 minutes; Codex r5). Three states (T4 = A,
-- Joel, 2026-11-09):
-- - NONE: Bunny confirmed the picture (thumbnailOf);
-- - in the future: a writer is at work; other writers try again later;
-- - in the past: unfinished (the writer failed, timed out or crashed), so Bunny may show another
--   picture; any writer may take it over and finish.
-- The writer takes it only if it is NONE or past, and empties it with thumbnailOf only if it still
-- holds this exact value (the holder's mark) and it hasn't run out. Nothing else empties it while
-- its story shows the video (a job giving up doesn't). A moderator's approval waits while it is
-- set at all (fn::story::approval_wait). The nightly housekeeping opens a check of any video
-- left unfinished, so it is retried rather than stuck. Only workflow writes it; housekeeping
-- reads it for that re-check; nobody else sees it.
DEFINE FIELD OVERWRITE thumbnailLockedUntil ON storyFile TYPE option<datetime>
  PERMISSIONS FOR select WHERE $auth IN [service:workflow, service:housekeeping],
    FOR create, update WHERE $auth = service:workflow;
-- When its story stopped pointing at it: set by story_files only (events run elevated).
DEFINE FIELD OVERWRITE detachedAt      ON storyFile TYPE option<datetime>
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create, update NONE;
-- When housekeeping deleted the file (server time; once): see storyFile_update.
DEFINE FIELD OVERWRITE removedAt       ON storyFile TYPE option<datetime>
  VALUE IF $auth = NONE { $value } ELSE IF $before != NONE { $before }
    ELSE IF $value != NONE { time::now() }
  PERMISSIONS FOR select WHERE person = $auth
      OR $auth IN [service:api_user, service:api_admin, service:workflow, service:housekeeping],
    FOR create NONE, FOR update WHERE $auth = service:housekeeping;
DEFINE INDEX OVERWRITE storyFile_person   ON storyFile FIELDS person, at;
DEFINE INDEX OVERWRITE storyFile_story    ON storyFile FIELDS story;
-- The clean-up's list, and the check that it is keeping up (R12).
DEFINE INDEX OVERWRITE storyFile_detached ON storyFile FIELDS detachedAt;
-- How long after its story stops pointing at a file an upload link for it may still be used: a
-- TUS link lives an hour (api-user's UPLOAD_LINK_SECONDS) and a picture's PUT 10 minutes
-- (IMAGE_LINK_SECONDS), with room for one signed just before. No new link is signed for a file
-- its story no longer shows (storyFile_update, and api-user's replay checks). The clean-up
-- deletes a detached file only after this (removedAt).
DEFINE FUNCTION OVERWRITE fn::upload::links_expire_after() {
  RETURN 2h;
};
-- How long one upload link for a file of `$format` lasts once signed (D68): a video or audio
-- file's TUS link an hour, a picture's PUT 10 minutes. The one place these lengths live:
-- api-user's UPLOAD_LINK_SECONDS and IMAGE_LINK_SECONDS must match (their comments point here).
-- A file can be replaced through its link until then, so a moderator waits for it before
-- approving (fn::story::approval_wait).
DEFINE FUNCTION OVERWRITE fn::upload::link_lifetime($format: string) {
  RETURN IF $format = 'image' { 10m } ELSE { 1h };
};
-- When the person may next start an upload of `$format` ('video', 'audio' or 'image'): NONE if
-- now, else when the hourly count (every file) or, for a video or audio file, the weekly count
-- (video and audio files only) frees a place (the later of the two). Their own session reads
-- their own rows.
DEFINE FUNCTION OVERWRITE fn::upload::next_allowed_at($user: option<record<user>>, $format: string) {
  IF $user = NONE { RETURN NONE };
  LET $l = fn::limits::effective($user);
  LET $files = (SELECT at, format FROM storyFile
    WHERE person = $user AND at > time::now() - 7d AND renderOf = NONE ORDER BY at ASC);
  LET $hour = $files.filter(|$g| $g.at > time::now() - 1h).map(|$g| $g.at);
  LET $week = $files.filter(|$g| $g.format != 'image').map(|$g| $g.at);
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
-- RequestUpload's write (api-user's login; system users load rows as given): the story must be the
-- person's and editable at the version they saw, they must have agreed to the latest terms of use
-- and testimony consent (plan 4e, Q2: an upload is the person's write, made for them), and the file
-- must be within the limits; then the story points at it (D80), and story_files detaches the
-- file it replaces. The story's version steps once, to storyVersion + 1.
-- A picture's description comes with RequestUpload but isn't a fact about the file (R12: it stays
-- on the story, where the person may change it), so api-user passes it to this write as the
-- query parameter $imageAlt.
DEFINE EVENT OVERWRITE storyFile_attach ON storyFile
  WHEN $event = 'CREATE' AND $auth != NONE AND $after.renderOf = NONE THEN {
    fn::person::live($after.person);
    LET $s = (SELECT * FROM ONLY $after.story);
    IF $s = NONE OR $s.submitter != $after.person {
      THROW 'upload_refused: the story isn’t this person’s';
    };
    IF $s.version != $after.storyVersion { THROW 'story_cmd:stale_version' };
    IF fn::story::status_of($s) != 'editing' { THROW 'story_cmd:locked' };
    fn::legal::require_testimony($after.person);
    LET $l = fn::limits::effective($after.person);
    IF $after.format = 'image' {
      -- A written story's image, an audio story's picture or a video's own thumbnail, in the
      -- story's own folder, named by api-user (a 32-hex random name), a WebP of a size and
      -- shape we take (D53).
      IF !fn::media::own_image($s.id, record::id($after.id)) {
        THROW 'upload_refused: an image goes in its story’s own folder, under a name api-user picks';
      };
      IF $after.contentType != 'image/webp' { THROW 'upload_refused: an image is a WebP' };
      IF (IF $s.image != NONE { record::id($s.image.file) }) != $after.expectedImage {
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
      IF $after.width != NONE OR $after.height != NONE {
        THROW 'upload_refused: a video’s or audio file’s size comes from processing';
      };
      IF $after.sizeBytes > (IF $after.format = 'video' { $l.videoMaxBytes } ELSE { $l.audioMaxBytes }) {
        THROW 'limit_upload_size: the file is bigger than the person may upload (D113)';
      };
      IF $after.durationSeconds != NONE AND $after.durationSeconds > $l.mediaMaxSeconds {
        THROW 'limit_upload_duration: the file is longer than the person may upload (D113)';
      };
    };
    -- Counted without this row; the fence above makes two overlapping uploads conflict. Every
    -- file counts per hour; only video and audio files per 7 days (Joel, 2026-10-30).
    LET $files = (SELECT at, format FROM storyFile
      WHERE person = $after.person AND id != $after.id AND at > time::now() - 7d
        AND renderOf = NONE);
    IF array::len($files.filter(|$g| $g.at > time::now() - 1h)) >= $l.uploadRequestsPerHour {
      THROW 'limit_upload_hourly: the person has started as many uploads as they may in an hour (D113)';
    };
    IF $after.format != 'image' AND $l.uploadsPer7Days != NONE
      AND array::len($files.filter(|$g| $g.format != 'image')) >= $l.uploadsPer7Days {
      THROW 'limit_upload_weekly: the person has started as many uploads as they may in 7 days (D113)';
    };
    IF $after.format = 'image' {
      UPDATE $after.story SET image = { file: $after.id,
        alt: IF fn::text::trimmed_length($imageAlt) = 0 { NONE } ELSE { string::trim($imageAlt) } }
        RETURN NONE;
    } ELSE {
      UPDATE $after.story SET mediaFile = $after.id RETURN NONE;
    };
    -- The story's history (Story states, Joel 2026-11-11): a new video, audio file or picture on
    -- a story that was sent before (history only: the state stays editing).
    IF (SELECT VALUE id FROM storyStatusLog WITH INDEX storyStatusLog_story
        WHERE story = $s.id AND action = 'sent' LIMIT 1) != [] {
      CREATE type::record('storyStatusLog', rand::ulid()) CONTENT { story: $s.id,
        action: IF $after.format = 'image' { 'pictureReplaced' } ELSE { 'fileReplaced' } } RETURN NONE;
    };
  };
-- Whoever writes (system users too): a picture's path is always its story's own folder's
-- (fn::media::own_image), so nothing that signs or deletes a story's picture (its owner's link,
-- erasure, housekeeping) can be pointed at another story's file. The one exception is dev-seed's
-- own fixed files, `dev-seed/<name>.webp`, which only a system user can add. And a file's pixel
-- size: both or neither, no taller than 1:3 or wider than 3:1 (D53).
DEFINE EVENT OVERWRITE storyFile_shape ON storyFile
  WHEN $event IN ['CREATE', 'UPDATE'] THEN {
    IF $event = 'CREATE' AND $after.format = 'image'
      AND !fn::media::own_image($after.story, record::id($after.id))
      AND !($auth = NONE AND string::matches(<string> record::id($after.id), '^dev-seed/[a-z0-9-]{1,64}[.]webp$')) {
      THROW 'upload_refused: an image goes in its story’s own folder, under a name api-user picks';
    };
    IF ($after.width = NONE) != ($after.height = NONE) {
      THROW 'a file needs both width and height, or neither';
    };
    IF $after.width != NONE AND !fn::shape::allowed($after.width, $after.height) {
      THROW IF $after.format = 'image' { 'an image’s shape is beyond 1:3 or 3:1' }
        ELSE { 'a video’s or audio thumbnail’s shape is beyond 1:3 or 3:1' };
    };
  };
-- Audio picture video (Joel, 2026-11-07, audio-picture-video decision 1B), whoever writes: a row
-- with renderOf is a picture video of an audio file of the same story and person, made only by
-- workflow (or a system user loading data); and a file's thumbnailOf is always a picture of its
-- own story.
DEFINE EVENT OVERWRITE storyFile_render ON storyFile
  WHEN $event IN ['CREATE', 'UPDATE'] THEN {
    IF $event = 'CREATE' AND $after.renderOf != NONE {
      IF $auth != NONE AND $auth != service:workflow {
        THROW 'upload_refused: only the result writer makes a picture video';
      };
      LET $src = (SELECT story, person, format FROM ONLY $after.renderOf);
      IF $src = NONE OR $src.story != $after.story OR $src.person != $after.person
        OR $src.format != 'audio' OR $after.format != 'audio' {
        THROW 'upload_refused: a picture video is made of an audio file of the same story';
      };
    };
    IF $after.thumbnailOf != NONE AND $after.thumbnailOf != $before.thumbnailOf {
      LET $pic = (SELECT story, format FROM ONLY $after.thumbnailOf);
      IF $pic = NONE OR $pic.story != $after.story OR $pic.format != 'image'
        OR $after.format = 'image' {
        THROW 'a video’s or audio file’s thumbnailOf is a picture of its own story';
      };
    };
  };
-- Db review 2, section 6 item 2: every write to a story's file rows bumps its owner's fence, as
-- every status entry, story write and erasure do, so a file's processing racing an approval (or
-- a resume racing a draft's deletion) can't both commit: the second conflicts and its retry
-- checks again from scratch. Erasure's delete: no live check.
DEFINE EVENT OVERWRITE storyFile_fence ON storyFile
  WHEN true THEN {
    IF $event = 'DELETE' { fn::fence::touch('person', $before.person) }
    ELSE { fn::person::live($after.person) };
  };
-- After a change to a file:
-- - a resume (renewedAt, D71): the link is signed again only if this commits. The story must
--   still be the person's, editable and showing this file, and the person must have the latest
--   terms of use and testimony consent, as for a new upload (plan 4e, Q2). The fence makes it
--   conflict with a draft's deletion (story_fence), so housekeeping never deletes a draft whose
--   link was just signed, and a resume never signs a link for a draft that was just deleted;
-- - removed (removedAt, housekeeping): only a detached file, once no upload link for it can
--   still be used, and only once;
-- - processing (workflow): a story showing the file is hidden or shown again
--   (fn::story::check_files), and its version steps (D29: the owner's ETag and If-Match) when
--   something its owner's story shows changed (fn::story::file_view): once, so not again if
--   that write already hid it or showed it again. As before R12, when processing wrote the story.
-- - processing (api-user, the picture check at submit; Joel, 2026-10-30, R3 = A): only 'ready',
--   only on a picture not marked yet, only the one the person's story being edited shows now. It doesn't step the version: the owner's story never shows a picture's
--   processing, and the submit that follows is still at the version the person's page sent.
DEFINE FUNCTION OVERWRITE fn::story::file_view($f: any) {
  RETURN $f.{ format, thumbnailPath, width, height, lengthSeconds, processing };
};
DEFINE EVENT OVERWRITE storyFile_update ON storyFile
  WHEN $event = 'UPDATE' THEN {
    LET $s = (SELECT * FROM ONLY $after.story);
    IF $after.renewedAt != $before.renewedAt {
      IF $s = NONE OR $s.submitter != $after.person OR $s.mediaFile != $after.id {
        THROW 'nothing_to_resume: the story is gone or no longer shows this file';
      };
      IF fn::story::status_of($s) != 'editing' { THROW 'story_cmd:locked' };
      fn::legal::require_testimony($after.person);
    };
    IF $auth = service:api_user AND $after.processing != $before.processing
      AND ($after.format != 'image' OR $before.processing != NONE OR $after.processing != 'ready'
        OR $s = NONE OR $s.image.file != $after.id OR $after.detachedAt != NONE
        OR fn::story::status_of($s) != 'editing') {
      THROW 'picture_check: api-user only marks the picture a story being edited shows now as checked, at submit';
    };
    IF $after.removedAt != $before.removedAt AND $auth != NONE
      AND ($before.removedAt != NONE OR $after.detachedAt = NONE
        OR $after.detachedAt > time::now() - fn::upload::links_expire_after()) {
      THROW 'file_not_removable: only a file its story stopped showing, once no upload link for it can be used';
    };
    IF $s != NONE AND $after.detachedAt = NONE
      AND ($s.mediaFile = $after.id OR $s.image.file = $after.id) {
      fn::story::check_files($s);
      IF fn::story::file_view($before) != fn::story::file_view($after)
        AND $auth != service:api_user
        AND (SELECT VALUE version FROM ONLY $s.id) = $s.version {
        UPDATE $s.id RETURN NONE;
      };
    };
  };
-- api-user's login, before it signs a link for `$video` again: renews the row (above). NONE if
-- there is no such file for this person's story.
DEFINE FUNCTION OVERWRITE fn::upload::renew($story: record<story>, $person: record<user>, $video: string) {
  RETURN (UPDATE type::record('storyFile', $video) SET renewedAt = time::now()
    WHERE story = $story AND person = $person RETURN VALUE renewedAt)[0];
};

-- ---------------------------------------------------------------- mediaJob (media ready; J1-J6)
-- Every media job, written down before it is sent to Google's queue (media-jobs), so none is ever
-- lost (Joel, 2026-11-07: media-job-table.html J1, media-worker-final.html section 3). The queue is
-- only the delivery route: the worker answers through the result writer (apps/workflow), which
-- records the answer and the job's end in one transaction. One row per piece of work:
-- - file: the story file the job is about (a Bunny video or audio file). Its row going (erasure,
--   housekeeping's tidy-up) takes its jobs with it (storyFile_jobs), so a job never outlives the
--   person's data.
-- - kind: 'check' (is the media ready at Bunny?) or 'render' (an audio story's picture video,
--   made from the job's file; madeFile is the new Bunny video, so a retry reuses it).
-- - reasons: why it exists ('rendered': the check of a picture video the writer just made). At
--   most one open job per file and kind (J1 check a): a new reason for
--   an open job is added to it (fn::media::queue_job), never a second row.
-- - queuedAt: when it was first written; sentAt and sends: when it last went to the queue and how
--   often (the first send and later resends).
-- - failures and lastError: how often the worker reported it failed, and the last reason as a
--   short code (never file contents or personal details). At 5 failures it ends as gave_up (J4:
--   the table replaces dead letters).
-- - doneAt and outcome: set once, when it ends: applied (the answer was saved), stale (a newer
--   answer was already in), gone (the file or story was deleted) or gave_up.
-- Services only (no person's session sees it): api-user and workflow create jobs, housekeeping only
-- the nightly re-check of a video whose picture at Bunny is unfinished (T4: a check, reason
-- resent); api-user records its sends and new reasons, housekeeping its resends; only workflow
-- ends a job. Housekeeping
-- deletes done jobs 30 days after they ended (J2). Person-linked through its file: every write
-- needs the person to exist and not be erased, and bumps their fence, so it conflicts with an
-- erasure that overlaps it (docs/db-permissions.md, "Person-linked tables").
DEFINE TABLE OVERWRITE mediaJob SCHEMAFULL PERMISSIONS          -- id = mediaJob:<ulid>
  FOR select WHERE $auth IN [service:api_user, service:workflow, service:housekeeping],
  FOR create WHERE $auth IN [service:api_user, service:workflow]
    OR ($auth = service:housekeeping AND kind = 'check' AND reasons = ['resent']),
  FOR update WHERE $auth IN [service:api_user, service:workflow, service:housekeeping],
  FOR delete WHERE $auth = service:housekeeping AND doneAt != NONE AND doneAt <= time::now() - 30d;
DEFINE FIELD OVERWRITE file       ON mediaJob TYPE record<storyFile> READONLY;
DEFINE FIELD OVERWRITE kind       ON mediaJob TYPE string READONLY
  ASSERT $value IN ['check', 'render'];
DEFINE FIELD OVERWRITE reasons    ON mediaJob TYPE array<string>
  ASSERT array::len($value) > 0 AND $value.all(|$r| $r IN ['bunny_finished', 'bunny_failed',
    'bunny_deleted', 'submitted', 'picture_changed', 'resent', 'rendered']);
DEFINE FIELD OVERWRITE queuedAt   ON mediaJob TYPE datetime READONLY
  VALUE $before OR time::now();
DEFINE FIELD OVERWRITE sentAt     ON mediaJob TYPE option<datetime>;
-- Both start at 0 whoever creates the job.
DEFINE FIELD OVERWRITE sends      ON mediaJob TYPE int ASSERT $value >= 0
  VALUE IF $before = NONE { 0 } ELSE { $value };
DEFINE FIELD OVERWRITE failures   ON mediaJob TYPE int ASSERT $value >= 0
  VALUE IF $before = NONE { 0 } ELSE { $value }
  PERMISSIONS FOR update WHERE $auth = service:workflow;
-- A short code, e.g. bunny_unreachable: nothing else fits.
DEFINE FIELD OVERWRITE lastError  ON mediaJob TYPE option<string>
  ASSERT $value = NONE OR string::matches($value, '^[a-z][a-z0-9_]{0,63}$')
  PERMISSIONS FOR create, update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE madeFile   ON mediaJob TYPE option<record<storyFile>>
  PERMISSIONS FOR create, update WHERE $auth = service:workflow;
-- Set once, together (mediaJob_rules).
DEFINE FIELD OVERWRITE doneAt     ON mediaJob TYPE option<datetime>
  VALUE IF $before != NONE { $before } ELSE { $value }
  PERMISSIONS FOR create, update WHERE $auth = service:workflow;
DEFINE FIELD OVERWRITE outcome    ON mediaJob TYPE option<string>
  ASSERT $value = NONE OR $value IN ['applied', 'stale', 'gone', 'gave_up']
  VALUE IF $before != NONE { $before } ELSE { $value }
  PERMISSIONS FOR create, update WHERE $auth = service:workflow;
DEFINE INDEX OVERWRITE mediaJob_file ON mediaJob FIELDS file, kind;
-- The nightly resend and tidy-up's lists.
DEFINE INDEX OVERWRITE mediaJob_done ON mediaJob FIELDS doneAt;
-- Whoever writes: the job's person must be live (their fence then serialises every job write for
-- them, so two overlapping writes can't both find no open job), at most one job per file and kind
-- is open, and doneAt and outcome come together.
DEFINE EVENT OVERWRITE mediaJob_rules ON mediaJob
  WHEN $event IN ['CREATE', 'UPDATE'] THEN {
    fn::person::live($after.file.person);
    IF ($after.doneAt = NONE) != ($after.outcome = NONE) {
      THROW 'a media job’s doneAt and outcome are set together';
    };
    IF $after.doneAt = NONE AND (SELECT VALUE id FROM mediaJob
      WHERE file = $after.file AND kind = $after.kind AND doneAt = NONE AND id != $after.id) != [] {
      THROW 'media_job_open: this file already has an open job of this kind';
    };
  };
-- A file's row going takes its jobs with it (erasure, housekeeping's tidy-up).
DEFINE EVENT OVERWRITE storyFile_jobs ON storyFile
  WHEN $event = 'DELETE' THEN { DELETE mediaJob WHERE file = $before.id };
-- Opens a job for `$file` (a check or render), or adds `$reason` to the open one (J1 check a), on
-- the caller's login. Returns the job's id, the story's id (the queue's ordering key) and the
-- Bunny video id, or NONE if there is no such file.
DEFINE FUNCTION OVERWRITE fn::media::queue_job($file: record<storyFile>, $kind: string, $reason: string) {
  LET $f = (SELECT id, story FROM ONLY $file);
  IF $f = NONE { RETURN NONE };
  LET $open = (SELECT VALUE id FROM mediaJob WHERE file = $file AND kind = $kind AND doneAt = NONE)[0];
  LET $job = IF $open = NONE {
    (CREATE ONLY type::record('mediaJob', rand::ulid())
      CONTENT { file: $file, kind: $kind, reasons: [$reason] } RETURN VALUE id)
  } ELSE {
    (UPDATE ONLY $open SET reasons = array::union(reasons, [$reason]) RETURN VALUE id)
  };
  RETURN { job: <string> record::id($job), story: <string> record::id($f.story),
    video: <string> record::id($file) };
};
-- The jobs a person's own steps need (Joel, 2026-11-07: media-worker-final.html section 1 steps 1
-- to 3, media-job-table.html J1 check e; audio-picture-video "also assumed"), written in the
-- same transaction as the step, so none is lost if sending it fails (api-user sends it after,
-- and the 18:00 resend sends any it couldn't):
-- - submitting a video or audio story: a check of its file (reason submitted), so the result
--   writer gives Bunny the picture the story has now (the video's own picture, or an audio
--   story's picture video);
-- - an audio story's picture put on, replaced or taken off while it can still be edited: a render
--   of its file (reason picture_changed), so its picture video is made again with the new one.
-- Elevated (an event): the person's session can't see mediaJob.
DEFINE EVENT OVERWRITE story_media_jobs ON story
  WHEN $event = 'UPDATE' AND $after.mediaFile != NONE AND $after.primaryFormat IN ['video', 'audio']
  THEN {
    LET $was = fn::story::status_of($before);
    LET $now = fn::story::status_of($after);
    IF $now = 'pending' AND $was = 'editing' {
      fn::media::queue_job($after.mediaFile, 'check', 'submitted');
    };
    IF $after.primaryFormat = 'audio' AND $after.image.file != $before.image.file
      AND $after.mediaFile = $before.mediaFile AND $now = 'editing' {
      fn::media::queue_job($after.mediaFile, 'render', 'picture_changed');
    };
  };

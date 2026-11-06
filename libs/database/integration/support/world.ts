import type { SurrealQueryable } from 'surrealdb';
import { ERASE_ACCOUNT } from '../../src/lib/erasure';
import {
  createPeople,
  agreeAll,
  outcome,
  type Row,
  rows,
  run,
  STORY_TEXT_PADDING,
  type TestDatabase,
  COMMON_THEME,
} from './harness';

/** The text `draft` gives story `id`: long enough to submit (200 characters). */
export const storyText = (id: string) => `Text of ${id}${STORY_TEXT_PADDING}`;

/** The person creates a draft with a known id, in their own session. */
export async function draft(
  person: SurrealQueryable,
  id: string,
  fields: Row = {},
): Promise<Row[]> {
  return rows(
    person,
    `CREATE type::record('story', $id) CONTENT object::extend({
       submitter: $auth, slug: $id, title: 'Story ' + $id,
       description: 'How I came to faith', body: $body, primaryFormat: 'written',
       themeRefs: [${COMMON_THEME}]
     }, $fields)`,
    { id, fields, body: storyText(id) },
  );
}

/**
 * RequestUpload's database half (D80, R12), as api-user runs it on its own login after creating
 * the video at Bunny: a storyFile row for the person's story, whose event points the draft at it.
 * `version` is the story's version (If-Match); the defaults suit a small video.
 */
export function grantUpload(
  apiUser: SurrealQueryable,
  g: {
    video: string;
    story: string;
    person: string;
    version: number;
    format?: 'video' | 'audio';
    sizeBytes?: number;
    durationSeconds?: number;
  },
) {
  return outcome(
    apiUser,
    `CREATE type::record('storyFile', $video) CONTENT {
       story: type::record('story', $story), person: type::record('user', $person),
       format: $format, contentType: $contentType, sizeBytes: $sizeBytes,
       durationSeconds: $durationSeconds, storyVersion: $version
     } RETURN NONE`,
    {
      ...g,
      format: g.format ?? 'video',
      contentType: g.format === 'audio' ? 'audio/mpeg' : 'video/mp4',
      sizeBytes: g.sizeBytes ?? 1_000_000,
      durationSeconds: g.durationSeconds ?? 60,
    },
  );
}

/**
 * RequestUpload's database half for an image (M2 plan PR 10, R12): the storyFile row api-user
 * records for the file it named, with the description as the $imageAlt parameter, `stories/<story>/<32 hex>.webp` unless `path` says otherwise. The defaults suit a
 * small portrait WebP with its description. `expectedImage`: the path of the picture the person's
 * page showed (left out: none), which must be the story's picture now.
 */
export function grantImage(
  apiUser: SurrealQueryable,
  g: {
    story: string;
    person: string;
    version: number;
    path?: string;
    name?: string;
    contentType?: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    alt?: string | null;
    expectedImage?: string | null;
  },
) {
  const path = g.path ?? `stories/${g.story}/${g.name ?? 'a'.repeat(32)}.webp`;
  return outcome(
    apiUser,
    `CREATE type::record('storyFile', $path) CONTENT {
       story: type::record('story', $story), person: type::record('user', $person),
       format: 'image', contentType: $contentType, sizeBytes: $sizeBytes,
       width: $width, height: $height, storyVersion: $version,
       expectedImage: $expected
     } RETURN NONE`,
    {
      story: g.story,
      person: g.person,
      version: g.version,
      path,
      contentType: g.contentType ?? 'image/webp',
      sizeBytes: g.sizeBytes ?? 40_000,
      width: g.width ?? 900,
      height: g.height ?? 1200,
      imageAlt:
        g.alt === null ? undefined : (g.alt ?? 'A sunrise over the hills'),
      expected: g.expectedImage ?? undefined,
    },
  );
}

/**
 * Adds a status entry to the story's log (R6) as `who` (the person's session, api-admin's login,
 * a system user): the database checks the step and moves story.currentStatus. Answers the entry
 * as `who` reads it back. A moderator's entry names user:moderator unless `extra` says otherwise.
 */
export function step(
  who: SurrealQueryable,
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<Row[]> {
  return rows(
    who,
    `CREATE type::record('storyStatusLog', rand::ulid()) CONTENT object::extend({
       story: type::record('story', $id), status: $status,
       by: IF $auth = service:api_admin { user:moderator }
     }, $extra)`,
    { id, status, extra },
  );
}

/** The owner submits (R6: a pending entry): draft/changes_requested → pending. */
export function submit(person: SurrealQueryable, id: string): Promise<Row[]> {
  return step(person, id, 'pending');
}

/** The owner withdraws (R6: a withdrawn entry), from any status. */
export function withdraw(person: SurrealQueryable, id: string): Promise<Row[]> {
  return step(person, id, 'withdrawn');
}

/** A story's status as its newest entry says (R6), read by a system user. */
export async function statusOf(
  migrator: SurrealQueryable,
  id: string,
): Promise<string> {
  const [found] = await rows(
    migrator,
    `SELECT VALUE fn::story::status_of($this) FROM type::record('story', $id)`,
    { id },
  );
  return found as unknown as string;
}

/**
 * M7 processing as workflow will record it (A2, R12): the story's video or audio file and its
 * picture `ready`, with the facts processing found (a video's size and length; an audio file's
 * length and its thumbnail, by default the site's 1280 x 720 default audio thumbnail, with that
 * picture's size). Approval and publishing are refused until then. Answers the files' rows.
 */
export async function processed(
  workflow: SurrealQueryable,
  id: string,
  { durationSeconds = 60 }: { durationSeconds?: number } = {},
): Promise<Row[]> {
  const results = await run(
    workflow,
    `LET $s = (SELECT mediaFile, image FROM ONLY type::record('story', $id));
     LET $m = IF $s.mediaFile != NONE { (UPDATE ONLY $s.mediaFile SET processing = 'ready',
       lengthSeconds = lengthSeconds ?? $durationSeconds,
       width = width ?? (IF format = 'video' { 1080 } ELSE { 1280 }),
       height = height ?? (IF format = 'video' { 1920 } ELSE { 720 }),
       thumbnailPath = IF format = 'audio' {
         thumbnailPath ?? (record::id(id) + '/thumbnail_0a1b2c3d.jpg') } ELSE { thumbnailPath }) };
     LET $i = IF $s.image != NONE { (UPDATE ONLY $s.image.file SET processing = 'ready') };
     RETURN [$m, $i].filter(|$f| $f != NONE);`,
    { id, durationSeconds },
  );
  return results.at(-1) as Row[];
}

/**
 * A moderator picks a pending story up and approves it (R6: in_review, then approved), as
 * api-admin will (M3). The approval publishes it: the public rules read its newest entry (R11).
 */
export async function approve(admin: SurrealQueryable, id: string) {
  await run(
    admin,
    `BEGIN TRANSACTION;
     CREATE type::record('storyStatusLog', rand::ulid()) CONTENT {
       story: type::record('story', $id), status: 'in_review', by: user:moderator };
     CREATE type::record('storyStatusLog', rand::ulid()) CONTENT {
       story: type::record('story', $id), status: 'approved', by: user:moderator };
     COMMIT TRANSACTION;`,
    { id },
  );
}

/**
 * Ann and Bob, each agreed to the latest terms of use and testimony consent (version 0), plus:
 * story:ann_draft (draft), story:ann_pending (pending), story:bob_draft (draft),
 * story:bob_pending (pending), story:bob_live (approved: public),
 * theme:doubt (in Other).
 */
export async function buildWorld(t: TestDatabase) {
  await createPeople(t, {
    ann: 'user_ann',
    bob: 'user_bob',
    moderator: 'user_mod',
  });
  const admin = await t.service('api_admin');
  await run(
    admin,
    `CREATE theme:doubt SET name = 'Doubt', category = themeCategory:other`,
  );
  // The world has more stories per person than D94's limits allow a person to start: trusted.
  await run(
    await t.migrator(),
    `CREATE submitterLimits:ann SET user = user:ann, trusted = true;
     CREATE submitterLimits:bob SET user = user:bob, trusted = true;`,
  );
  const ann = await t.person('user_ann');
  const bob = await t.person('user_bob');
  await agreeAll(ann);
  await agreeAll(bob);
  for (const [person, id] of [
    [ann, 'ann_draft'],
    [ann, 'ann_pending'],
    [bob, 'bob_draft'],
    [bob, 'bob_pending'],
    [bob, 'bob_live'],
  ] as const) {
    const created = await draft(person, id);
    if (created.length !== 1) throw new Error(`draft ${id} not created`);
  }
  await submit(ann, 'ann_pending');
  await submit(bob, 'bob_pending');
  await submit(bob, 'bob_live');
  await approve(admin, 'bob_live');
  return { admin, ann, bob };
}

/** EraseAccount (D39) exactly as api-user runs it (libs/database erasure.ts). Bind $clerkUserId and $reason. */
export const ERASE = ERASE_ACCOUNT;

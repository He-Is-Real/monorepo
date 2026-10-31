import type { SurrealQueryable } from 'surrealdb';
import { ERASE_ACCOUNT } from '../../src/lib/erasure';
import {
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  type Row,
  rows,
  run,
  sha256,
  STORY_TEXT_PADDING,
  type TestDatabase,
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
       description: 'How I came to faith', body: $body, primaryFormat: 'written'
     }, $fields)`,
    { id, fields, body: storyText(id) },
  );
}

/**
 * RequestUpload's database half (D80), as api-user runs it on its own login after creating the
 * video at Bunny: an upload grant for the person's story, whose event puts the video on the draft.
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
    `CREATE type::record('uploadGrant', $video) CONTENT {
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

/** The owner submits: draft/changes_requested → pending. */
export function submit(person: SurrealQueryable, id: string): Promise<Row[]> {
  return rows(
    person,
    `UPDATE type::record('story', $id) SET status = 'pending'`,
    { id },
  );
}

/**
 * M7 processing as workflow will record it (A2): every media item and the image `ready`, with
 * the facts processing found (a video's size and duration; an audio file's duration and its
 * thumbnail, by default the site's 1280 x 720 default audio thumbnail, with that picture's size).
 * Approval and publishing are refused until then.
 */
export function processed(
  workflow: SurrealQueryable,
  id: string,
  { durationSeconds = 60 }: { durationSeconds?: number } = {},
): Promise<Row[]> {
  return rows(
    workflow,
    `UPDATE type::record('story', $id) SET
       media = media.map(|$m| object::extend($m, IF $m.format = 'video' {
         { processing: 'ready', durationSeconds: $m.durationSeconds ?? $durationSeconds,
           width: $m.width ?? 1080, height: $m.height ?? 1920 }
       } ELSE {
         { processing: 'ready', durationSeconds: $m.durationSeconds ?? $durationSeconds,
           thumbnailPath: $m.thumbnailPath ?? ($m.bunnyVideoId + '/thumbnail_0a1b2c3d.jpg'),
           width: $m.width ?? 1280, height: $m.height ?? 720 }
       })),
       image = IF image != NONE { object::extend(image, { processing: 'ready' }) }`,
    { id, durationSeconds },
  );
}

/**
 * ApproveStory as api-admin will run it (D25/D26): story, read model, review and audit row in
 * one transaction.
 */
export async function approve(admin: SurrealQueryable, id: string) {
  await run(
    admin,
    `BEGIN TRANSACTION;
     LET $s = (UPDATE ONLY type::record('story', $id) SET status = 'approved', approvedAt = time::now());
     CREATE type::record('publicStory', $id) CONTENT {
       version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
       body: $s.body, bylineName: $s.bylineName, primaryFormat: $s.primaryFormat,
       tagRefs: $s.tagRefs, publishedAt: time::now(),
       image: IF $s.image != NONE { { path: $s.image.path, width: $s.image.width,
         height: $s.image.height, alt: $s.image.alt } },
       media: $s.media.map(|$m| { format: $m.format, bunnyVideoId: $m.bunnyVideoId,
         thumbnailPath: $m.thumbnailPath, width: $m.width, height: $m.height })
     };
     CREATE moderationReview CONTENT {
       story: $s.id, moderator: user:moderator, decision: 'approve', storyVersion: $s.version
     };
     CREATE auditLog CONTENT {
       service: 'api-admin', action: 'ApproveStory', actor: user:moderator, actorRole: 'Moderator',
       entity: $s.id, storyVersion: $s.version, fromStatus: 'pending', toStatus: 'approved'
     };
     COMMIT TRANSACTION;`,
    { id },
  );
}

/**
 * Ann and Bob, each with every consent granted against the published v1, plus:
 * story:ann_draft (draft), story:ann_pending (pending), story:bob_draft (draft),
 * story:bob_pending (pending), story:bob_live (approved, with a publicStory row),
 * tag:doubt, and a draft dpaVersion:v2_draft.
 */
export async function buildWorld(t: TestDatabase) {
  await createPeople(t, {
    ann: 'user_ann',
    bob: 'user_bob',
    moderator: 'user_mod',
  });
  await publishDpa(t, 'v1');
  const admin = await t.service('api_admin');
  await run(
    admin,
    `CREATE dpaVersion:v2_draft CONTENT {
       materiality: 'material', documentPath: 'libs/legal/dpa/v2.md', contentHash: $h };`,
    { h: sha256('v2 draft') },
  );
  // The world has more stories per person than D94's limits allow a person to start: trusted.
  // tag:doubt as made before themes got opaque ids (R2), so a readable fixture.
  await run(
    await t.migrator(),
    `CREATE tag:doubt SET name = 'Doubt', category = 'journey';
     CREATE submitterLimits:ann SET user = user:ann, trusted = true;
     CREATE submitterLimits:bob SET user = user:bob, trusted = true;`,
  );
  const ann = await t.person('user_ann');
  const bob = await t.person('user_bob');
  await grantAll(ann);
  await grantAll(bob);
  for (const [person, id] of [
    [ann, 'ann_draft'],
    [ann, 'ann_pending'],
    [bob, 'bob_draft'],
    [bob, 'bob_pending'],
    [bob, 'bob_live'],
  ] as const) {
    const created = await draft(person, id, { tagRefs: [] });
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

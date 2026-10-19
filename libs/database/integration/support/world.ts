import type { SurrealSession } from 'surrealdb';
import {
  createPeople,
  grantAll,
  publishDpa,
  type Row,
  rows,
  run,
  sha256,
  type TestDatabase,
} from './harness';

/** The person creates a draft with a known id, in their own session. */
export async function draft(
  person: SurrealSession,
  id: string,
  fields: Row = {},
): Promise<Row[]> {
  return rows(
    person,
    `CREATE type::record('story', $id) CONTENT object::extend({
       submitter: $auth, slug: $id, title: 'Story ' + $id,
       description: 'How I came to faith', body: 'Text of ' + $id, primaryFormat: 'written'
     }, $fields)`,
    { id, fields },
  );
}

/** The owner submits: draft/changes_requested → pending. */
export function submit(person: SurrealSession, id: string): Promise<Row[]> {
  return rows(
    person,
    `UPDATE type::record('story', $id) SET status = 'pending'`,
    { id },
  );
}

/**
 * ApproveStory as api-admin will run it (D25/D26): story, read model, review and audit row in
 * one transaction.
 */
export async function approve(admin: SurrealSession, id: string) {
  await run(
    admin,
    `BEGIN TRANSACTION;
     LET $s = (UPDATE ONLY type::record('story', $id) SET status = 'approved', approvedAt = time::now());
     CREATE type::record('publicStory', $id) CONTENT {
       version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
       body: $s.body, bylineName: $s.bylineName, primaryFormat: $s.primaryFormat,
       tagRefs: $s.tagRefs, publishedAt: time::now(),
       media: $s.media.map(|$m| { format: $m.format, bunnyVideoId: $m.bunnyVideoId,
         thumbnailPath: $m.thumbnailPath, aspectRatio: $m.aspectRatio })
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
    `CREATE tag:doubt SET name = 'Doubt', category = 'journey';
     CREATE dpaVersion:v2_draft CONTENT {
       materiality: 'material', documentPath: 'libs/legal/dpa/v2.md', contentHash: $h };`,
    { h: sha256('v2 draft') },
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

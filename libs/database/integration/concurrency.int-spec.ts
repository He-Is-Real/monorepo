import type { Surreal, SurrealTransaction } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  grantAll,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { approve, draft, ERASE, submit } from './support/world';

/**
 * Review round 2, P1-A. A transaction reads a snapshot, so its permission and consent checks can
 * pass while another transaction commits the opposite (erasure, consent withdrawal). Every write
 * that depends on or changes a person's state also writes that person's `personFence` record, so
 * of two overlapping transactions the SECOND TO COMMIT fails with a retryable conflict.
 *
 * Each test interleaves two sessions deterministically: A begins and writes (uncommitted), B runs
 * and commits, then A commits. The stored state is asserted afterwards. The container runs
 * RocksDB, the production engine.
 */
const CONFLICT = /Transaction conflict.*can be retried/s;

describe('concurrent transactions are fenced per person', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);
  const begin = (db: Surreal) => db.beginTransaction();
  const commit = async (tx: SurrealTransaction) => {
    try {
      await tx.commit();
      return 'committed';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    apiUser = await t.service('api_user');
    workflow = await t.service('workflow');
    await createPeople(t, {
      bob: 'user_bob',
      bea: 'user_bea',
      ann: 'user_ann',
      sam: 'user_sam',
      wes: 'user_wes',
      ula: 'user_ula',
      moderator: 'user_mod',
    });
    await publishDpa(t, 'v1');
    for (const sub of [
      'user_bob',
      'user_bea',
      'user_ann',
      'user_sam',
      'user_wes',
      'user_ula',
    ]) {
      await grantAll(await t.person(sub));
    }
  });
  afterAll(() => t?.close());

  it('story created in a transaction that overlaps erasure: the story never lands', async () => {
    const bob = await t.person('user_bob');
    const tx = await begin(bob);
    expect(await draft(tx as unknown as Surreal, 'bob_racing')).toHaveLength(1); // uncommitted
    await run(apiUser, ERASE, {
      clerkUserId: 'user_bob',
      reason: 'clerk_user_deleted',
    });
    expect(await commit(tx)).toMatch(CONFLICT);
    expect(
      await truth('SELECT * FROM story WHERE submitter = user:bob'),
    ).toEqual([]);
    expect(
      await truth('SELECT VALUE gdprDeletedAt != NONE FROM user:bob'),
    ).toEqual([true]);
  });

  it('erasure that overlaps a story create fails instead, and its retry erases the story', async () => {
    const bea = await t.person('user_bea');
    const erasing = await begin(apiUser);
    await erasing
      .query(
        ERASE.replace('BEGIN TRANSACTION;', '').replace(
          'COMMIT TRANSACTION;',
          '',
        ),
        { clerkUserId: 'user_bea', reason: 'account_deleted' },
      )
      .collect();
    expect(await draft(bea, 'bea_story')).toHaveLength(1); // commits first
    expect(await commit(erasing)).toMatch(CONFLICT);
    expect(await truth('SELECT VALUE id FROM story:bea_story')).toHaveLength(1);
    // D39: erasure is idempotent, so the handler retries it; now it sees and erases the story.
    await run(apiUser, ERASE, {
      clerkUserId: 'user_bea',
      reason: 'account_deleted',
    });
    expect(
      await truth('SELECT * FROM story WHERE submitter = user:bea'),
    ).toEqual([]);
  });

  it('approval that overlaps a publish-consent withdrawal: nothing is published', async () => {
    const ann = await t.person('user_ann');
    await draft(ann, 'ann_story');
    await submit(ann, 'ann_story');
    const approving = await begin(admin);
    await approving
      .query(
        `LET $s = (UPDATE ONLY story:ann_story SET status = 'approved', approvedAt = time::now());
         CREATE publicStory:ann_story CONTENT {
           version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
           body: $s.body, primaryFormat: $s.primaryFormat, tagRefs: $s.tagRefs, media: [],
           publishedAt: time::now() };`,
      )
      .collect();
    // WithdrawConsent: ledger row + delete the visible public rows, one transaction.
    await run(
      ann,
      `BEGIN TRANSACTION;
       CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'withdrawn',
         dpaVersion: dpaVersion:v1, mechanism: 'account_settings', evidenceHash: $h };
       DELETE publicStory WHERE record::id(id) IN (SELECT VALUE record::id(id) FROM story WHERE submitter = $auth);
       COMMIT TRANSACTION;`,
      { h: 'b'.repeat(64) },
    );
    expect(await commit(approving)).toMatch(CONFLICT);
    expect(await truth('SELECT * FROM publicStory:ann_story')).toEqual([]);
    expect(await truth('SELECT VALUE status FROM story:ann_story')).toEqual([
      'pending',
    ]);
    // The retry now sees the withdrawal and is refused by the consent check.
    await expect(approve(admin, 'ann_story')).rejects.toThrow();
    expect(await truth('SELECT * FROM publicStory:ann_story')).toEqual([]);
  });

  it('submit that overlaps a consent withdrawal (two sessions of one person): not submitted', async () => {
    const tab1 = await t.person('user_sam');
    const tab2 = await t.person('user_sam');
    await draft(tab1, 'sam_story');
    const submitting = await begin(tab1);
    await submitting
      .query(`UPDATE story:sam_story SET status = 'pending'`)
      .collect();
    expect(
      await consentEvent(tab2, 'special_category_religious', 'withdrawn'),
    ).toHaveLength(1);
    expect(await commit(submitting)).toMatch(CONFLICT);
    expect(await truth('SELECT VALUE status FROM story:sam_story')).toEqual([
      'draft',
    ]);
  });

  it('workflow media write that overlaps erasure: the write never lands', async () => {
    const wes = await t.person('user_wes');
    await draft(wes, 'wes_story', { primaryFormat: 'video' });
    const processing = await begin(workflow);
    await processing
      .query(
        `UPDATE story:wes_story SET media = [{ format: 'video', bunnyVideoId: 'vid-wes' }]`,
      )
      .collect();
    await run(apiUser, ERASE, {
      clerkUserId: 'user_wes',
      reason: 'clerk_user_deleted',
    });
    expect(await commit(processing)).toMatch(CONFLICT);
    expect(
      await truth('SELECT * FROM story WHERE submitter = user:wes'),
    ).toEqual([]);
  });

  it('the fence is per person: unrelated people never conflict', async () => {
    const ula = await t.person('user_ula');
    const tx = await begin(ula);
    await draft(tx as unknown as Surreal, 'ula_story');
    await run(admin, `UPDATE story:ann_story SET status = 'changes_requested'`); // someone else
    expect(await commit(tx)).toBe('committed');
    expect(await truth('SELECT VALUE id FROM story:ula_story')).toHaveLength(1);
  });

  it('nobody can read or write a fence directly; it only counts', async () => {
    const sessions = [
      await t.person('user_ula'),
      apiUser,
      admin,
      workflow,
      await t.service('api_public_read'),
    ];
    const before = await truth('SELECT * FROM personFence:ula');
    for (const db of sessions) {
      expect(await rows(db, 'SELECT * FROM personFence')).toEqual([]);
      expect(await rows(db, 'UPDATE personFence:ula SET n = 0')).toEqual([]);
      expect(await rows(db, 'CREATE personFence:ghost SET n = 1')).toEqual([]);
      expect(await rows(db, 'DELETE personFence:ula RETURN BEFORE')).toEqual(
        [],
      );
    }
    expect(await truth('SELECT * FROM personFence:ula')).toEqual(before);
    expect(await truth('SELECT * FROM personFence:ghost')).toEqual([]);
    expect(
      Object.keys((before as Record<string, unknown>[])[0]).sort(),
    ).toEqual(['id', 'n']);
  });
});

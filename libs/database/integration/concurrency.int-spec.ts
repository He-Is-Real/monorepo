import type { Surreal, SurrealTransaction } from 'surrealdb';
import {
  agree,
  agreeAll,
  createPeople,
  outcome,
  rows,
  run,
  shareStory,
  TestDatabase,
} from './support/harness';
import { draft, ERASE, step, submit } from './support/world';

/**
 * Review round 2, P1-A. A transaction reads a snapshot, so its permission and agreement checks can
 * pass while another transaction commits the opposite (erasure). Every write
 * that depends on or changes a person's state also writes that person's fence record (`fence:person-<id>`, R5), so
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
      vic: 'user_vic',
      ula: 'user_ula',
      cy: 'user_cy',
      cid: 'user_cid',
      dee: 'user_dee',
      moderator: 'user_mod',
    });
    for (const sub of [
      'user_bob',
      'user_bea',
      'user_ann',
      'user_sam',
      'user_wes',
      'user_ula',
      'user_dee',
    ]) {
      await agreeAll(await t.person(sub));
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
    expect(await truth('SELECT VALUE status FROM user:bob')).toEqual([
      'deleted',
    ]);
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

  it('workflow’s write to a file row that overlaps erasure: the write never lands', async () => {
    const wes = await t.person('user_wes');
    await draft(wes, 'wes_story', { primaryFormat: 'video' });
    // Their upload (as storyFile_attach makes it, D80, R12), which workflow then processes.
    await run(
      migrator,
      `CREATE storyFile:vidwes CONTENT { story: story:wes_story, person: user:wes,
         format: 'video', contentType: 'video/mp4', sizeBytes: 1, storyVersion: 1 };
       UPDATE story:wes_story SET mediaFile = storyFile:vidwes;`,
    );
    const processing = await begin(workflow);
    await processing
      .query(`UPDATE storyFile:vidwes SET processing = 'processing'`)
      .collect();
    await run(apiUser, ERASE, {
      clerkUserId: 'user_wes',
      reason: 'clerk_user_deleted',
    });
    expect(await commit(processing)).toMatch(CONFLICT);
    expect(
      await truth('SELECT * FROM story WHERE submitter = user:wes'),
    ).toEqual([]);
    expect(await truth('SELECT * FROM storyFile:vidwes')).toEqual([]);
  });

  // Db review 2, section 6 item 2: a file's processing and a status entry bump the same fence.
  it('a video failing while a moderator approves the story: one of them conflicts, and the retry sees the other', async () => {
    const vic = await t.person('user_vic');
    await agreeAll(vic);
    await run(
      migrator,
      `CREATE submitterLimits:vic SET user = user:vic, trusted = true`,
    );
    await draft(vic, 'vic_story', { primaryFormat: 'video', body: undefined });
    await run(
      migrator,
      `CREATE storyFile:vidvic CONTENT { story: story:vic_story, person: user:vic,
         format: 'video', contentType: 'video/mp4', sizeBytes: 1, storyVersion: 1,
         processing: 'ready', width: 720, height: 1280, lengthSeconds: 20,
         at: time::now() - 1d };
       UPDATE story:vic_story SET mediaFile = storyFile:vidvic;`,
    );
    await submit(vic, 'vic_story');
    await step(admin, 'vic_story', 'in_review');
    const approving = await begin(admin);
    await approving
      .query(
        `CREATE storyStatusLog CONTENT { story: story:vic_story, status: 'approved', by: user:moderator }`,
      )
      .collect();
    // The video fails meanwhile (commits first).
    await run(workflow, `UPDATE storyFile:vidvic SET processing = 'failed'`);
    expect(await commit(approving)).toMatch(CONFLICT);
    // The retry checks from scratch: the video isn't ready, so it can't be approved.
    expect(
      await outcome(
        admin,
        `CREATE storyStatusLog CONTENT { story: story:vic_story, status: 'approved', by: user:moderator }`,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('media_not_ready'),
    });
  });

  // Plan 4e: agreeing (the person's pointers) racing account deletion, which clears them.
  it('agreeing in a transaction that overlaps erasure: the agreement never lands', async () => {
    const cy = await t.person('user_cy');
    const tx = await begin(cy);
    expect(await agree(tx as unknown as Surreal, 'termsOfUse')).toHaveLength(1); // uncommitted
    await run(apiUser, ERASE, {
      clerkUserId: 'user_cy',
      reason: 'account_deleted',
    });
    expect(await commit(tx)).toMatch(CONFLICT);
    // Nor can the erased person's session agree afterwards.
    await agree(cy, 'termsOfUse').catch(() => undefined);
    const [stub] = await truth<Record<string, unknown>>(
      'SELECT * FROM ONLY user:cy',
    );
    expect(Object.keys(stub ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'status',
    ]);
    expect(stub?.['status']).toBe('deleted');
  });

  it('erasure that overlaps an agreement fails instead, and its retry clears it', async () => {
    const cid = await t.person('user_cid');
    const erasing = await begin(apiUser);
    await erasing
      .query(
        ERASE.replace('BEGIN TRANSACTION;', '').replace(
          'COMMIT TRANSACTION;',
          '',
        ),
        { clerkUserId: 'user_cid', reason: 'account_deleted' },
      )
      .collect();
    expect(await agree(cid, 'termsOfUse')).toHaveLength(1); // commits first
    expect(await commit(erasing)).toMatch(CONFLICT);
    await run(apiUser, ERASE, {
      clerkUserId: 'user_cid',
      reason: 'account_deleted',
    });
    const [stub] = await truth<Record<string, unknown>>(
      'SELECT * FROM ONLY user:cid',
    );
    expect(Object.keys(stub ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'status',
    ]);
    expect(stub?.['status']).toBe('deleted');
  });

  it('a story’s sharing consent ticked in a transaction that overlaps erasure never lands', async () => {
    const dee = await t.person('user_dee');
    await draft(dee, 'dee_story');
    const tx = await begin(dee);
    expect(
      await shareStory(tx as unknown as Surreal, 'story:dee_story'),
    ).toHaveLength(1); // uncommitted
    await run(apiUser, ERASE, {
      clerkUserId: 'user_dee',
      reason: 'clerk_user_deleted',
    });
    expect(await commit(tx)).toMatch(CONFLICT);
    expect(
      await truth('SELECT * FROM story WHERE submitter = user:dee'),
    ).toEqual([]);
  });

  it('the fence is per person: unrelated people never conflict', async () => {
    const ula = await t.person('user_ula');
    const tx = await begin(ula);
    await draft(tx as unknown as Surreal, 'ula_story');
    await run(admin, `UPDATE story:ann_story SET updatedAt = time::now()`); // someone else's story
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
    const before = await truth(
      `SELECT * FROM type::record('fence', 'person-ula')`,
    );
    for (const db of sessions) {
      expect(await rows(db, 'SELECT * FROM fence')).toEqual([]);
      expect(
        await rows(db, `UPDATE type::record('fence', 'person-ula') SET n = 0`),
      ).toEqual([]);
      expect(
        await rows(
          db,
          `CREATE type::record('fence', 'person-ghost') SET n = 1`,
        ),
      ).toEqual([]);
      expect(
        await rows(
          db,
          `DELETE type::record('fence', 'person-ula') RETURN BEFORE`,
        ),
      ).toEqual([]);
    }
    expect(
      await truth(`SELECT * FROM type::record('fence', 'person-ula')`),
    ).toEqual(before);
    expect(
      await truth(`SELECT * FROM type::record('fence', 'person-ghost')`),
    ).toEqual([]);
    expect(
      Object.keys((before as Record<string, unknown>[])[0]).sort(),
    ).toEqual(['id', 'n']);
  });
});

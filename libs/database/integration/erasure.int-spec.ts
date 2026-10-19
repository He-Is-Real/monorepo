import type { Surreal } from 'surrealdb';
import { outcome, rows, run, TestDatabase } from './support/harness';
import { approve, buildWorld, draft, submit } from './support/world';

/**
 * Erasure (Art 17): Clerk's signed `user.deleted` webhook reaches api-user, which verifies the
 * Svix signature and then erases with ITS OWN service login (the person's token no longer
 * exists). What that login can delete, and what deliberately remains.
 */
describe('erasure on api_user’s service login', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);

  /** EraseAccount as api-user will run it for a verified user.deleted webhook. */
  const ERASE = `
    BEGIN TRANSACTION;
    LET $u = (SELECT VALUE id FROM user WHERE clerkUserId = $clerkUserId AND gdprDeletedAt = NONE)[0];
    IF $u = NONE { THROW 'unknown or already erased' };
    DELETE story WHERE submitter = $u;              -- cascades publicStory + moderationReview
    DELETE idempotencyKey WHERE id[1] = $clerkUserId;
    UPDATE $u SET gdprDeletedAt = time::now();
    CREATE auditLog CONTENT { service: 'api-user', action: 'EraseAccount', entity: $u };
    COMMIT TRANSACTION;`;

  beforeAll(async () => {
    t = await TestDatabase.create();
    const { admin, ann } = await buildWorld(t);
    await draft(ann, 'ann_live');
    await submit(ann, 'ann_live');
    await approve(admin, 'ann_live');
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    await run(
      apiUser,
      `CREATE idempotencyKey:['api-user', 'user_ann', 'k1'] SET requestHash = 'h', status = 201;
       CREATE idempotencyKey:['api-user', 'user_bob', 'k1'] SET requestHash = 'h', status = 201;`,
    );
    // Before: Ann has three stories, one live with a review; Bob has three, one live.
    expect(
      await truth('SELECT VALUE id FROM story WHERE submitter = user:ann'),
    ).toHaveLength(3);
    expect(await truth('SELECT VALUE id FROM publicStory')).toHaveLength(2);
    expect(await truth('SELECT VALUE id FROM moderationReview')).toHaveLength(
      2,
    );
  });
  afterAll(() => t?.close());

  it('cannot find a person’s read-model rows or reviews without the cascade', async () => {
    // Why the story_erasure_cascade event exists: the lookups go through story.submitter,
    // which api_user can't read, so they match nothing (and return an empty result).
    expect(
      await rows(
        apiUser,
        `DELETE publicStory WHERE type::record('story', record::id(id)).submitter = user:ann RETURN BEFORE`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        apiUser,
        'DELETE moderationReview WHERE story.submitter = user:ann',
      ),
    ).toEqual([]);
    expect(await truth('SELECT VALUE id FROM publicStory')).toHaveLength(2);
    expect(await truth('SELECT VALUE id FROM moderationReview')).toHaveLength(
      2,
    );
  });

  it('erases the person’s stories, read-model rows, reviews and idempotency keys', async () => {
    await run(apiUser, ERASE, { clerkUserId: 'user_ann' });
    expect(
      await truth('SELECT VALUE id FROM story WHERE submitter = user:ann'),
    ).toEqual([]);
    expect(await truth('SELECT VALUE id FROM publicStory')).toEqual([
      'publicStory:bob_live',
    ]);
    expect(
      await truth<{ story: string }>('SELECT story FROM moderationReview'),
    ).toEqual([{ story: 'story:bob_live' }]);
    expect(
      await truth('SELECT VALUE record::id(id)[1] FROM idempotencyKey'),
    ).toEqual(['user_bob']);
  });

  it('leaves everyone else untouched', async () => {
    expect(
      (await truth('SELECT VALUE id FROM story WHERE submitter = user:bob'))
        .length,
    ).toBe(3);
  });

  it('keeps the consent ledger as proof, and the user row as a tombstone', async () => {
    expect(
      await truth(
        'SELECT VALUE type FROM consent WHERE subject = user:ann ORDER BY type',
      ),
    ).toEqual([
      'age_18plus',
      'publish',
      'share_socials',
      'special_category_religious',
    ]);
    const [user] = await truth<Record<string, unknown>>(
      'SELECT * FROM user:ann',
    );
    expect(user['gdprDeletedAt']).toEqual(expect.any(String));
    // Open question (docs/db-permissions.md): the Clerk ID stays, linking the ledger to a
    // deleted Clerk account. api_user can't clear it (field permission), and nobody can
    // delete the row or the ledger.
    expect(user['clerkUserId']).toBe('user_ann');
    expect(await rows(apiUser, 'DELETE user:ann RETURN BEFORE')).toEqual([]);
    expect(await rows(apiUser, 'DELETE consent RETURN BEFORE')).toEqual([]);
    expect(await truth('SELECT VALUE id FROM user:ann')).toHaveLength(1);
  });

  it('keeps audit rows (ids only, no testimony text)', async () => {
    expect(
      await truth(
        `SELECT action, entity, createdAt FROM auditLog
           WHERE entity = user:ann OR entity = story:ann_live ORDER BY createdAt`,
      ),
    ).toEqual([
      {
        action: 'ApproveStory',
        entity: 'story:ann_live',
        createdAt: expect.any(String),
      },
      {
        action: 'EraseAccount',
        entity: 'user:ann',
        createdAt: expect.any(String),
      },
    ]);
  });

  it('locks the person out: their Clerk token no longer opens a session', async () => {
    await expect(t.person('user_ann')).rejects.toThrow();
  });

  it('refuses to run twice', async () => {
    expect(await outcome(apiUser, ERASE, { clerkUserId: 'user_ann' })).toEqual({
      ok: false,
      error: expect.stringContaining('unknown or already erased'),
    });
  });
});

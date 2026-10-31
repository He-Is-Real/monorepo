import type { Surreal } from 'surrealdb';
import { outcome, rows, run, TestDatabase } from './support/harness';
import { consentEvent, createPeople, grantAll } from './support/harness';
import { createHash } from 'node:crypto';
import {
  approve,
  buildWorld,
  draft,
  ERASE,
  grantUpload,
  submit,
} from './support/world';

const ANN_VIDEO = '0b9e7d36-4a3f-4c3e-9a51-6f1d2c3b4a59';
const fingerprint = (clerkUserId: string) =>
  createHash('sha256').update(clerkUserId).digest('hex');

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

  beforeAll(async () => {
    t = await TestDatabase.create();
    const { admin, ann } = await buildWorld(t);
    await draft(ann, 'ann_live');
    await submit(ann, 'ann_live');
    await approve(admin, 'ann_live');
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    // Ann's video draft, its video made by api-user (an upload grant, D80).
    await draft(ann, 'ann_video', { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video: ANN_VIDEO,
        story: 'ann_video',
        person: 'ann',
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    await run(
      apiUser,
      `CREATE idempotencyKey:['api-user', user:ann, 'k1'] SET requestHash = 'h', status = 201;
       CREATE idempotencyKey:['api-user', user:bob, 'k1'] SET requestHash = 'h', status = 201;`,
    );
    // Before: Ann has four stories, one live with a review; Bob has three, one live.
    expect(
      await truth('SELECT VALUE id FROM story WHERE submitter = user:ann'),
    ).toHaveLength(4);
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
    await run(apiUser, ERASE, {
      clerkUserId: 'user_ann',
      reason: 'account_deleted',
    });
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
    ).toEqual(['user:bob']);
  });

  it('leaves everyone else untouched', async () => {
    expect(
      (await truth('SELECT VALUE id FROM story WHERE submitter = user:bob'))
        .length,
    ).toBe(3);
  });

  it('queues what must go outside the database: the person’s Bunny video and Clerk account (D40)', async () => {
    expect(
      await truth('SELECT kind, ref FROM pendingDeletion ORDER BY kind'),
    ).toEqual([
      { kind: 'bunny_video', ref: ANN_VIDEO },
      { kind: 'clerk_user', ref: 'user_ann' },
    ]);
    expect(await truth('SELECT * FROM uploadGrant')).toEqual([]);
    // Only api-user's login sees or changes the queue.
    for (const name of ['api_admin', 'workflow', 'api_public_read'] as const) {
      expect(
        await rows(await t.service(name), 'SELECT * FROM pendingDeletion'),
      ).toEqual([]);
    }
  });

  it('leaves a fingerprint of the Clerk id, and nothing else, that no one can remove (D82)', async () => {
    expect(await truth('SELECT * FROM erasedIdentity')).toEqual([
      { id: `erasedIdentity:${fingerprint('user_ann')}` },
    ]);
    expect(
      await outcome(apiUser, `CREATE erasedIdentity:user_plain`),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('sha256 fingerprint only'),
    });
    for (const name of ['api_user', 'api_admin'] as const) {
      await run(await t.service(name), 'DELETE erasedIdentity');
    }
    expect(await truth('SELECT VALUE id FROM erasedIdentity')).toHaveLength(1);
  });

  it('never gives an erased Clerk id a row again: not api-user’s first use, nor a legacy link (#44)', async () => {
    expect(
      await outcome(apiUser, `CREATE user SET clerkUserId = 'user_ann'`),
    ).toEqual({ ok: false, error: expect.stringContaining('identity_erased') });
    await run(migrator, 'CREATE user:legacy_ann');
    expect(
      await outcome(
        await t.service('api_admin'),
        `UPDATE user:legacy_ann SET clerkUserId = 'user_ann'`,
      ),
    ).toEqual({ ok: false, error: expect.stringContaining('identity_erased') });
    expect(
      await truth(`SELECT VALUE id FROM user WHERE clerkUserId = 'user_ann'`),
    ).toEqual([]);
  });

  it('keeps the consent ledger as proof, pointing at a stub user row (D37)', async () => {
    expect(
      await truth(
        'SELECT VALUE type FROM consent WHERE subject = user:ann ORDER BY type',
      ),
    ).toEqual([
      'account_data',
      'age_18plus',
      'publish',
      'share_socials',
      'special_category_religious',
    ]);
    // The stub: internal id, createdAt and gdprDeletedAt. The Clerk id is cleared.
    const [user] = await truth<Record<string, unknown>>(
      'SELECT * FROM user:ann',
    );
    expect(Object.keys(user).sort()).toEqual([
      'createdAt',
      'gdprDeletedAt',
      'id',
    ]);
    expect(await rows(apiUser, 'DELETE user:ann RETURN BEFORE')).toEqual([]);
    expect(await rows(apiUser, 'DELETE consent RETURN BEFORE')).toEqual([]);
    expect(await truth('SELECT VALUE id FROM user:ann')).toHaveLength(1);
  });

  it('never lets anyone rebind or un-erase the stub (D37)', async () => {
    for (const name of ['api_user', 'api_admin'] as const) {
      const db = await t.service(name);
      expect(
        await outcome(db, `UPDATE user:ann SET clerkUserId = 'user_attacker'`),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('clerkUserId can only be'),
      });
      // gdprDeletedAt is immutable once set (its VALUE keeps $before): un-erasing or
      // re-dating is ignored, and the stored date stays.
      const [before] = await truth('SELECT VALUE gdprDeletedAt FROM user:ann');
      await run(db, 'UPDATE user:ann SET gdprDeletedAt = NONE');
      await run(
        db,
        `UPDATE user:ann SET gdprDeletedAt = d'2015-01-01T00:00:00Z'`,
      );
      expect(await truth('SELECT VALUE gdprDeletedAt FROM user:ann')).toEqual([
        before,
      ]);
    }
    expect(
      await rows(
        await t.service('workflow'),
        `UPDATE user:ann SET clerkUserId = 'x'`,
      ),
    ).toEqual([]);
    const [user] = await truth<Record<string, unknown>>(
      'SELECT * FROM user:ann',
    );
    expect(user['clerkUserId']).toBeUndefined();
    expect(user['gdprDeletedAt']).toEqual(expect.any(String));
  });

  it('keeps audit rows (ids only, no testimony text)', async () => {
    expect(
      await truth(
        `SELECT action, entity, createdAt FROM auditLog
           WHERE entity = user:ann OR entity = story:ann_live ORDER BY createdAt`,
      ),
    ).toEqual([
      // buildWorld makes Ann a trusted submitter (D94).
      {
        action: 'UpdateSubmitterLimits',
        entity: 'user:ann',
        createdAt: expect.any(String),
      },
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

  it('is a no-op the second time (D39: the webhook after an in-app deletion)', async () => {
    const before = await truth(
      'RETURN [(SELECT * FROM auditLog), (SELECT * FROM pendingDeletion), (SELECT * FROM erasedIdentity)]',
    );
    await run(apiUser, ERASE, {
      clerkUserId: 'user_ann',
      reason: 'clerk_user_deleted',
    });
    expect(
      await truth(
        'RETURN [(SELECT * FROM auditLog), (SELECT * FROM pendingDeletion), (SELECT * FROM erasedIdentity)]',
      ),
    ).toEqual(before);
  });

  it('a first-use create racing the erasure of a Clerk id it can’t see yet loses at commit', async () => {
    // Clerk's user.deleted for someone whose very first API call is still in flight.
    const tx = await apiUser.beginTransaction();
    await tx.query(`CREATE user SET clerkUserId = 'user_racer'`).collect();
    await run(apiUser, ERASE, {
      clerkUserId: 'user_racer',
      reason: 'clerk_user_deleted',
    });
    await expect(tx.commit()).rejects.toThrow(/conflict|retried/i);
    // provisionPerson's retry is then refused.
    expect(
      await outcome(apiUser, `CREATE user SET clerkUserId = 'user_racer'`),
    ).toEqual({ ok: false, error: expect.stringContaining('identity_erased') });
    expect(
      await truth(`SELECT VALUE id FROM user WHERE clerkUserId = 'user_racer'`),
    ).toEqual([]);
  });

  it('fingerprints a Clerk id nobody here knew, and queues nothing (Clerk’s user.deleted)', async () => {
    const results = await run(apiUser, ERASE, {
      clerkUserId: 'user_never_here',
      reason: 'clerk_user_deleted',
    });
    // [user, pending]: nobody erased, nothing queued.
    expect(results[results.length - 2]).toEqual([undefined, []]);
    expect(
      await truth(
        `SELECT VALUE id FROM type::record('erasedIdentity', $f)`,
        { f: fingerprint('user_never_here') },
      ),
    ).toHaveLength(1);
  });

  it('blocks writes from a session opened BEFORE erasure (the webhook race)', async () => {
    // Bob's request authenticates, then the user.deleted webhook erases him, then the request
    // writes using his retained (still granted) consent. $auth is a record id, so
    // `$auth.gdprDeletedAt` reads the user row as it is now, not a sign-in snapshot.
    const bob = await t.person('user_bob');
    expect(await rows(bob, 'RETURN $auth')).toEqual(['user:bob']);
    await run(apiUser, ERASE, {
      clerkUserId: 'user_bob',
      reason: 'clerk_user_deleted',
    });
    const consentBefore = await truth(
      'SELECT VALUE id FROM consent WHERE subject = user:bob',
    );

    expect(await draft(bob, 'bob_after_erasure')).toEqual([]);
    expect(await truth('SELECT * FROM story:bob_after_erasure')).toEqual([]);
    expect(await consentEvent(bob, 'publish', 'granted')).toEqual([]);
    expect(
      await truth('SELECT VALUE id FROM consent WHERE subject = user:bob'),
    ).toEqual(consentBefore);
    // There's no row left to update, and none can be put back: not even the migrator can
    // attach a story to an erased person (fn::person::live, round 3).
    expect(
      await outcome(
        migrator,
        `CREATE story:bob_ghost CONTENT { submitter: user:bob, slug: 'bob-ghost', title: 'Ghost',
           description: 'x', primaryFormat: 'written' }`,
      ),
    ).toEqual({ ok: false, error: expect.stringContaining('has been erased') });
    expect(await truth('SELECT * FROM story:bob_ghost')).toEqual([]);
    // And no new session: the Clerk id is gone (D37).
    await expect(t.person('user_bob')).rejects.toThrow();
  });

  it('erases after consent withdrawal (D39 caller) with no consent left', async () => {
    await createPeople(t, { cara: 'user_cara' });
    const cara = await t.person('user_cara');
    await grantAll(cara);
    await draft(cara, 'cara_story');
    await submit(cara, 'cara_story');
    await consentEvent(cara, 'special_category_religious', 'withdrawn');
    await run(apiUser, ERASE, {
      clerkUserId: 'user_cara',
      reason: 'consent_withdrawn',
    });
    expect(
      await truth('SELECT * FROM story WHERE submitter = user:cara'),
    ).toEqual([]);
    expect(
      await truth('SELECT VALUE reason FROM auditLog WHERE entity = user:cara'),
    ).toEqual(['consent_withdrawn']);
  });

  describe('audit rows are typed, with nowhere to put testimony text (D38)', () => {
    it.each([
      ['a payload object', `payload: { body: 'Text of the testimony' }`],
      ['any other unknown field', `note: 'Text of the testimony'`],
    ])('refuses %s (SCHEMAFULL rejects unknown fields)', async (_, extra) => {
      expect(
        await outcome(
          apiUser,
          `CREATE auditLog:typed CONTENT { service: 'api-user', action: 'EditStory',
             entity: story:bob_draft, storyVersion: 3, ${extra} }`,
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('no such field exists'),
      });
      expect(await truth('SELECT * FROM auditLog:typed')).toEqual([]);
    });

    it.each([
      ['a free-text action', `action: 'Approved: "Jesus met me in prison"'`],
      [
        'a free-text reason',
        `action: 'EraseAccount', reason: 'She told me about her faith'`,
      ],
      [
        'an unknown status',
        `action: 'SubmitStory', toStatus: 'published by moderator'`,
      ],
      ['an unknown role', `action: 'AssignRole', role: 'Pastor'`],
      [
        'an unknown consent type',
        `action: 'GrantConsent', consentType: 'faith'`,
      ],
    ])('refuses %s', async (_, fields) => {
      expect(
        (
          await outcome(
            apiUser,
            `CREATE auditLog CONTENT { service: 'api-user', ${fields} }`,
          )
        ).ok,
      ).toBe(false);
    });

    it('holds no testimony text anywhere', async () => {
      const all = JSON.stringify(await truth('SELECT * FROM auditLog'));
      expect(all).not.toMatch(/Text of|testimony|faith|prison/);
    });
  });
});

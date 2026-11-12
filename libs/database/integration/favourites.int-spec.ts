import type { Surreal } from 'surrealdb';
import {
  createPeople,
  agreeAll,
  outcome,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import {
  approve,
  buildWorld,
  draft,
  ERASE,
  submit,
  edit,
} from './support/world';

/**
 * Favourites (M2, hearts): a person's private list of published stories. Hearts are private
 * (founder, 2026-10-25): only the person who hearted a story can see that they did. Nobody
 * else reads the rows, not even the story's owner or the services' own logins; the owner's
 * count (profile, later) is a seam, not built. A heart needs the latest terms of use (plan 4e:
 * agreeing to them includes being 18 or over; agreements.int-spec.ts) and a story that is public now. Erasure
 * removes the person's favourites, and a story's deletion removes the favourites pointing at it.
 */
describe('favourites', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let ann: Surreal;
  let bob: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);
  const heart = (db: Surreal, story: string, person = '$auth') =>
    outcome(
      db,
      `CREATE favourite:ulid() SET person = ${person}, story = type::record('story', $story)`,
      { story },
    );
  const heartsOf = (person: string) =>
    truth<string>(
      `SELECT VALUE record::id(story) FROM favourite WHERE person = type::record('user', $p) ORDER BY id`,
      { p: person },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    ({ admin, ann, bob } = await buildWorld(t));
    migrator = await t.migrator();
    // A second public story, Ann's, and Bob's one taken down to edit.
    for (const [person, id] of [
      [ann, 'ann_live'],
      [bob, 'bob_gone'],
    ] as const) {
      await draft(person, id);
      await submit(person, id);
      await approve(admin, id);
    }
    await edit(bob, 'bob_gone');
  });
  afterAll(() => t?.close());

  it('a person hearts a public story and sees only their own hearts', async () => {
    expect((await heart(ann, 'bob_live')).ok).toBe(true);
    expect(await heartsOf('ann')).toEqual(['bob_live']);
    expect(
      await rows(ann, 'SELECT VALUE record::id(story) FROM favourite'),
    ).toEqual(['bob_live']);
    // Bob owns the story, yet can't see who hearted it (nor that anyone did).
    expect(await rows(bob, 'SELECT * FROM favourite')).toEqual([]);
    expect(await rows(bob, 'SELECT count() FROM favourite GROUP ALL')).toEqual([
      { count: 0 },
    ]);
  });

  it('no service login reads anyone’s hearts', async () => {
    for (const name of [
      'api_public_read',
      'api_user',
      'api_admin',
      'workflow',
    ] as const) {
      expect(
        await rows(await t.service(name), 'SELECT * FROM favourite'),
        name,
      ).toEqual([]);
    }
  });

  it('nobody hearts or un-hearts for someone else', async () => {
    expect(await heart(bob, 'ann_live', 'user:ann')).toEqual({
      ok: true,
      result: [],
    });
    await run(bob, 'DELETE favourite WHERE person = user:ann');
    await run(bob, 'DELETE favourite');
    expect(await heartsOf('ann')).toEqual(['bob_live']);
    // Nor through a service login.
    for (const name of ['api_user', 'api_admin'] as const) {
      const db = await t.service(name);
      await outcome(
        db,
        `CREATE favourite:ulid() SET person = user:ann, story = story:ann_live`,
      );
      await outcome(db, 'DELETE favourite');
    }
    expect(await heartsOf('ann')).toEqual(['bob_live']);
  });

  // R14 (Joel, 2026-11-05): the id carries the time, so it must be a ULID made just now.
  it.each([
    [
      'a ULID from yesterday',
      `type::record('favourite', rand::ulid(time::now() - 1d))`,
    ],
    [
      'a ULID from tomorrow',
      `type::record('favourite', rand::ulid(time::now() + 1d))`,
    ],
    ['an id that isn’t a ULID', 'favourite:mine'],
    ['a random id', 'favourite'],
  ])('refuses a heart whose id is %s', async (_, target) => {
    expect(
      await outcome(
        ann,
        `CREATE ${target} SET person = $auth, story = story:ann_live`,
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('favourite_id'),
    });
    expect(await heartsOf('ann')).toEqual(['bob_live']);
  });

  it('a heart’s time is its id’s', async () => {
    // Bounded by the database's own clock, read just before and after the create, in one query.
    // A ULID keeps milliseconds only, so the lower bound is rounded down to the millisecond.
    const [, , , , within] = await run(
      ann,
      `LET $before = time::now();
       LET $id = (CREATE ONLY favourite:ulid()
         SET person = $auth, story = story:ann_live RETURN VALUE id);
       LET $after = time::now();
       LET $at = time::from_ulid(record::id($id));
       RETURN [time::floor($before, 1ms) <= $at, $at <= $after];`,
    );
    expect(within).toEqual([true, true]);
    await run(ann, 'DELETE favourite WHERE story = story:ann_live');
  });

  it('refuses a story that isn’t public: a draft, pending, being edited or unknown', async () => {
    for (const story of ['bob_draft', 'bob_pending', 'bob_gone', 'nope']) {
      expect(await heart(ann, story), story).toEqual({
        ok: false,
        error: expect.stringContaining('favourite_not_published'),
      });
    }
    // Ann's own drafts too, though she can read them.
    expect((await heart(ann, 'ann_draft')).ok).toBe(false);
    expect(await heartsOf('ann')).toEqual(['bob_live']);
  });

  it('a story hidden or taken down to edit later keeps the heart, which the person can still remove', async () => {
    expect((await heart(bob, 'ann_live')).ok).toBe(true);
    await edit(ann, 'ann_live');
    expect(await heartsOf('bob')).toEqual(['ann_live']);
    // Lists show only stories the person can read as published, so it no longer shows (C15).
    expect(
      await rows(
        bob,
        `SELECT VALUE record::id(story) FROM favourite
         WHERE story.currentStatus.status = 'approved'`,
      ),
    ).toEqual([]);
    await run(bob, 'DELETE favourite WHERE story = story:ann_live');
    expect(await heartsOf('bob')).toEqual([]);
  });

  it('a story is hearted at most once per person', async () => {
    expect(await heart(ann, 'bob_live')).toEqual({
      ok: false,
      error: expect.stringContaining('favourite_unique'),
    });
    expect(await heartsOf('ann')).toEqual(['bob_live']);
  });

  it('nothing about a heart can be changed afterwards', async () => {
    await run(ann, 'UPDATE favourite SET story = story:bob_gone');
    await run(
      await t.service('api_admin'),
      'UPDATE favourite SET story = story:bob_gone',
    );
    expect(await heartsOf('ann')).toEqual(['bob_live']);
  });

  it('erasure removes the person’s hearts, and a deleted story’s hearts go with it', async () => {
    await createPeople(t, { dan: 'user_dan', eve: 'user_eve' });
    const dan = await t.person('user_dan');
    const eve = await t.person('user_eve');
    await agreeAll(dan);
    await agreeAll(eve);
    await draft(eve, 'eve_live');
    await submit(eve, 'eve_live');
    await approve(admin, 'eve_live');
    expect((await heart(dan, 'eve_live')).ok).toBe(true);
    expect((await heart(dan, 'bob_live')).ok).toBe(true);
    expect((await heart(eve, 'bob_live')).ok).toBe(true);

    const apiUser = await t.service('api_user');
    // Eve's erasure deletes her story, so Dan's heart on it goes too.
    await run(apiUser, ERASE, {
      clerkUserId: 'user_eve',
      reason: 'account_deleted',
    });
    expect(await heartsOf('eve')).toEqual([]);
    expect(await heartsOf('dan')).toEqual(['bob_live']);
    // Dan's erasure deletes his own.
    await run(apiUser, ERASE, {
      clerkUserId: 'user_dan',
      reason: 'clerk_user_deleted',
    });
    expect(await heartsOf('dan')).toEqual([]);
    expect(await heartsOf('ann')).toEqual(['bob_live']);
  });

  it('a heart racing the erasure of the story’s owner loses at commit and leaves nothing behind', async () => {
    // Codex, #117 round 1: the heart's own person isn't erased here, the story's owner is.
    await createPeople(t, { fay: 'user_fay', gus: 'user_gus' });
    const fay = await t.person('user_fay');
    const gus = await t.person('user_gus');
    await agreeAll(fay);
    await agreeAll(gus);
    await draft(gus, 'gus_live');
    await submit(gus, 'gus_live');
    await approve(admin, 'gus_live');

    const tx = await fay.beginTransaction();
    await tx
      .query(
        `CREATE favourite:ulid() SET person = $auth, story = story:gus_live`,
      )
      .collect();
    await run(await t.service('api_user'), ERASE, {
      clerkUserId: 'user_gus',
      reason: 'account_deleted',
    });
    await expect(tx.commit()).rejects.toThrow(
      /Transaction conflict.*can be retried/s,
    );
    expect(await heartsOf('fay')).toEqual([]);
    expect(
      await truth(
        'SELECT VALUE id FROM favourite WHERE story = story:gus_live',
      ),
    ).toEqual([]);
    // A retry now finds the story gone.
    expect(await heart(fay, 'gus_live')).toEqual({
      ok: false,
      error: expect.stringContaining('favourite_not_published'),
    });
  });
});

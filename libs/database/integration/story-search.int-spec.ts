import type { Surreal } from 'surrealdb';
import { rows, run, TestDatabase } from './support/harness';
import {
  approve,
  buildWorld,
  draft,
  ERASE,
  step,
  storyText,
  submit,
  withdraw,
} from './support/world';

/**
 * Search option A (Joel, 2026-11-06; search-drafts-decision.html): storySearch holds one row per
 * published story, with only its words, and the full-text index is there. The database writes and
 * removes the rows itself, in the same write that publishes a story or stops it being published,
 * so BM25's scores and the "best match" order are computed over published stories only.
 */
describe('storySearch: published stories’ words, and only theirs', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let ann: Surreal;
  let bob: Surreal;
  const indexed = () =>
    rows<string>(
      migrator,
      `SELECT VALUE record::id(story) FROM storySearch ORDER BY story`,
    );
  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    ({ admin, ann, bob } = await buildWorld(t));
  });
  afterAll(() => t?.close());

  it('has a row for each published story only, with its words', async () => {
    expect(await indexed()).toEqual(['bob_live']);
    const [row] = await rows<{ text: string }>(
      migrator,
      `SELECT text FROM storySearch:bob_live`,
    );
    expect(row.text).toBe(
      `Story bob_live How I came to faith ${storyText('bob_live')}`,
    );
  });

  it('adds the row when a story is published, and removes it when it is withdrawn', async () => {
    await approve(admin, 'ann_pending');
    expect(await indexed()).toEqual(['ann_pending', 'bob_live']);
    await withdraw(ann, 'ann_pending');
    expect(await indexed()).toEqual(['bob_live']);
  });

  it('removes it while a moderator hides the story, and adds it back when shown again', async () => {
    await step(admin, 'bob_live', 'hidden', { comment: 'Checking' });
    expect(await indexed()).toEqual([]);
    await step(admin, 'bob_live', 'approved');
    expect(await indexed()).toEqual(['bob_live']);
  });

  it('removes it when the story is deleted or its owner erased', async () => {
    await draft(bob, 'bob_second');
    await submit(bob, 'bob_second');
    await approve(admin, 'bob_second');
    expect(await indexed()).toEqual(['bob_live', 'bob_second']);
    await withdraw(bob, 'bob_second');
    await run(bob, `DELETE story:bob_second`);
    expect(
      await rows(migrator, 'SELECT * FROM storySearch:bob_second'),
    ).toEqual([]);
    await run(await t.service('api_user'), ERASE, {
      clerkUserId: 'user_bob',
      reason: 'account_deleted',
    });
    expect(await indexed()).toEqual([]);
  });

  it('can be written by nobody directly', async () => {
    for (const db of [
      ann,
      admin,
      await t.service('api_user'),
      await t.service('workflow'),
      await t.service('housekeeping'),
      await t.service('api_public_read'),
    ]) {
      await run(
        db,
        `CREATE storySearch:fake SET story = story:ann_draft, text = 'injected';
         UPDATE storySearch SET text = 'changed';
         DELETE storySearch;`,
      ).catch(() => undefined);
    }
    expect(await rows(migrator, `SELECT * FROM storySearch:fake`)).toEqual([]);
  });
});

/**
 * The reproduction from Codex's #187 review: with search over the story table, creating or
 * deleting a private draft moved published stories' BM25 scores, and so the relevance cursor and
 * sometimes the order. Over storySearch, nothing moves.
 */
describe('drafts never move best-match scores', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let publicRead: Surreal;
  let ann: Surreal;
  const scores = () =>
    rows<{ story: string; score: number }>(
      publicRead,
      `SELECT record::id(story) AS story, search::score(1) AS score FROM storySearch
       WHERE text @1@ 'faith' ORDER BY score DESC, story DESC`,
    );
  const counts = async () =>
    [
      await rows(publicRead, 'SELECT count() FROM storySearch GROUP ALL'),
      await rows(
        publicRead,
        'SELECT count() FROM storySearch WHERE true GROUP ALL',
      ),
    ].map((r) => (r[0] as { count: number } | undefined)?.count ?? 0);

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    const world = await buildWorld(t);
    ann = world.ann;
    publicRead = await t.service('api_public_read');
    // A second published story with the word more often, so there's an order to keep.
    await draft(world.bob, 'bob_faith', {
      body: `faith faith faith ${storyText('bob_faith')}`,
    });
    await submit(world.bob, 'bob_faith');
    await approve(world.admin, 'bob_faith');
  });
  afterAll(() => t?.close());

  it('keeps every published score, the order and the count across a draft’s create and delete', async () => {
    const before = await scores();
    expect(before.map((s) => s.story).sort()).toEqual([
      'bob_faith',
      'bob_live',
    ]);
    expect(await counts()).toEqual([2, 2]);
    for (let i = 0; i < 5; i++) {
      await draft(ann, `ann_faith_${i}`, {
        title: 'faith faith faith',
        body: `faith ${storyText(`ann_faith_${i}`)}`,
      });
    }
    expect(await scores()).toEqual(before);
    expect(await counts()).toEqual([2, 2]);
    for (let i = 0; i < 5; i++)
      await run(ann, `DELETE type::record('story', $id)`, {
        id: `ann_faith_${i}`,
      });
    expect(await scores()).toEqual(before);
    expect(
      await rows(migrator, `SELECT count() FROM storySearch GROUP ALL`),
    ).toEqual([{ count: 2 }]);
  });
});

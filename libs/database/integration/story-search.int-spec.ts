import { StringRecordId, type Surreal } from 'surrealdb';
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
    const [row] = await rows<{ searchText: string }>(
      migrator,
      `SELECT searchText FROM storySearch:bob_live`,
    );
    // Its title, description, text and its themes' names (Common).
    expect(row.searchText).toBe(
      `Story bob_live How I came to faith ${storyText('bob_live')} Common`,
    );
    // And what the public lists filter and sort on (Joel, 2026-11-06), as the story says.
    expect(
      await rows(
        migrator,
        `SELECT primaryFormat, themeIds, publishedAt = story.currentStatus.publishedAt AS same
         FROM storySearch:bob_live`,
      ),
    ).toEqual([{ primaryFormat: 'written', themeIds: ['common'], same: true }]);
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
        `CREATE storySearch:fake SET story = story:ann_draft, searchText = 'injected';
         UPDATE storySearch SET searchText = 'changed';
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
       WHERE searchText @1@ 'faith' ORDER BY score DESC, story DESC`,
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

/**
 * Theme names are searched too (Joel, 2026-11-06: "include story themes inside the terms search is
 * ranked on too"; search-ranking-design.html): a published story's search words include its
 * themes' current names, kept right by the database when a theme is renamed or deleted.
 */
describe('theme names in search', () => {
  let t: TestDatabase;
  let admin: Surreal;
  let ann: Surreal;
  let publicRead: Surreal;
  const found = (word: string) =>
    rows<string>(
      publicRead,
      `SELECT VALUE record::id(story) FROM storySearch WHERE searchText @1@ $word ORDER BY story`,
      { word },
    );
  const scores = (word: string) =>
    rows<{ story: string; score: number }>(
      publicRead,
      `SELECT record::id(story) AS story, search::score(1) AS score FROM storySearch
       WHERE searchText @1@ $word ORDER BY score DESC, story DESC`,
      { word },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    const world = await buildWorld(t);
    ({ admin, ann } = world);
    publicRead = await t.service('api_public_read');
    await run(
      admin,
      `CREATE theme:grief SET name = 'Grief', category = themeCategory:other`,
    );
    await draft(world.bob, 'bob_tagged', {
      themeRefs: [
        new StringRecordId('theme:common'),
        new StringRecordId('theme:grief'),
      ],
    });
    await submit(world.bob, 'bob_tagged');
    await approve(admin, 'bob_tagged');
  });
  afterAll(() => t?.close());

  it('finds a published story by its theme’s name, though the word isn’t in its text', async () => {
    expect(
      await rows(
        publicRead,
        `SELECT VALUE themeIds FROM storySearch:bob_tagged`,
      ),
    ).toEqual([['common', 'grief']]);
    expect(storyText('bob_tagged')).not.toMatch(/grief/i);
    expect(await found('grief')).toEqual(['bob_tagged']);
  });

  it('a draft carrying the theme moves no score', async () => {
    const before = await scores('grief');
    await draft(ann, 'ann_tagged', {
      themeRefs: [new StringRecordId('theme:grief')],
    });
    expect(await scores('grief')).toEqual(before);
    await run(ann, `DELETE story:ann_tagged`);
    expect(await scores('grief')).toEqual(before);
  });

  it('after a rename, the old name no longer finds it and the new one does', async () => {
    await run(admin, `UPDATE theme:grief SET name = 'Sorrow'`);
    expect(await found('grief')).toEqual([]);
    expect(await found('sorrow')).toEqual(['bob_tagged']);
  });

  it('after the theme is deleted, its name no longer finds it', async () => {
    await run(admin, `DELETE theme:grief`);
    expect(await found('sorrow')).toEqual([]);
    // Nor does the row list it among the story's themes.
    expect(
      await rows(
        publicRead,
        `SELECT VALUE themeIds FROM storySearch:bob_tagged`,
      ),
    ).toEqual([['common']]);
    // The story is still published and found by its own words.
    expect(await found('bob_tagged')).toEqual(['bob_tagged']);
  });
});

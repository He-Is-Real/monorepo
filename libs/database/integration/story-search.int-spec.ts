import {
  StringRecordId,
  type Surreal,
  type SurrealTransaction,
} from 'surrealdb';
import { rows, run, TestDatabase } from './support/harness';
import {
  approve,
  buildWorld,
  draft,
  ERASE,
  step,
  storyText,
  submit,
  edit,
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

  it('adds the row when a story is published, and removes it when its owner presses Edit', async () => {
    await approve(admin, 'ann_pending');
    expect(await indexed()).toEqual(['ann_pending', 'bob_live']);
    await edit(ann, 'ann_pending');
    expect(await indexed()).toEqual(['bob_live']);
  });

  it('removes it while a moderator hides the story, and adds it back when shown again', async () => {
    await step(admin, 'bob_live', 'hiddenByModerator', { comment: 'Checking' });
    expect(await indexed()).toEqual([]);
    await step(admin, 'bob_live', 'shownByModerator');
    expect(await indexed()).toEqual(['bob_live']);
  });

  it('removes it when the story is deleted or its owner erased', async () => {
    await draft(bob, 'bob_second');
    await submit(bob, 'bob_second');
    await approve(admin, 'bob_second');
    expect(await indexed()).toEqual(['bob_live', 'bob_second']);
    // A published story is deleted straight away (ED-3).
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

/**
 * A rename (or delete) of a theme racing a write that builds a story's search row from that
 * theme's name (Codex, #188 review): a transaction reads a snapshot, so without a shared write
 * both commit and the new row keeps the old name. Both write the theme's fence
 * (fence:theme-<id>), so the second to commit conflicts and its retry reads the other's result.
 * Two sessions, interleaved deterministically, as in concurrency.int-spec.ts.
 */
describe('theme renames and deletes racing a story’s publication', () => {
  const CONFLICT = /Transaction conflict.*can be retried/s;
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let world: Awaited<ReturnType<typeof buildWorld>>;
  const commit = async (tx: SurrealTransaction) => {
    try {
      await tx.commit();
      return 'committed';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const APPROVE = (id: string) =>
    `CREATE type::record('storyStatusLog', rand::ulid()) CONTENT {
       story: story:${id}, action: 'approved', by: user:moderator }`;
  const words = async (id: string) =>
    (
      await rows<string>(
        migrator,
        `SELECT VALUE searchText FROM type::record('storySearch', $id)`,
        { id },
      )
    )[0];
  /** A story of Bob's carrying `theme`, sent for review. */
  const waiting = async (id: string, theme: string) => {
    await run(
      admin,
      `CREATE type::record('theme', $theme) SET name = $name, category = themeCategory:other`,
      { theme, name: `Old ${theme}` },
    );
    await draft(world.bob, id, {
      themeRefs: [new StringRecordId(`theme:${theme}`)],
    });
    await submit(world.bob, id);
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    world = await buildWorld(t);
    ({ admin } = world);
  });
  afterAll(() => t?.close());

  it('the approval starts first, the rename commits: the approval conflicts, its retry has the new name', async () => {
    await waiting('bob_race_a', 'racea');
    const approving = await admin.beginTransaction();
    await run(approving as unknown as Surreal, APPROVE('bob_race_a')); // uncommitted
    await run(admin, `UPDATE theme:racea SET name = 'Renamed racea'`);
    expect(await commit(approving)).toMatch(CONFLICT);

    await run(admin, APPROVE('bob_race_a')); // the retry
    expect(await words('bob_race_a')).toMatch(/Renamed racea$/);
  });

  it('the rename starts first, the approval commits: the rename conflicts, its retry renames the new row', async () => {
    await waiting('bob_race_b', 'raceb');
    const renaming = await admin.beginTransaction();
    await run(
      renaming as unknown as Surreal,
      `UPDATE theme:raceb SET name = 'Renamed raceb'`,
    );
    await run(admin, APPROVE('bob_race_b'));
    expect(await commit(renaming)).toMatch(CONFLICT);

    await run(admin, `UPDATE theme:raceb SET name = 'Renamed raceb'`); // the retry
    expect(await words('bob_race_b')).toMatch(/Renamed raceb$/);
  });

  it('a delete racing the approval: one conflicts, and the row never keeps the deleted name', async () => {
    await waiting('bob_race_c', 'racec');
    const approving = await admin.beginTransaction();
    await run(approving as unknown as Surreal, APPROVE('bob_race_c'));
    await run(admin, `DELETE theme:racec`);
    expect(await commit(approving)).toMatch(CONFLICT);

    await run(admin, APPROVE('bob_race_c'));
    expect(await words('bob_race_c')).not.toMatch(/racec/);
  });
});

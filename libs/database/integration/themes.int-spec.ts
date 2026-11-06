import { RecordId, type Surreal, type SurrealTransaction } from 'surrealdb';
import {
  createPeople,
  agreeAll,
  outcome,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { buildWorld, draft, submit } from './support/world';

/**
 * Themes plan v3 (Joel, 2026-10-31), where the database is the behaviour: admin-managed
 * categories with one fixed Other, deleting a theme takes it off every story, deleting a
 * category moves its themes to Other, the number of themes is checked at submission only.
 */
const theme = (id: string) => new RecordId('theme', id);
const error = (o: Awaited<ReturnType<typeof outcome>>) =>
  o.ok ? '(accepted)' : o.error;

describe('themes and their categories', () => {
  let t: TestDatabase;
  let admin: Surreal;
  let migrator: Surreal;
  let ann: Surreal;
  let bob: Surreal;
  const settings = (themesMin: number, themesMax: number) =>
    run(
      admin,
      `UPDATE submissionSettings:current SET themesMin = $themesMin,
         themesMax = $themesMax, changedBy = user:moderator`,
      { themesMin, themesMax },
    );
  const themesOf = async (table: string, id: string) =>
    (
      await rows<{ ids: string[] }>(
        migrator,
        `SELECT themeRefs.map(|$t| record::id($t)) AS ids FROM ONLY type::record($table, $id)`,
        { table, id },
      )
    )[0].ids;
  beforeAll(async () => {
    t = await TestDatabase.create();
    ({ admin, ann, bob } = await buildWorld(t));
    migrator = await t.migrator();
    await run(
      admin,
      `CREATE themeCategory:feelings SET name = 'Feelings';
       CREATE theme:hope SET name = 'Hope', category = themeCategory:feelings, highlighted = true;
       CREATE theme:fear SET name = 'Fear', category = themeCategory:feelings;
       CREATE theme:grief SET name = 'Grief', category = themeCategory:feelings, highlighted = true;`,
    );
  });
  afterAll(() => t?.close());

  it('Other exists from the migration, and nobody can delete or rename it', async () => {
    expect(
      await rows(migrator, 'SELECT VALUE name FROM themeCategory:other'),
    ).toEqual(['Other']);
    for (const db of [admin, migrator]) {
      expect(error(await outcome(db, 'DELETE themeCategory:other'))).toMatch(
        /theme_category_fixed/,
      );
      expect(
        error(
          await outcome(db, `UPDATE themeCategory:other SET name = 'Misc'`),
        ),
      ).toMatch(/theme_category_fixed/);
    }
  });

  it('only api-admin writes themes and categories; everyone reads them', async () => {
    const reader = await t.service('api_public_read');
    expect(await rows(reader, 'SELECT VALUE name FROM theme:hope')).toEqual([
      'Hope',
    ]);
    for (const db of [reader, await t.service('api_user'), ann]) {
      await outcome(
        db,
        `CREATE theme:sneaky SET name = 'Sneaky', category = themeCategory:other`,
      );
      await outcome(db, `UPDATE theme:hope SET name = 'Changed'`);
      await outcome(db, 'DELETE theme:fear');
    }
    expect(
      await rows(
        migrator,
        'SELECT VALUE name FROM theme WHERE id IN [theme:sneaky, theme:hope, theme:fear] ORDER BY name',
      ),
    ).toEqual(['Fear', 'Hope']);
  });

  it('the number of themes is checked only when a story is submitted, from themesMin to themesMax', async () => {
    try {
      await settings(2, 3);
      // A draft may hold any number up to the hard ceiling while it's being written.
      await draft(ann, 'ann_many', {
        themeRefs: ['common', 'hope', 'fear', 'grief', 'doubt'].map(theme),
      });
      const asThemes = (ids: string[]) =>
        `[${ids.map((id) => `theme:${id}`).join(', ')}]`;
      expect(
        error(
          await outcome(ann, `CREATE storyStatusLog CONTENT { story: story:ann_many, status: 'pending' }`),
        ),
      ).toMatch(/story_theme_count:/);
      await run(
        ann,
        `UPDATE story:ann_many SET themeRefs = ${asThemes(['hope'])}`,
      );
      expect(
        error(
          await outcome(ann, `CREATE storyStatusLog CONTENT { story: story:ann_many, status: 'pending' }`),
        ),
      ).toMatch(/story_theme_count:/);
      await run(
        ann,
        `UPDATE story:ann_many SET themeRefs = ${asThemes(['hope', 'grief'])}`,
      );
      expect(await submit(ann, 'ann_many')).toHaveLength(1);

      // A minimum of 0 lets a story go without themes.
      await settings(0, 3);
      await draft(ann, 'ann_none', { themeRefs: [] });
      expect(await submit(ann, 'ann_none')).toHaveLength(1);

      // Stories already submitted aren't re-checked when the settings change.
      await settings(3, 3);
      expect(
        await rows(
          migrator,
          'SELECT VALUE fn::story::status_of($this) FROM story WHERE id IN [story:ann_many, story:ann_none]',
        ),
      ).toEqual(['pending', 'pending']);
    } finally {
      await settings(1, 5);
    }
  });

  it('a story can’t be submitted with a theme that no longer exists', async () => {
    await draft(ann, 'ann_gone', { themeRefs: [theme('never_was')] });
    expect(
      error(await outcome(ann, `CREATE storyStatusLog CONTENT { story: story:ann_gone, status: 'pending' }`)),
    ).toMatch(/story_themes_changed:/);
  });

  it('deleting a theme takes it off every story that carries it, published ones included', async () => {
    await run(
      admin,
      `CREATE theme:passing SET name = 'Passing', category = themeCategory:other`,
    );
    // bob_live is published; give it the theme as the person would before submitting.
    await draft(bob, 'bob_two', {
      themeRefs: [theme('passing'), theme('common')],
    });
    await run(
      migrator,
      `UPDATE story:bob_live SET themeRefs = [theme:passing, theme:common]`,
    );

    await run(admin, 'DELETE theme:passing');
    expect(await themesOf('story', 'bob_two')).toEqual(['common']);
    expect(await themesOf('story', 'bob_live')).toEqual(['common']);
    expect(
      await rows(migrator, 'SELECT themeIds FROM ONLY story:bob_live'),
    ).toEqual([{ themeIds: ['common'] }]);
    // Still published, still approved.
    expect(
      await rows(migrator, 'SELECT VALUE fn::story::status_of($this) FROM story:bob_live'),
    ).toEqual(['approved']);
  });

  describe('a theme deleted while a story adds it (snapshot reads): one of the two fails and retries', () => {
    const CONFLICT = /Transaction conflict.*can be retried/s;
    const commit = async (tx: SurrealTransaction) => {
      try {
        await tx.commit();
        return 'committed';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const ADD_AND_SUBMIT = (id: string, refs: string) =>
      `UPDATE story:${id} SET themeRefs = ${refs};
       CREATE storyStatusLog CONTENT { story: story:${id}, status: 'pending' };`;
    beforeAll(async () => {
      await settings(1, 5);
      await createPeople(t, {
        dana: 'user_dana',
        eve: 'user_eve',
        fay: 'user_fay',
      });
      for (const sub of ['user_dana', 'user_eve', 'user_fay']) {
        await agreeAll(await t.person(sub));
      }
      await run(
        admin,
        `CREATE theme:race1 SET name = 'Race one', category = themeCategory:other;
         CREATE theme:race2 SET name = 'Race two', category = themeCategory:other;
         CREATE theme:bystander SET name = 'Bystander', category = themeCategory:other;`,
      );
    });

    it('the delete scans first, the owner adds it and submits: the delete conflicts, its retry takes it off', async () => {
      const dana = await t.person('user_dana');
      await draft(dana, 'dana_race', { themeRefs: [theme('common')] });
      const deleting = await admin.beginTransaction();
      await run(deleting as unknown as Surreal, 'DELETE theme:race1'); // scanned, uncommitted
      await run(
        dana,
        ADD_AND_SUBMIT('dana_race', '[theme:common, theme:race1]'),
      );
      expect(await commit(deleting)).toMatch(CONFLICT);

      await run(admin, 'DELETE theme:race1'); // the retry
      expect(await themesOf('story', 'dana_race')).toEqual(['common']);
    });

    it('the owner adds it and submits first, the delete commits: the submission conflicts, its retry is refused', async () => {
      const eve = await t.person('user_eve');
      await draft(eve, 'eve_race', { themeRefs: [theme('common')] });
      const submitting = await eve.beginTransaction();
      await run(
        submitting as unknown as Surreal,
        ADD_AND_SUBMIT('eve_race', '[theme:common, theme:race2]'),
      );
      await run(admin, 'DELETE theme:race2');
      expect(await commit(submitting)).toMatch(CONFLICT);
      expect(
        await rows(migrator, 'SELECT VALUE fn::story::status_of($this) FROM story:eve_race'),
      ).toEqual(['draft']);

      expect(
        error(
          await outcome(
            eve,
            ADD_AND_SUBMIT('eve_race', '[theme:common, theme:race2]'),
          ),
        ),
      ).toMatch(/story_themes_changed:/);
    });

    it('a story adding another theme doesn’t conflict, and nobody can touch a theme’s fence', async () => {
      const fay = await t.person('user_fay');
      await draft(fay, 'fay_story', { themeRefs: [theme('common')] });
      await run(
        admin,
        `CREATE theme:other_race SET name = 'Other race', category = themeCategory:other`,
      );
      const deleting = await admin.beginTransaction();
      await run(deleting as unknown as Surreal, 'DELETE theme:other_race');
      await run(
        fay,
        ADD_AND_SUBMIT('fay_story', '[theme:common, theme:bystander]'),
      );
      expect(await commit(deleting)).toBe('committed');

      const fence = await rows(
        migrator,
        `SELECT * FROM type::record('fence', 'theme-bystander')`,
      );
      expect(fence).toHaveLength(1);
      for (const db of [fay, admin, await t.service('api_user')]) {
        expect(await rows(db, 'SELECT * FROM fence')).toEqual([]);
        expect(
          await rows(
            db,
            `UPDATE type::record('fence', 'theme-bystander') SET n = 0`,
          ),
        ).toEqual([]);
        expect(
          await rows(
            db,
            `CREATE type::record('fence', 'theme-ghost') SET n = 1`,
          ),
        ).toEqual([]);
      }
      expect(
        await rows(
          migrator,
          `SELECT * FROM type::record('fence', 'theme-bystander')`,
        ),
      ).toEqual(fence);
      expect(
        await rows(
          migrator,
          `SELECT * FROM type::record('fence', 'theme-ghost')`,
        ),
      ).toEqual([]);
      // A deleted theme leaves no fence behind.
      expect(
        await rows(
          migrator,
          `SELECT * FROM type::record('fence', 'theme-race1')`,
        ),
      ).toEqual([]);
    });
  });

  it('a published story that falls under the minimum after a delete isn’t re-checked', async () => {
    await run(
      admin,
      `CREATE theme:only SET name = 'Only', category = themeCategory:other`,
    );
    await run(
      migrator,
      `UPDATE story:bob_live SET themeRefs = [theme:only]`,
    );
    await run(admin, 'DELETE theme:only');
    expect(await themesOf('story', 'bob_live')).toEqual([]);
    expect(
      await rows(
        await t.service('api_public_read'),
        'SELECT VALUE id FROM story:bob_live',
      ),
    ).toHaveLength(1);
  });

  it('deleting a category moves its themes to Other, not highlighted, in the same transaction', async () => {
    await run(
      admin,
      `CREATE themeCategory:journeys SET name = 'Journeys';
       CREATE theme:returning SET name = 'Returning', category = themeCategory:journeys, highlighted = true;
       CREATE theme:leaving SET name = 'Leaving', category = themeCategory:journeys;`,
    );
    await run(admin, 'DELETE themeCategory:journeys');
    expect(
      await rows(
        migrator,
        `SELECT record::id(id) AS id, record::id(category) AS category, highlighted
           FROM theme WHERE id IN [theme:returning, theme:leaving] ORDER BY id`,
      ),
    ).toEqual([
      { id: 'leaving', category: 'other', highlighted: false },
      { id: 'returning', category: 'other', highlighted: false },
    ]);
  });

  it('a theme needs a category that exists', async () => {
    expect(
      error(
        await outcome(
          admin,
          `CREATE theme:lost SET name = 'Lost', category = themeCategory:nowhere`,
        ),
      ),
    ).not.toBe('(accepted)');
  });

  it('the themes’ version goes up with each save, which names the admin', async () => {
    const save = (changedBy?: string) =>
      outcome(
        admin,
        `UPSERT themeCatalog:current SET changedBy = $by, changedByRole = 'Admin'`,
        { by: changedBy ? new RecordId('user', changedBy) : undefined },
      );
    expect(error(await save())).toMatch(/names the admin/);
    for (const version of [1, 2]) {
      expect((await save('moderator')).ok).toBe(true);
      expect(
        await rows(migrator, 'SELECT VALUE version FROM themeCatalog:current'),
      ).toEqual([version]);
    }
    // R3: no audit log; the row keeps who saved last.
    expect(
      await rows(
        migrator,
        'SELECT changedBy, changedByRole FROM ONLY themeCatalog:current',
      ),
    ).toEqual([{ changedBy: 'user:moderator', changedByRole: 'Admin' }]);
  });
});

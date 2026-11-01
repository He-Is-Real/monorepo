import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, type Surreal, type SurrealTransaction } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  DPA_V1_SHA256,
  grantAll,
  outcome,
  rows,
  run,
  SCHEMA_DIR,
  sha256,
  TestDatabase,
} from './support/harness';
import { buildWorld, draft, submit } from './support/world';

/**
 * Themes plan v3 (Joel, 2026-10-31), where the database is the behaviour: admin-managed
 * categories with one fixed Other, deleting a theme takes it off every story, deleting a
 * category moves its themes to Other, the number of themes is checked at submission only, and
 * data/0008 turns the old tags into themes.
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
          await outcome(ann, 'UPDATE story:ann_many SET status = "pending"'),
        ),
      ).toMatch(/story_theme_count:/);
      await run(
        ann,
        `UPDATE story:ann_many SET themeRefs = ${asThemes(['hope'])}`,
      );
      expect(
        error(
          await outcome(ann, 'UPDATE story:ann_many SET status = "pending"'),
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
          'SELECT VALUE status FROM story WHERE id IN [story:ann_many, story:ann_none]',
        ),
      ).toEqual(['pending', 'pending']);
    } finally {
      await settings(1, 5);
    }
  });

  it('a story can’t be submitted with a theme that no longer exists', async () => {
    await draft(ann, 'ann_gone', { themeRefs: [theme('never_was')] });
    expect(
      error(await outcome(ann, 'UPDATE story:ann_gone SET status = "pending"')),
    ).toMatch(/story_themes_changed:/);
  });

  it('deleting a theme takes it off every story and published story that carries it', async () => {
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
      `UPDATE story:bob_live SET themeRefs = [theme:passing, theme:common];
       UPDATE publicStory:bob_live SET themeRefs = [theme:passing, theme:common];`,
    );
    expect(await themesOf('publicStory', 'bob_live')).toEqual([
      'passing',
      'common',
    ]);

    await run(admin, 'DELETE theme:passing');
    expect(await themesOf('story', 'bob_two')).toEqual(['common']);
    expect(await themesOf('story', 'bob_live')).toEqual(['common']);
    expect(await themesOf('publicStory', 'bob_live')).toEqual(['common']);
    expect(
      await rows(migrator, 'SELECT themeIds FROM ONLY publicStory:bob_live'),
    ).toEqual([{ themeIds: ['common'] }]);
    // Still published, still approved.
    expect(
      await rows(migrator, 'SELECT VALUE status FROM story:bob_live'),
    ).toEqual(['approved']);
  });

  it('after Art 9 consent is withdrawn, the owner can’t change themes, but deleting a theme still takes it off', async () => {
    await createPeople(t, { cara: 'user_cara' });
    const cara = await t.person('user_cara');
    await grantAll(cara);
    await run(
      admin,
      `CREATE theme:kept SET name = 'Kept', category = themeCategory:other;
       CREATE theme:going SET name = 'Going', category = themeCategory:other;`,
    );
    await draft(cara, 'cara_draft', {
      themeRefs: [theme('kept'), theme('going')],
    });
    await consentEvent(cara, 'special_category_religious', 'withdrawn');

    // The owner removing a theme that still exists is an edit like any other.
    for (const refs of ['[]', '[theme:kept]']) {
      expect(
        error(
          await outcome(
            cara,
            `UPDATE story:cara_draft SET themeRefs = ${refs}`,
          ),
        ),
      ).toMatch(/Art 9 consent/);
    }
    expect(await themesOf('story', 'cara_draft')).toEqual(['kept', 'going']);

    // Deleting the theme takes it off the story without consent.
    await run(admin, 'DELETE theme:going');
    expect(await themesOf('story', 'cara_draft')).toEqual(['kept']);
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
      `UPDATE story:${id} SET themeRefs = ${refs}; UPDATE story:${id} SET status = 'pending';`;
    beforeAll(async () => {
      await settings(1, 5);
      await createPeople(t, {
        dana: 'user_dana',
        eve: 'user_eve',
        fay: 'user_fay',
      });
      for (const sub of ['user_dana', 'user_eve', 'user_fay']) {
        await grantAll(await t.person(sub));
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
        await rows(migrator, 'SELECT VALUE status FROM story:eve_race'),
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

      const fence = await rows(migrator, 'SELECT * FROM themeFence:bystander');
      expect(fence).toHaveLength(1);
      for (const db of [fay, admin, await t.service('api_user')]) {
        expect(await rows(db, 'SELECT * FROM themeFence')).toEqual([]);
        expect(await rows(db, 'UPDATE themeFence:bystander SET n = 0')).toEqual(
          [],
        );
        expect(await rows(db, 'CREATE themeFence:ghost SET n = 1')).toEqual([]);
      }
      expect(
        await rows(migrator, 'SELECT * FROM themeFence:bystander'),
      ).toEqual(fence);
      expect(await rows(migrator, 'SELECT * FROM themeFence:ghost')).toEqual(
        [],
      );
      // A deleted theme leaves no fence behind.
      expect(await rows(migrator, 'SELECT * FROM themeFence:race1')).toEqual(
        [],
      );
    });
  });

  it('a published story that falls under the minimum after a delete isn’t re-checked', async () => {
    await run(
      admin,
      `CREATE theme:only SET name = 'Only', category = themeCategory:other`,
    );
    await run(
      migrator,
      `UPDATE story:bob_live SET themeRefs = [theme:only];
       UPDATE publicStory:bob_live SET themeRefs = [theme:only];`,
    );
    await run(admin, 'DELETE theme:only');
    expect(await themesOf('publicStory', 'bob_live')).toEqual([]);
    expect(
      await rows(migrator, 'SELECT VALUE id FROM publicStory:bob_live'),
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

  it('the themes’ version goes up with each save, which names the admin and is audited', async () => {
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
    expect(
      await rows(
        migrator,
        `SELECT VALUE action FROM auditLog WHERE entity = themeCatalog:current`,
      ),
    ).toEqual(['SaveThemes', 'SaveThemes']);
  });
});

/** main before themes v3: tags in three fixed groups. */
const BEFORE_THEMES = '0280b456dd0c414365c52e5feb1522ef74ae878e';
const DEV_SEED_SHA256 = sha256(
  readFileSync(join(SCHEMA_DIR, '../../legal/dpa/dev_seed.md'), 'utf8'),
);

describe('data/0008: tags become themes (a database migrated before themes v3)', () => {
  let t: TestDatabase;
  let previous: string;
  const params = () =>
    t.params({
      seed_dev_story: true,
      dpa_sha256: { v1: DPA_V1_SHA256, dev_seed: DEV_SEED_SHA256 },
    });
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'before-themes-'));
    const repo = join(__dirname, '../../..');
    const archive = execFileSync(
      'git',
      ['archive', '--format=tar', BEFORE_THEMES, 'libs/database/schema'],
      { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    previous = join(dir, 'libs/database/schema');
    t = await TestDatabase.create({ migrate: false });
    // That release, with its walking-skeleton story (data/0003) published, tags and limits.
    await t.migrate(params(), {
      bundleDir: previous,
      runner: join(previous, 'migrate.py'),
    });
    await run(
      await t.migrator(),
      `CREATE tag:hope SET name = 'Hope', category = 'theme';
       CREATE tag:loss SET name = 'Loss', category = 'theme';
       CREATE tag:doubt SET name = 'Doubt', category = 'journey';
       CREATE tag:fear SET name = 'Fear', category = 'emotion';
       UPDATE story:dev_seed SET tagRefs = [tag:hope, tag:doubt];
       UPDATE publicStory:dev_seed SET tagRefs = [tag:hope, tag:doubt];
       UPDATE submissionSettings:current SET tagsMin = 2, tagsMax = 4;
       -- Like dev, where dev-seed's new image made Other before this script ran.
       CREATE themeCategory:other SET name = 'Other';`,
    );
    // Like dev's row, written by data/0006 before the upload limits were defined: it has none.
    await run(
      await t.migrator(),
      `REMOVE FIELD uploadsPer7Days ON submissionSettings;
       REMOVE FIELD uploadRequestsPerHour ON submissionSettings;
       REMOVE FIELD videoMaxBytes ON submissionSettings;
       REMOVE FIELD audioMaxBytes ON submissionSettings;
       REMOVE FIELD mediaMaxSeconds ON submissionSettings;
       UPDATE submissionSettings:current SET uploadsPer7Days = NONE, uploadRequestsPerHour = NONE,
         videoMaxBytes = NONE, audioMaxBytes = NONE, mediaMaxSeconds = NONE;`,
    );
  });
  afterAll(async () => {
    await t?.close();
    if (previous) await rm(join(previous, '../../..'), { recursive: true });
  });

  it('copies each group to a category and each tag to a theme with a new id, relinking stories', async () => {
    const summary = await t.migrate(params());
    expect(summary.applied).toEqual(['0008-themes']);
    const migrator = await t.migrator();
    const themes = await rows<{
      id: string;
      name: string;
      category: string;
      highlighted: boolean;
    }>(
      migrator,
      `SELECT record::id(id) AS id, name, category.name AS category, highlighted
         FROM theme ORDER BY name`,
    );
    expect(
      themes.map(({ name, category, highlighted }) => ({
        name,
        category,
        highlighted,
      })),
    ).toEqual([
      { name: 'Doubt', category: 'Journeys', highlighted: false },
      { name: 'Fear', category: 'Feelings', highlighted: false },
      { name: 'Hope', category: 'Topics', highlighted: true },
      { name: 'Loss', category: 'Topics', highlighted: true },
    ]);
    for (const { id } of themes) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      await rows(
        migrator,
        'SELECT VALUE name FROM themeCategory ORDER BY name',
      ),
    ).toEqual(['Feelings', 'Journeys', 'Other', 'Topics']);

    const byName = Object.fromEntries(themes.map((th) => [th.name, th.id]));
    const [story] = await rows(
      migrator,
      `SELECT themeRefs.map(|$t| record::id($t)) AS themes, tagRefs FROM ONLY story:dev_seed`,
    );
    expect(story).toEqual({ themes: [byName['Hope'], byName['Doubt']] });
    const [published] = await rows(
      migrator,
      'SELECT themeIds, tagRefs, tagSlugs FROM ONLY publicStory:dev_seed',
    );
    expect(published).toEqual({ themeIds: [byName['Hope'], byName['Doubt']] });

    expect(await rows(migrator, 'SELECT * FROM tag')).toEqual([]);
    expect(
      await rows(
        migrator,
        'SELECT themesMin, themesMax, tagsMin, tagsMax FROM ONLY submissionSettings:current',
      ),
    ).toEqual([{ themesMin: 2, themesMax: 4 }]);
    // The upload limits it lacked get their defaults (dev's first run failed without them).
    expect(
      await rows(
        migrator,
        `SELECT uploadsPer7Days, uploadRequestsPerHour, videoMaxBytes, audioMaxBytes, mediaMaxSeconds
           FROM ONLY submissionSettings:current`,
      ),
    ).toEqual([
      {
        uploadsPer7Days: 5,
        uploadRequestsPerHour: 10,
        videoMaxBytes: 4294967296,
        audioMaxBytes: 524288000,
        mediaMaxSeconds: 900,
      },
    ]);
  });

  it('a second run changes nothing', async () => {
    expect((await t.migrate(params())).applied).toEqual([]);
    expect(
      await rows(
        await t.migrator(),
        'SELECT VALUE name FROM theme ORDER BY name',
      ),
    ).toEqual(['Doubt', 'Fear', 'Hope', 'Loss']);
  });
});

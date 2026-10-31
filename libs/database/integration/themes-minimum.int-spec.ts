import type { Surreal, SurrealTransaction } from 'surrealdb';
import { createPeople, outcome, rows, TestDatabase } from './support/harness';

/**
 * Submitting needs at least submissionSettings.tagsMin themes, so the themes there are must never
 * drop below it, or every submission is refused (Codex, admin limits review round 2). api-admin's
 * login can't delete a theme that would leave fewer than tagsMin, nor raise tagsMin above the
 * themes there are; both write themesFence:current, so a deletion and a save that overlap can't
 * both commit. The concurrent cases interleave two sessions deterministically, as
 * concurrency.int-spec does: A begins and writes (uncommitted), B runs and commits, A's commit
 * fails with a retryable conflict, and A's retry is refused.
 */
const CONFLICT = /Transaction conflict.*can be retried/s;

describe('the themes never drop below the fewest a submission needs (tagsMin)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;

  const SAVE = `UPDATE submissionSettings:current MERGE { tagsMin: $min, changedBy: user:admin }`;
  const themes = () =>
    rows<string>(migrator, 'SELECT VALUE record::id(id) FROM tag ORDER BY id');
  const tagsMin = async () =>
    (
      await rows<number>(
        migrator,
        'SELECT VALUE tagsMin FROM submissionSettings:current',
      )
    )[0];
  const error = (o: { ok: boolean; error?: string }) => (o.ok ? '' : o.error);
  const commit = async (tx: SurrealTransaction) => {
    try {
      await tx.commit();
      return 'committed';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  /** Three themes and tagsMin = 1, as each test starts. */
  async function reset() {
    await rows(
      migrator,
      `DELETE tag;
       CREATE tag:a SET name = 'A', category = 'theme';
       CREATE tag:b SET name = 'B', category = 'journey';
       CREATE tag:c SET name = 'C', category = 'emotion';`,
    );
    await rows(admin, SAVE, { min: 1 });
  }

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    await createPeople(t, { admin: 'user_admin' });
  });
  beforeEach(() => reset());
  afterAll(() => t?.close());

  it('refuses deleting a theme that would leave fewer than tagsMin; allows it once tagsMin is lower', async () => {
    await rows(admin, SAVE, { min: 3 });
    expect(error(await outcome(admin, 'DELETE tag:c'))).toMatch(
      /too_few_themes:3/,
    );
    expect(await themes()).toEqual(['a', 'b', 'c']);

    await rows(admin, SAVE, { min: 2 });
    expect(error(await outcome(admin, 'DELETE tag:c'))).toBe('');
    expect(await themes()).toEqual(['a', 'b']);
    expect(error(await outcome(admin, 'DELETE tag:b'))).toMatch(
      /too_few_themes:2/,
    );
  });

  it('refuses raising tagsMin above the themes there are; lowering always works', async () => {
    expect(error(await outcome(admin, SAVE, { min: 4 }))).toMatch(
      /too_few_themes:3/,
    );
    expect(await tagsMin()).toBe(1);
    await rows(migrator, 'DELETE tag:b, tag:c'); // a system user isn't checked
    expect(error(await outcome(admin, SAVE, { min: 0 }))).toBe('');
    expect(await tagsMin()).toBe(0);
  });

  it('a deletion that overlaps a save of tagsMin = 3 fails, and its retry is refused', async () => {
    const deleting = await admin.beginTransaction();
    await deleting.query('DELETE tag:c').collect(); // its snapshot says tagsMin = 1
    await rows(admin, SAVE, { min: 3 }); // its snapshot still has three themes
    expect(await commit(deleting)).toMatch(CONFLICT);
    expect(await themes()).toEqual(['a', 'b', 'c']);
    expect(await tagsMin()).toBe(3);
    expect(error(await outcome(admin, 'DELETE tag:c'))).toMatch(
      /too_few_themes:3/,
    );
  });

  it('a save of tagsMin = 3 that overlaps a deletion fails, and its retry is refused', async () => {
    const saving = await admin.beginTransaction();
    await saving.query(SAVE, { min: 3 }).collect(); // its snapshot has three themes
    expect(error(await outcome(admin, 'DELETE tag:c'))).toBe('');
    expect(await commit(saving)).toMatch(CONFLICT);
    expect(await tagsMin()).toBe(1);
    expect(error(await outcome(admin, SAVE, { min: 3 }))).toMatch(
      /too_few_themes:2/,
    );
  });

  it('two overlapping deletions can’t together go below tagsMin', async () => {
    await rows(admin, SAVE, { min: 2 });
    const first = await admin.beginTransaction();
    await first.query('DELETE tag:b').collect(); // its snapshot leaves two themes
    expect(error(await outcome(admin, 'DELETE tag:c'))).toBe('');
    expect(await commit(first)).toMatch(CONFLICT);
    expect(await themes()).toEqual(['a', 'b']);
    expect(error(await outcome(admin, 'DELETE tag:b'))).toMatch(
      /too_few_themes:2/,
    );
  });

  it('nobody can read or write the fence directly', async () => {
    const before = await rows(migrator, 'SELECT * FROM themesFence');
    expect(before).toHaveLength(1);
    expect(await rows(admin, 'SELECT * FROM themesFence')).toEqual([]);
    expect(await rows(admin, 'UPDATE themesFence:current SET n = 0')).toEqual(
      [],
    );
    expect(await rows(migrator, 'SELECT * FROM themesFence')).toEqual(before);
  });
});

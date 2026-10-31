import type { Surreal } from 'surrealdb';
import {
  createPeople,
  outcome,
  rows,
  SERVICES,
  TestDatabase,
} from './support/harness';

/**
 * Themes (`tag`) and the main themes (`themeSettings`), O5 (Joel, 2026-10-31): no login may ever
 * delete a theme, only api-admin's (for an admin) create or rename one; names are unique ignoring
 * case; every change names the admin and is audit-logged. The main themes are an ordered list of
 * existing themes, each once, and people see the first `mainThemesCount` (any whole number from 1,
 * no upper cap: Joel, 2026-10-31) of them.
 * Submitting needs at least tagsMin themes, so tagsMin can't be raised above the themes there
 * are; a system user may still delete themes, so a submission never needs more than there are.
 */
describe('themes and the main themes', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;

  const error = (o: { ok: boolean; error?: string }) => (o.ok ? '' : o.error);
  const themes = () =>
    rows<string>(migrator, 'SELECT VALUE record::id(id) FROM tag ORDER BY id');
  const CREATE = `CREATE type::record('tag', $slug)
    SET name = $name, category = 'theme', changedBy = user:admin, changedByRole = 'Admin'`;
  const SAVE_MAIN = `UPDATE themeSettings:current MERGE {
    mainThemes: $main.map(|$s| type::record('tag', $s)), mainThemesCount: $count,
    changedBy: user:admin, changedByRole: 'Admin' }`;
  const mainThemes = (db: Surreal) =>
    rows<string>(db, 'RETURN fn::settings::main_themes()');

  /** Three themes, tagsMin = 1 and no main themes, as each test starts. */
  async function reset() {
    await rows(
      migrator,
      `DELETE tag; DELETE auditLog;
       CREATE tag:a SET name = 'A', category = 'theme';
       CREATE tag:b SET name = 'B', category = 'journey';
       CREATE tag:c SET name = 'C', category = 'emotion';
       UPDATE submissionSettings:current SET tagsMin = 1;
       UPDATE themeSettings:current SET mainThemes = [], mainThemesCount = 10;`,
    );
  }

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    await createPeople(t, { admin: 'user_admin' });
  });
  beforeEach(() => reset());
  afterAll(() => t?.close());

  it('no service login and no person can delete a theme', async () => {
    const logins = [
      ...(await Promise.all(SERVICES.map((s) => t.service(s)))),
      await t.person('user_admin'),
    ];
    for (const db of logins) {
      await outcome(db, 'DELETE tag:a');
      await outcome(db, 'DELETE tag');
    }
    expect(await themes()).toEqual(['a', 'b', 'c']);
  });

  it('api-admin creates and renames a theme for an admin; the slug stays, and it is audit-logged', async () => {
    await rows(admin, CREATE, { slug: 'hope', name: 'Hope' });
    await rows(
      admin,
      `UPDATE tag:hope SET name = 'Hope and peace', changedBy = user:admin, changedByRole = 'Admin'`,
    );
    expect(await rows(migrator, 'SELECT name, version FROM tag:hope')).toEqual([
      { name: 'Hope and peace', version: 2 },
    ]);
    expect(
      await rows(
        migrator,
        `SELECT action, service, actorRole, record::id(actor) AS actor, record::id(entity) AS entity,
           createdAt FROM auditLog WHERE action IN ['CreateTag', 'UpdateTag'] ORDER BY createdAt`,
      ).then((r) => r.map(({ createdAt: _c, ...rest }) => rest)),
    ).toEqual(
      ['CreateTag', 'UpdateTag'].map((action) => ({
        action,
        service: 'api-admin',
        actorRole: 'Admin',
        actor: 'admin',
        entity: 'hope',
      })),
    );
    // A change must name the admin who made it.
    expect(
      error(
        await outcome(
          admin,
          `UPDATE tag:a SET name = 'Anew', changedBy = NONE`,
        ),
      ),
    ).toMatch(/names the admin/);
  });

  it('only api-admin’s login creates or renames themes', async () => {
    for (const s of SERVICES.filter((s) => s !== 'api_admin')) {
      const db = await t.service(s);
      await outcome(db, CREATE, { slug: 'spam', name: 'Spam' });
      await outcome(db, `UPDATE tag:a SET name = 'Renamed'`);
    }
    const person = await t.person('user_admin');
    await outcome(person, CREATE, { slug: 'spam', name: 'Spam' });
    await outcome(person, `UPDATE tag:a SET name = 'Renamed'`);
    expect(await themes()).toEqual(['a', 'b', 'c']);
    expect(await rows(migrator, 'SELECT VALUE name FROM tag:a')).toEqual(['A']);
  });

  it('names are unique ignoring case, and trimmed', async () => {
    expect(
      error(await outcome(admin, CREATE, { slug: 'a-2', name: 'a' })),
    ).toMatch(/tag_name_key/);
    expect(
      error(
        await outcome(
          admin,
          `UPDATE tag:b SET name = 'A', changedBy = user:admin`,
        ),
      ),
    ).toMatch(/tag_name_key/);
    // A theme may change the case of its own name.
    expect(
      error(
        await outcome(
          admin,
          `UPDATE tag:b SET name = 'b', changedBy = user:admin`,
        ),
      ),
    ).toBe('');
    expect(
      error(await outcome(admin, CREATE, { slug: 'd', name: ' D' })),
    ).toMatch(/name/);
  });

  it('people see the first mainThemesCount of the main themes, in order', async () => {
    const person = await t.person('user_admin');
    expect(await mainThemes(person)).toEqual([]);
    await rows(admin, SAVE_MAIN, { main: ['c', 'a', 'b'], count: 2 });
    expect(await mainThemes(person)).toEqual(['c', 'a']);
    expect(
      await rows(
        migrator,
        `SELECT action, record::id(actor) AS actor FROM auditLog WHERE action = 'UpdateMainThemes'`,
      ),
    ).toEqual([{ action: 'UpdateMainThemes', actor: 'admin' }]);
    // A theme a system user deleted is skipped, and the next one moves up.
    await rows(migrator, 'DELETE tag:c');
    expect(await mainThemes(person)).toEqual(['a', 'b']);
  });

  it('refuses an unknown theme, a theme twice and a count below 1; no upper cap', async () => {
    const refused = async (main: string[], count: number) =>
      error(await outcome(admin, SAVE_MAIN, { main, count }));
    expect(await refused(['a', 'nope'], 10)).toMatch(/unknown_theme/);
    expect(await refused(['a', 'a'], 10)).toMatch(/mainThemes/);
    expect(await refused(['a'], 0)).toMatch(/mainThemesCount/);
    // Admins choose the number (Joel, 2026-10-31): any whole number from 1.
    expect(await refused(['a', 'b', 'c'], 500)).toBe('');
    expect(await mainThemes(await t.person('user_admin'))).toEqual([
      'a',
      'b',
      'c',
    ]);
    // Only api-admin's login writes it; nobody deletes it.
    for (const s of SERVICES.filter((s) => s !== 'api_admin')) {
      await outcome(await t.service(s), SAVE_MAIN, { main: ['a'], count: 1 });
      await outcome(await t.service(s), 'DELETE themeSettings');
    }
    expect(
      await rows(migrator, 'SELECT VALUE mainThemesCount FROM themeSettings'),
    ).toEqual([500]);
  });

  it('refuses raising tagsMin above the themes there are', async () => {
    const SAVE = `UPDATE submissionSettings:current MERGE { tagsMin: $min, changedBy: user:admin }`;
    expect(error(await outcome(admin, SAVE, { min: 4 }))).toMatch(
      /too_few_themes:3/,
    );
    expect(error(await outcome(admin, SAVE, { min: 3 }))).toBe('');
  });

  it('a system user may still delete below tagsMin, so a submission needs no more themes than there are', async () => {
    const person = await t.person('user_admin');
    const needed = async () =>
      (await rows<number>(person, 'RETURN fn::settings::themes_needed()'))[0];
    await rows(migrator, 'UPDATE submissionSettings:current SET tagsMin = 3');
    expect(await needed()).toBe(3);
    await rows(migrator, 'DELETE tag:b, tag:c'); // a migration or dev-seed's reset
    expect(await needed()).toBe(1);
    await rows(migrator, 'DELETE tag');
    expect(await needed()).toBe(0);
  });
});

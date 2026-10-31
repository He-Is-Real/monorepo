import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Surreal } from 'surrealdb';
import {
  createPeople,
  grantAll,
  MIGRATION_TIMEOUT_MS,
  outcome,
  publishDpa,
  rows,
  run,
  SCHEMA_DIR,
  SERVICES,
  TestDatabase,
  trustSubmitters,
} from './support/harness';
import { approve, draft, submit } from './support/world';

/**
 * Themes (`tag`) and the main themes (`themeSettings`), O5 (Joel, 2026-10-31): no login may ever
 * delete a theme, only api-admin's (for an admin) create or rename one; names are unique ignoring
 * case; every change names the admin and is audit-logged. The main themes are an ordered list of
 * existing themes, each once, and people see the first `mainThemesCount` (any whole number from 1,
 * no upper cap: Joel, 2026-10-31) of them.
 * Submitting needs at least tagsMin themes, so tagsMin can't be raised above the themes there
 * are; a system user may still delete themes, so a submission never needs more than there are.
 */
const HOPE = '01JBQ8Y6V9W2K7E3M4N5P6R7S8';
const SPAM = '01JBQ8Y6V9W2K7E3M4N5P6R7S9';
const JOY = '01JBQ8Y6V9W2K7E3M4N5P6R7SA';

describe('themes and the main themes', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;

  const error = (o: { ok: boolean; error?: string }) => (o.ok ? '' : o.error);
  const themes = () =>
    rows<string>(migrator, 'SELECT VALUE record::id(id) FROM tag ORDER BY id');
  const CREATE = `CREATE type::record('tag', $id)
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

  it('api-admin creates and renames a theme for an admin; the id stays, and it is audit-logged', async () => {
    await rows(admin, CREATE, { id: HOPE, name: 'Hope' });
    await rows(
      admin,
      `UPDATE type::record('tag', $id) SET name = 'Hope and peace', changedBy = user:admin, changedByRole = 'Admin'`,
      { id: HOPE },
    );
    expect(
      await rows(
        migrator,
        `SELECT name, version FROM type::record('tag', $id)`,
        {
          id: HOPE,
        },
      ),
    ).toEqual([{ name: 'Hope and peace', version: 2 }]);
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
        entity: HOPE,
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

  it('a theme a login creates has an opaque id (a ULID), never one made from its name (R2)', async () => {
    for (const id of ['hope', 'Hope', '01JB-not-a-ulid'])
      expect(
        error(await outcome(admin, CREATE, { id, name: `N ${id}` })),
      ).toMatch(/a theme’s id is a ULID/);
    expect(
      error(
        await outcome(
          admin,
          `CREATE type::record('tag', rand::ulid()) SET name = 'Joy', category = 'theme',
             changedBy = user:admin, changedByRole = 'Admin'`,
        ),
      ),
    ).toBe('');
  });

  it('only api-admin’s login creates or renames themes', async () => {
    for (const s of SERVICES.filter((s) => s !== 'api_admin')) {
      const db = await t.service(s);
      await outcome(db, CREATE, { id: SPAM, name: 'Spam' });
      await outcome(db, `UPDATE tag:a SET name = 'Renamed'`);
    }
    const person = await t.person('user_admin');
    await outcome(person, CREATE, { id: SPAM, name: 'Spam' });
    await outcome(person, `UPDATE tag:a SET name = 'Renamed'`);
    expect(await themes()).toEqual(['a', 'b', 'c']);
    expect(await rows(migrator, 'SELECT VALUE name FROM tag:a')).toEqual(['A']);
  });

  it('names are unique ignoring case, and trimmed', async () => {
    expect(
      error(await outcome(admin, CREATE, { id: SPAM, name: 'a' })),
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
      error(await outcome(admin, CREATE, { id: SPAM, name: ' D' })),
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

/**
 * data/0009 (R2, Joel 2026-10-31): themes made with ids from their first name (tag:doubt) get
 * opaque ULID ids, and every link follows: drafts, published stories (and their tagIds, which
 * /v1/tags and browse filter on), and the main themes. The stories stay as they were (status,
 * public row), and a second run changes nothing.
 */
describe('data/0009: themes get opaque ids', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let bundle: string;
  const SCRIPT = join(SCHEMA_DIR, 'data', '0009-theme-ids.surql');

  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
    bundle = await mkdtemp(join(tmpdir(), 'bundle-before-0009-'));
    await cp(SCHEMA_DIR, bundle, { recursive: true });
    await rm(join(bundle, 'data', '0009-theme-ids.surql'));
    await t.migrate(undefined, { bundleDir: bundle });
    await t.createServices();
    await createPeople(t, {
      bob: 'user_bob',
      cat: 'user_cat',
      moderator: 'user_mod',
    });
    await trustSubmitters(t, 'bob');
    await publishDpa(t, 'v1');
    const bob = await t.person('user_bob');
    await grantAll(bob);
    const admin = await t.service('api_admin');
    migrator = await t.migrator();
    await run(
      migrator,
      `CREATE tag:doubt SET name = 'Doubt', category = 'journey'`,
    );
    for (const id of ['bob_draft', 'bob_live']) await draft(bob, id);
    await submit(bob, 'bob_live');
    await approve(admin, 'bob_live');
    // Themes as they were made before R2 (one with an id already opaque), on a draft and on the
    // published story, and in the main themes.
    await run(
      migrator,
      `CREATE tag:hope SET name = 'Hope', category = 'theme';
       CREATE tag:answered_prayers SET name = 'Answered Prayers', category = 'journey';
       CREATE type::record('tag', $ulid) SET name = 'Joy', category = 'emotion';
       UPDATE themeSettings:current SET mainThemes = [tag:hope, type::record('tag', $ulid), tag:doubt],
         mainThemesCount = 2;`,
      { ulid: JOY },
    );
    await rows(
      bob,
      `UPDATE story:bob_draft SET tagRefs = [tag:answered_prayers, tag:hope]`,
    );
    // A draft whose owner hasn't (or no longer has) Art 9 consent: re-pointing its links isn't
    // a change to their testimony, so it needs none.
    await run(
      migrator,
      `CREATE story:cat_draft CONTENT { submitter: user:cat, slug: 'cat-draft', title: 't',
         description: 'd', body: 'b', primaryFormat: 'written', tagRefs: [tag:hope] }`,
    );
    // A published story's tags, changed as api-admin re-syncs a story it approved.
    await run(
      migrator,
      `UPDATE story:bob_live SET tagRefs = [tag:doubt, type::record('tag', $ulid), tag:hope]`,
      { ulid: JOY },
    );
    await run(
      admin,
      `UPDATE publicStory:bob_live SET tagRefs = [tag:doubt, type::record('tag', $ulid), tag:hope],
         version = story:bob_live.version`,
      { ulid: JOY },
    );
  }, 3 * MIGRATION_TIMEOUT_MS);
  afterAll(async () => {
    await rm(bundle, { recursive: true, force: true });
    await t?.close();
  });

  /** Everything that names a theme, by the themes' names. */
  const snapshot = async () => {
    const [state] = await rows<Record<string, unknown>>(
      migrator,
      `RETURN {
         tags: (SELECT VALUE [record::id(id), name, category] FROM tag ORDER BY name),
         draft: story:bob_draft.tagRefs.map(|$t| $t.name),
         unconsented: story:cat_draft.tagRefs.map(|$t| $t.name),
         story: story:bob_live.{ status, tags: tagRefs.map(|$t| $t.name) },
         public: publicStory:bob_live.{ tags: tagRefs.map(|$t| $t.name),
           ids: tagIds, same: tagIds = tagRefs.map(|$t| <string> record::id($t)),
           mirrors: version = story:bob_live.version },
         main: fn::settings::main_themes(),
         mainNames: themeSettings:current.mainThemes.map(|$t| $t.name)
       }`,
    );
    return state;
  };

  it(
    'gives every theme an opaque id, moves every link to it and keeps the stories as they were; a second run changes nothing',
    async () => {
      await t.migrate();
      const after = await snapshot();
      const tags = after['tags'] as [string, string, string][];
      expect(tags.map(([, name, category]) => [name, category])).toEqual([
        ['Answered Prayers', 'journey'],
        ['Doubt', 'journey'],
        ['Hope', 'theme'],
        ['Joy', 'emotion'],
      ]);
      for (const [id] of tags)
        expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      const id = (name: string) => tags.find(([, n]) => n === name)?.[0];
      expect(id('Joy')).toBe(JOY);
      expect(after).toMatchObject({
        draft: ['Answered Prayers', 'Hope'],
        unconsented: ['Hope'],
        story: { status: 'approved', tags: ['Doubt', 'Joy', 'Hope'] },
        public: {
          tags: ['Doubt', 'Joy', 'Hope'],
          ids: [id('Doubt'), JOY, id('Hope')],
          same: true,
          mirrors: true,
        },
        main: [id('Hope'), JOY],
        mainNames: ['Hope', 'Joy', 'Doubt'],
      });

      await run(migrator, await readFile(SCRIPT, 'utf8'));
      expect(await snapshot()).toEqual(after);
      // The exemption is only for theme links: any other change still needs the consent.
      const changed = await outcome(
        migrator,
        `UPDATE story:cat_draft SET title = 'Changed'`,
      );
      expect(changed.ok ? '' : changed.error).toMatch(/Art 9 consent/);
    },
    3 * MIGRATION_TIMEOUT_MS,
  );
});

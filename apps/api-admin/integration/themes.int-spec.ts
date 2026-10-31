import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  buildWorld,
  createPeople,
  rows,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';

interface Picture {
  categories: {
    id: string;
    name: string;
    themes: { id: string; name: string; highlighted: boolean }[];
  }[];
}
interface AdminThemes extends Picture {
  version: number;
  categories: (Picture['categories'][number] & {
    themes: {
      id: string;
      name: string;
      highlighted: boolean;
      storyCount: number;
    }[];
  })[];
}

/**
 * /admin/themes' API (themes plan v3) through api-admin's real AppModule on its own login and a
 * real SurrealDB: the page reads every category and theme with the version, holds its changes,
 * and saves the whole finished picture at that version in one transaction. Every answer is
 * checked against api-admin.yaml.
 */
describe('themes (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let url: string;

  const as = (clerkUserId: string, role = 'Admin') => ({
    authorization: `Bearer ${clerk.token(clerkUserId, { role })}`,
  });
  const admin = () => as('user_admin');

  async function read(who = admin()) {
    const res = await fetch(`${url}/v1/admin/themes`, { headers: who });
    expect(await contract.check('GET', res)).toEqual([]);
    return res;
  }
  const picture = async () => (await (await read()).json()) as AdminThemes;
  async function save(body: unknown, version: number | null, who = admin()) {
    const res = await fetch(`${url}/v1/admin/themes`, {
      method: 'PUT',
      headers: {
        ...who,
        'content-type': 'application/json',
        ...(version === null ? {} : { 'if-match': `"${version}"` }),
      },
      body: JSON.stringify(body),
    });
    expect(await contract.check('PUT', res)).toEqual([]);
    return res;
  }
  /** The page's picture without the story counts, as SaveThemes takes it. */
  const asSent = (p: AdminThemes): Picture => ({
    categories: p.categories.map((c) => ({
      id: c.id,
      name: c.name,
      themes: c.themes.map(({ id, name, highlighted }) => ({
        id,
        name,
        highlighted,
      })),
    })),
  });
  /** Names only, for comparing pictures. */
  const shape = (p: Picture) =>
    p.categories.map((c) => [
      c.name,
      c.themes.map((th) => `${th.name}${th.highlighted ? ' ★' : ''}`),
    ]);
  const problem = async (res: Response) =>
    (await res.json()) as {
      code: string;
      detail?: string;
      errors?: { pointer: string; code: string }[];
    };

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    // Ann's and Bob's stories carry theme:common (in Other); bob_live is published.
    await buildWorld(t);
    await createPeople(t, { admin: 'user_admin' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_admin'))
      .overrideProvider(CLERK_CONFIG)
      .useValue(
        parseClerkConfig({
          issuer: clerk.issuer,
          publicKeyPem: clerk.publicKeyPem,
          authorizedParties: clerk.authorizedParty,
        }),
      )
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    useBodyParser(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('is for admins only', async () => {
    expect((await read(as('user_admin', 'Moderator'))).status).toBe(403);
    expect(
      (await save({ categories: [] }, 0, as('user_admin', 'Moderator'))).status,
    ).toBe(403);
  });

  it('reads every category and theme, Other last, with how many stories carry each theme', async () => {
    const p = await picture();
    expect(p.version).toBe(0);
    expect(p.categories.map((c) => c.id)).toContain('other');
    const other = p.categories.find((c) => c.id === 'other');
    // buildWorld's five stories carry Common; Doubt is on none.
    expect(other?.themes).toEqual([
      { id: 'common', name: 'Common', highlighted: false, storyCount: 5 },
      { id: 'doubt', name: 'Doubt', highlighted: false, storyCount: 0 },
    ]);
  });

  it('saves the whole picture at once: new categories and themes, names tidied, at the version read', async () => {
    const before = await picture();
    const sent = asSent(before);
    sent.categories.unshift({
      id: 'new-1',
      name: '  feelings   of  the heart ',
      themes: [
        { id: 'new-2', name: 'hope', highlighted: true },
        { id: 'new-3', name: ' grief', highlighted: false },
      ],
    });
    // Doubt moves into the new category, highlighted.
    const other = sent.categories.find((c) => c.id === 'other');
    other!.themes = other!.themes.filter((th) => th.id !== 'doubt');
    sent.categories[0].themes.push({
      id: 'doubt',
      name: 'Doubt',
      highlighted: true,
    });

    const res = await save(sent, before.version);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"1"');

    const after = await picture();
    expect(after.version).toBe(1);
    expect(shape(after)).toEqual([
      ['Feelings of the heart', ['Doubt ★', 'Grief', 'Hope ★']],
      ['Other', ['Common']],
    ]);
    for (const c of after.categories) {
      for (const th of c.themes) {
        if (!['common', 'doubt'].includes(th.id)) {
          expect(th.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        }
      }
    }
    expect(
      await rows(
        migrator,
        `SELECT VALUE record::id(actor) FROM auditLog WHERE action = 'SaveThemes'`,
      ),
    ).toEqual(['admin']);
  });

  it('refuses a picture from an older version, so nobody overwrites another admin’s save (A2)', async () => {
    const p = await picture();
    const first = asSent(p);
    first.categories[0].name = 'Feelings';
    expect((await save(first, p.version)).status).toBe(200);
    // A second admin who loaded the same version.
    const second = asSent(p);
    second.categories[0].name = 'Emotions';
    const res = await save(second, p.version);
    expect(res.status).toBe(412);
    expect((await problem(res)).detail).toBe(
      'Someone else changed themes. Reload to see their changes',
    );
    expect(shape(await picture())[0][0]).toBe('Feelings');
    expect((await save(second, null)).status).toBe(428);
  });

  it('refuses duplicate names ignoring case, and a renamed or missing Other, writing nothing', async () => {
    const p = await picture();
    const cases: [string, (s: Picture) => void, string][] = [
      [
        'a theme name twice',
        (s) =>
          s.categories[1].themes.push({
            id: 'new-x',
            name: 'HOPE',
            highlighted: false,
          }),
        'duplicate',
      ],
      [
        'a category name twice',
        (s) => s.categories.push({ id: 'new-y', name: 'feelings', themes: [] }),
        'duplicate',
      ],
      [
        'Other renamed',
        (s) => {
          s.categories[1].name = 'Misc';
        },
        'other_fixed',
      ],
      [
        'Other missing',
        (s) => {
          s.categories[0].themes.push(...s.categories[1].themes);
          s.categories.splice(1, 1);
        },
        'other_required',
      ],
      [
        'an empty name',
        (s) => {
          s.categories[0].themes[0].name = '   ';
        },
        'length',
      ],
    ];
    for (const [what, change, code] of cases) {
      const sent = asSent(p);
      change(sent);
      const res = await save(sent, p.version);
      expect([what, res.status]).toEqual([what, 400]);
      expect([what, (await problem(res)).errors?.map((e) => e.code)]).toEqual([
        what,
        [code],
      ]);
    }
    expect(await picture()).toEqual(p);
  });

  it('deletes what the picture leaves out: a theme comes off every story, a category’s themes move to Other', async () => {
    const p = await picture();
    const sent = asSent(p);
    // Delete Common (on every story) and the Feelings category, whose remaining themes the page
    // moves to Other, not highlighted.
    const feelings = sent.categories[0];
    const other = sent.categories[1];
    other.themes = [
      ...feelings.themes.map((th) => ({ ...th, highlighted: false })),
    ];
    sent.categories = [other];
    expect((await save(sent, p.version)).status).toBe(200);

    expect(shape(await picture())).toEqual([
      ['Other', ['Doubt', 'Grief', 'Hope']],
    ]);
    expect(
      await rows(
        migrator,
        `SELECT VALUE array::len(themeRefs) FROM story WHERE id IN [story:bob_live, story:ann_draft]`,
      ),
    ).toEqual([0, 0]);
    expect(
      await rows(
        migrator,
        'SELECT VALUE themeIds FROM ONLY publicStory:bob_live',
      ),
    ).toEqual([]);
    expect(
      await rows(migrator, 'SELECT VALUE name FROM themeCategory'),
    ).toEqual(['Other']);
  });

  it('a save with a theme id that doesn’t exist is refused', async () => {
    const p = await picture();
    const sent = asSent(p);
    sent.categories[0].themes.push({
      id: 'nothere',
      name: 'Nothere',
      highlighted: false,
    });
    const res = await save(sent, p.version);
    expect(res.status).toBe(400);
    expect((await problem(res)).errors?.[0].code).toBe('not_found');
    expect(await picture()).toEqual(p);
  });
});

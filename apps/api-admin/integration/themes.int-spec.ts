import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  createPeople,
  rows,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';

/**
 * Themes and the main themes (O5, Joel 2026-10-31) through api-admin's real AppModule on its own
 * login (D13) and a real SurrealDB, as /admin/themes calls them: add a theme (its slug from its
 * name), rename one at the version read, and save the main themes and how many people see. Every
 * answer is checked against api-admin.yaml. That no login can delete a theme is the database's
 * (libs/database themes.int-spec); there is no route for it.
 */
describe('themes (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let url: string;

  const as = (role = 'Admin') => ({
    authorization: `Bearer ${clerk.token('user_admin', { role })}`,
  });
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    who = as(),
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...who,
        ...(body === undefined
          ? {}
          : {
              'content-type':
                method === 'PATCH'
                  ? 'application/merge-patch+json'
                  : 'application/json',
            }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(await contract.check(method, res)).toEqual([]);
    return res;
  }
  const json = async <T = Record<string, unknown>>(res: Response) =>
    (await res.json()) as T;
  const themes = async () =>
    (
      await json<{ data: { slug: string; name: string; version: number }[] }>(
        await call('GET', '/v1/admin/themes'),
      )
    ).data;

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    await createPeople(t, { admin: 'user_admin' });
    await rows(
      migrator,
      `CREATE tag:hope SET name = 'Hope', category = 'theme';
       CREATE tag:doubt SET name = 'Doubt', category = 'journey';`,
    );
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
    useBodyParser(app); // as main.ts
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('an admin adds a theme: its slug comes from the name, a taken slug gets a number, a taken name is 409', async () => {
    const added = await call('POST', '/v1/admin/themes', {
      name: '  Mental   Health ',
    });
    expect(added.status).toBe(201);
    expect(added.headers.get('location')).toBe(
      '/v1/admin/themes/mental-health',
    );
    expect(await json(added)).toEqual({ id: 'mental-health', version: 1 });
    // Accents dropped; the slug "hope" is taken, so the next number.
    expect(
      await json(await call('POST', '/v1/admin/themes', { name: 'Hopé' })),
    ).toEqual({ id: 'hope-2', version: 1 });
    // The same name in another case.
    const taken = await call('POST', '/v1/admin/themes', {
      name: 'mental health',
    });
    expect(taken.status).toBe(409);
    expect(await json(taken)).toMatchObject({ code: 'name_taken' });
    for (const body of [
      { name: '' },
      { name: 'x'.repeat(41) },
      {},
      { name: 'A', slug: 'a' },
    ]) {
      expect((await call('POST', '/v1/admin/themes', body)).status).toBe(400);
    }
    expect((await themes()).map((x) => x.name)).toEqual([
      'Doubt',
      'Hope',
      'Hopé',
      'Mental Health',
    ]);
    expect(
      await rows(
        migrator,
        `SELECT action, record::id(actor) AS actor, actorRole, createdAt FROM auditLog
         WHERE action = 'CreateTag' ORDER BY createdAt`,
      ).then((r) => r.map(({ createdAt: _c, ...rest }) => rest)),
    ).toEqual([
      { action: 'CreateTag', actor: 'admin', actorRole: 'Admin' },
      { action: 'CreateTag', actor: 'admin', actorRole: 'Admin' },
    ]);
  });

  it('an admin renames a theme at the version read; the slug stays; stale, missing If-Match and taken names are refused', async () => {
    const renamed = await call(
      'PATCH',
      '/v1/admin/themes/doubt',
      { name: 'Doubt and questions' },
      { 'if-match': '"1"' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.headers.get('etag')).toBe('"2"');
    expect(await json(renamed)).toEqual({ id: 'doubt', version: 2 });
    expect(await rows(migrator, `SELECT VALUE name FROM tag:doubt`)).toEqual([
      'Doubt and questions',
    ]);

    const stale = await call(
      'PATCH',
      '/v1/admin/themes/doubt',
      { name: 'Doubts' },
      { 'if-match': '"1"' },
    );
    expect(stale.status).toBe(412);
    expect(
      (await call('PATCH', '/v1/admin/themes/doubt', { name: 'Doubts' }))
        .status,
    ).toBe(428);
    const taken = await call(
      'PATCH',
      '/v1/admin/themes/doubt',
      { name: 'HOPE' },
      { 'if-match': '"2"' },
    );
    expect(taken.status).toBe(409);
    expect(
      (
        await call(
          'PATCH',
          '/v1/admin/themes/nope',
          { name: 'Nope' },
          { 'if-match': '"1"' },
        )
      ).status,
    ).toBe(404);
    expect(await rows(migrator, `SELECT VALUE name FROM tag:doubt`)).toEqual([
      'Doubt and questions',
    ]);
  });

  it('an admin saves the main themes and how many people see; people get the first ones, in order', async () => {
    const first = await call('GET', '/v1/admin/main-themes');
    expect(first.headers.get('etag')).toBe('"1"');
    expect(await json(first)).toMatchObject({
      version: 1,
      changedBy: null,
      mainThemes: [],
      mainThemesCount: 10,
    });
    const saved = await call(
      'PUT',
      '/v1/admin/main-themes',
      { mainThemes: ['mental-health', 'doubt', 'hope'], mainThemesCount: 2 },
      { 'if-match': '"1"' },
    );
    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual({ id: 'current', version: 2 });
    expect(await rows(migrator, 'RETURN fn::settings::main_themes()')).toEqual([
      'mental-health',
      'doubt',
    ]);
    expect(
      await json(await call('GET', '/v1/admin/main-themes')),
    ).toMatchObject({
      version: 2,
      changedBy: 'admin',
      mainThemes: ['mental-health', 'doubt', 'hope'],
      mainThemesCount: 2,
    });
    // Admins choose the number: no upper cap (Joel, 2026-10-31).
    expect(
      (
        await call(
          'PUT',
          '/v1/admin/main-themes',
          { mainThemes: ['hope'], mainThemesCount: 250 },
          { 'if-match': '"2"' },
        )
      ).status,
    ).toBe(200);
  });

  it('refuses unknown or repeated themes, a count below 1, a stale save and anyone below Admin', async () => {
    const put = (body: unknown, version = '"3"', who = as()) =>
      call('PUT', '/v1/admin/main-themes', body, { 'if-match': version }, who);
    const cases: [unknown, string][] = [
      [{ mainThemes: ['hope', 'nope'], mainThemesCount: 2 }, '/mainThemes/1'],
      [{ mainThemes: ['hope', 'hope'], mainThemesCount: 2 }, '/mainThemes/1'],
      [{ mainThemes: ['hope'], mainThemesCount: 0 }, '/mainThemesCount'],
      [{ mainThemes: ['hope'], mainThemesCount: 1.5 }, '/mainThemesCount'],
      [{ mainThemes: 'hope', mainThemesCount: 1 }, '/mainThemes'],
    ];
    for (const [body, pointer] of cases) {
      const res = await put(body);
      expect([pointer, res.status]).toEqual([pointer, 400]);
      expect(
        (await json<{ errors: { pointer: string }[] }>(res)).errors[0].pointer,
      ).toBe(pointer);
    }
    const ok = { mainThemes: ['hope'], mainThemesCount: 1 };
    expect((await put(ok, '"2"')).status).toBe(412);
    expect((await put(ok, '"3"', as('Moderator'))).status).toBe(403);
    expect(
      (await call('POST', '/v1/admin/themes', { name: 'Joy' }, {}, as('User')))
        .status,
    ).toBe(403);
    expect(
      await rows(migrator, 'SELECT VALUE version FROM themeSettings:current'),
    ).toEqual([3]);
  });
});

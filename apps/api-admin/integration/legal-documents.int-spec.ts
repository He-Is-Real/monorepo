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
 * The four legal texts (plan 4e) through api-admin's real AppModule on its own login (D13) and a
 * real SurrealDB, as /admin/consent calls them: read the latest with every version, and save the
 * next version with its audit row. Every answer is checked against api-admin.yaml.
 */
describe('legal texts (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let url: string;

  const as = (clerkUserId: string, role = 'Admin') => ({
    authorization: `Bearer ${clerk.token(clerkUserId, { role })}`,
  });
  const PATH = '/v1/admin/legal-documents/testimony-consent/versions';

  async function list(who = as('user_admin'), path = PATH) {
    const res = await fetch(`${url}${path}`, { headers: who });
    expect(await contract.check('GET', res)).toEqual([]);
    return res;
  }
  async function save(body: unknown, who = as('user_admin'), path = PATH) {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { ...who, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(await contract.check('POST', res)).toEqual([]);
    return res;
  }
  const versions = () =>
    rows(
      migrator,
      `SELECT VALUE record::id(id) FROM testimonyConsent ORDER BY id`,
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    await createPeople(t, {
      admin: 'user_admin',
      superadmin: 'user_superadmin',
      moderator: 'user_moderator',
    });
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

  it('an admin reads the latest text and saves the next version, in force at once, with its audit row', async () => {
    const first = await list();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const before = await first.json();
    expect(before).toMatchObject({
      document: 'testimony-consent',
      latest: { version: 0, content: expect.any(String) },
      data: [{ version: 0 }],
    });

    const saved = await save({
      version: 1,
      content: '## Testimony consent\r\n\r\nVersion 1.',
    });
    expect(saved.status).toBe(201);
    expect(saved.headers.get('location')).toBe(PATH);
    const { version, releaseDate } = await saved.json();
    expect(version).toBe(1);

    const after = await (await list()).json();
    expect(after.latest).toEqual({
      version: 1,
      releaseDate,
      // Line ends are stored as \n.
      content: '## Testimony consent\n\nVersion 1.',
    });
    expect(after.data.map((v: { version: number }) => v.version)).toEqual([
      1, 0,
    ]);
    expect(
      await rows(
        migrator,
        `SELECT service, actorRole, record::id(actor) AS actor, <string> entity AS entity
           FROM auditLog WHERE action = 'PublishLegalVersion'`,
      ),
    ).toEqual([
      {
        service: 'api-admin',
        actorRole: 'Admin',
        actor: 'admin',
        entity: 'testimonyConsent:1',
      },
    ]);

    // A Super Admin may too.
    const next = await save(
      { version: 2, content: 'Version 2.' },
      as('user_superadmin', 'SuperAdmin'),
    );
    expect(next.status).toBe(201);
    expect(await versions()).toEqual([0, 1, 2]);
  });

  it('refuses a number that isn’t the next one (another admin saved meanwhile) with 409, writing nothing', async () => {
    const audits = () =>
      rows(
        migrator,
        `SELECT VALUE id FROM auditLog WHERE action = 'PublishLegalVersion'`,
      );
    const before = (await audits()).length;
    for (const version of [2, 1, 4]) {
      const res = await save({ version, content: 'A stale edit.' });
      expect(res.status, String(version)).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'document_changed' });
    }
    expect(await versions()).toEqual([0, 1, 2]);
    expect(await audits()).toHaveLength(before);
  });

  it('is for Admin and Super Admin only', async () => {
    const mod = as('user_moderator', 'Moderator');
    expect((await list(mod)).status).toBe(403);
    const res = await save({ version: 3, content: 'Not mine to save.' }, mod);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'role_required' });
    expect(await versions()).toEqual([0, 1, 2]);
  });

  it('answers 400 for a body that isn’t a version and its text, and 404 for an unknown text', async () => {
    for (const body of [
      {},
      { version: 3 },
      { version: 3, content: '   ' },
      { version: -1, content: 'x' },
      { version: 3, content: 'x', basedOn: 2 },
    ]) {
      expect((await save(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await list(undefined, '/v1/admin/legal-documents/privacy/versions'))
        .status,
    ).toBe(404);
    expect(await versions()).toEqual([0, 1, 2]);
  });
});

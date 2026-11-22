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
import { STAFF_CLERK } from '../src/app/staff/staff-clerk';

/**
 * The Block list page's routes (G21 D, G24; Joel 2026-11-11) through api-admin's real AppModule on
 * its own login and a real SurrealDB: an Admin lists, adds and removes blocked emails and IP
 * addresses, each kept in one form and naming the Admin who added it; nobody else may use them.
 * Every answer is checked against api-admin.yaml. What a block does is api-user's (its own
 * integration tests).
 */
describe('the block list (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: NestExpressApplication;
  let url: string;

  const as = (sub: string, role: string) => ({
    authorization: `Bearer ${clerk.token(sub, { role })}`,
  });
  const admin = () => as('user_admin', 'Admin');

  async function call(
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    who: Record<string, string> = admin(),
    body?: unknown,
  ) {
    const res = await fetch(`${url}/v1/admin/block-list${path}`, {
      method,
      headers:
        body === undefined
          ? who
          : {
              ...who,
              'content-type':
                method === 'PATCH'
                  ? 'application/merge-patch+json'
                  : 'application/json',
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  const blockEmail = (email: string, who = admin()) =>
    call('PUT', `/emails/${encodeURIComponent(email)}`, who);
  const blockIp = (ip: string, who = admin()) =>
    call('PUT', `/ips/${encodeURIComponent(ip)}`, who);
  const stored = async () => ({
    emails: await rows(migrator, 'SELECT VALUE email FROM blockedEmail'),
    ips: (
      await rows<string>(migrator, 'SELECT VALUE ip FROM blockedIp')
    ).sort(),
  });

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    await createPeople(t, {
      admin: 'user_admin',
      other: 'user_other',
      moderator: 'user_mod',
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
      // The Staff page's Clerk client, off: the baseline step doesn't run.
      .overrideProvider(STAFF_CLERK)
      .useValue({ enabled: false, setRole: async () => ({ count: 0 }) })
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
  beforeEach(() => migrator.query('DELETE blockedEmail; DELETE blockedIp;'));

  it('an Admin adds emails and IP addresses, sees who added each and when, and removes them', async () => {
    expect(await blockEmail('Spammer@Example.com')).toEqual({
      status: 200,
      body: { id: 'spammer@example.com', version: null },
    });
    expect((await blockIp('203.0.113.7')).status).toBe(200);
    expect((await blockIp('2001:DB8:0:0:0:0:0:1')).body.id).toBe('2001:db8::1');
    // Adding again changes nothing.
    expect((await blockEmail('spammer@example.com')).status).toBe(200);

    const list = await call('GET', '');
    expect(list.status).toBe(200);
    expect(list.body.emails).toEqual([
      {
        email: 'spammer@example.com',
        addedBy: 'admin@heisreal.today',
        addedAt: expect.any(String),
        note: null,
      },
    ]);
    expect(
      list.body.ips.map((r: { ip: string; addedBy: string }) => [
        r.ip,
        r.addedBy,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['203.0.113.7', 'admin@heisreal.today'],
        ['2001:db8::1', 'admin@heisreal.today'],
      ]),
    );

    expect(
      (await call('DELETE', `/ips/${encodeURIComponent('2001:db8::1')}`))
        .status,
    ).toBe(204);
    expect(
      (
        await call(
          'DELETE',
          `/emails/${encodeURIComponent('SPAMMER@example.com')}`,
        )
      ).status,
    ).toBe(204);
    // Removing what isn't there changes nothing.
    expect((await call('DELETE', '/emails/nobody%40example.com')).status).toBe(
      204,
    );
    expect(await stored()).toEqual({ emails: [], ips: ['203.0.113.7'] });
  });

  it('refuses what isn’t an email or an IP address, adding nothing', async () => {
    for (const email of ['not-an-email', 'a@b', ' ']) {
      const res = await blockEmail(email);
      expect(res.status, email).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    for (const ip of ['999.1.1.1', 'example.com', '1.2.3']) {
      expect((await blockIp(ip)).status, ip).toBe(400);
    }
    expect(await stored()).toEqual({ emails: [], ips: [] });
  });

  it('keeps an optional note: given when blocking, changed by any Admin, never over 500 characters', async () => {
    const email = `/emails/${encodeURIComponent('spam@example.com')}`;
    expect(
      (
        await call('PUT', email, admin(), {
          note: '  Advert stories, 20 Nov.  ',
        })
      ).status,
    ).toBe(200);
    // Blocking again keeps the first note.
    await call('PUT', email, admin(), { note: 'Something else' });
    expect(
      (await call('PUT', '/ips/203.0.113.7', admin(), { note: '   ' })).status,
    ).toBe(200);
    const notes = async () => {
      const { body } = await call('GET', '');
      return [
        ...body.emails.map((e: { note: string | null }) => e.note),
        ...body.ips.map((e: { note: string | null }) => e.note),
      ];
    };
    expect(await notes()).toEqual(['Advert stories, 20 Nov.', null]);

    // Another Admin fills in and changes notes later; a blank one clears it.
    const other = as('user_other', 'Admin');
    expect(
      await call('PATCH', '/ips/203.0.113.7', other, { note: 'Same sender' }),
    ).toEqual({ status: 200, body: { id: '203.0.113.7', version: null } });
    expect((await call('PATCH', email, other, { note: '' })).status).toBe(200);
    expect(await notes()).toEqual([null, 'Same sender']);

    const tooLong = await call('PATCH', email, admin(), {
      note: 'x'.repeat(501),
    });
    expect([tooLong.status, tooLong.body.errors?.[0]?.pointer]).toEqual([
      400,
      '/note',
    ]);
    expect(
      (
        await call('PUT', '/emails/new%40example.com', admin(), {
          note: 'x'.repeat(501),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', '/emails/nobody%40example.com', admin(), {
          note: 'x',
        })
      ).status,
    ).toBe(404);
    expect(await stored()).toEqual({
      emails: ['spam@example.com'],
      ips: ['203.0.113.7'],
    });
  });

  it('is for Admins only: a Moderator or a User is refused on every route, changing nothing', async () => {
    await blockEmail('spammer@example.com');
    for (const who of [as('user_mod', 'Moderator'), as('user_mod', 'User')]) {
      for (const res of [
        await call('GET', '', who),
        await blockEmail('other@example.com', who),
        await blockIp('203.0.113.9', who),
        await call('PATCH', '/emails/spammer%40example.com', who, {
          note: 'x',
        }),
        await call('DELETE', '/emails/spammer%40example.com', who),
        await call('DELETE', '/ips/203.0.113.9', who),
      ]) {
        expect([res.status, res.body.code]).toEqual([403, 'role_required']);
      }
    }
    expect(await stored()).toEqual({
      emails: ['spammer@example.com'],
      ips: [],
    });
  });
});

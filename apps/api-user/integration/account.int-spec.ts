import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  publishVersion,
  rows,
  run,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';

/**
 * The account bootstrap (M2, `GET /v1/account`) and agreeing (plan 4e,
 * `POST /v1/account/agreements/{agreement}`) on SurrealDB 3.2.4, through api-user's real
 * AppModule on its own login (D13), as web's header calls it after each sign-in. Every answer
 * is checked against api-user.yaml, like web's e2e stub of it.
 */
/** api-user's real AppModule on a database of its own, with the calls the tests make. */
async function startApiUser() {
  const contract = new Contract('api-user.yaml');
  const t = await TestDatabase.create();
  const clerk: TestClerk = newTestClerk(t.keys, {
    namespace: t.namespace,
    database: t.database,
  });
  const migrator: Surreal = await t.migrator();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SURREAL)
    .useValue(await t.service('api_user'))
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
  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  const as = (clerkUserId: string, claims?: Record<string, unknown>) => ({
    authorization: `Bearer ${clerk.token(clerkUserId, claims)}`,
  });
  return {
    t,
    as,
    get: async (headers: Record<string, string> = {}) => {
      const res = await fetch(`${url}/v1/account`, { headers });
      expect(await contract.check('GET', res)).toEqual([]);
      return res;
    },
    agree: async (clerkUserId: string, agreement: string, body: unknown) => {
      const res = await fetch(`${url}/v1/account/agreements/${agreement}`, {
        method: 'POST',
        headers: { ...as(clerkUserId), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(await contract.check('POST', res)).toEqual([]);
      return res;
    },
    pointers: (clerkUserId: string) =>
      rows(
        migrator,
        `SELECT termsOfUse, termsOfUseAgreedAt, testimonyConsent, testimonyConsentAgreedAt
           FROM user WHERE clerkUserId = $c`,
        { c: clerkUserId },
      ),
    usersFor: (clerkUserId: string) =>
      // `key`: the record id's own value. Printed, an id can come escaped (`user:⟨…⟩`).
      rows(
        migrator,
        'SELECT id, record::id(id) AS key, createdAt FROM user WHERE clerkUserId = $c',
        { c: clerkUserId },
      ),
    close: async () => {
      await app.close();
      await t.close();
    },
  };
}

describe('GET /v1/account, the account bootstrap', () => {
  // This database never gets a newer version of a text: the test that publishes one has its own.
  let api: Awaited<ReturnType<typeof startApiUser>>;
  beforeAll(async () => {
    api = await startApiUser();
  });
  afterAll(async () => {
    await api?.close();
  });

  it('creates a newcomer’s account on their first call, then answers the same account', async () => {
    expect(await api.usersFor('user_firstvisit')).toHaveLength(0);

    const first = await api.get(api.as('user_firstvisit'));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const account = await first.json();
    const [row] = await api.usersFor('user_firstvisit');
    expect(account).toEqual({
      id: row['key'],
      version: null,
      role: 'User',
      createdAt: new Date(String(row['createdAt'])).toISOString(),
      // Nothing agreed yet: the site shows the terms (version 0 from the migration) first.
      termsOfUse: { agreed: null, latestVersion: 0, upToDate: false },
      testimonyConsent: { agreed: null, latestVersion: 0, upToDate: false },
    });

    const again = await api.get(api.as('user_firstvisit'));
    expect(await again.json()).toEqual(account);
    expect(await api.usersFor('user_firstvisit')).toHaveLength(1);
  });

  it('a blocked email can’t create an account; someone who already has one keeps it (block list, G21 D)', async () => {
    const blocked = { email: 'blocked@example.com', email_verified: true };
    // Already has an account before the block.
    expect((await api.get(api.as('user_beforeblock', blocked))).status).toBe(
      200,
    );
    await run(
      await api.t.service('api_admin'),
      `CREATE blockedEmail:⟨blocked@example.com⟩ SET email = 'blocked@example.com', addedBy = 'joel@heisreal.today'`,
    );

    const refused = await api.get(api.as('user_blocked1', blocked));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'blocked' });
    expect(await api.usersFor('user_blocked1')).toHaveLength(0);

    expect((await api.get(api.as('user_beforeblock', blocked))).status).toBe(
      200,
    );
    // Another email is unaffected.
    const other = await api.get(
      api.as('user_notblocked', {
        email: 'fine@example.com',
        email_verified: true,
      }),
    );
    expect(other.status).toBe(200);
  });

  describe('agreeing (plan 4e)', () => {
    it('records the latest terms with the database’s time, and answers the same when sent again', async () => {
      await api.get(api.as('user_agrees'));
      const res = await api.agree('user_agrees', 'terms-of-use', {
        version: 0,
      });
      expect(res.status).toBe(200);
      const state = await res.json();
      expect(state).toEqual({
        agreed: { version: 0, agreedAt: expect.any(String) },
        latestVersion: 0,
        upToDate: true,
      });
      const [before] = await api.pointers('user_agrees');
      expect(before['termsOfUse']).toBe('termsOfUseAgreement:0');
      expect(new Date(String(before['termsOfUseAgreedAt'])).toISOString()).toBe(
        state.agreed.agreedAt,
      );

      // Idempotent: nothing moves, not even the time.
      const again = await api.agree('user_agrees', 'terms-of-use', {
        version: 0,
      });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(state);
      expect(await api.pointers('user_agrees')).toEqual([before]);

      const account = await (await api.get(api.as('user_agrees'))).json();
      expect(account.termsOfUse).toEqual(state);
      expect(account.testimonyConsent.agreed).toBeNull();
    });

    it.each([
      ['privacy-notice', { version: 0 }],
      ['terms-of-use', {}],
      ['terms-of-use', { version: '0' }],
      ['terms-of-use', { version: 0, extra: true }],
    ])('answers 400 for %s with %j', async (agreement, body) => {
      const res = await api.agree('user_agrees', agreement, body);
      expect(res.status).toBe(400);
    });
  });

  // Publishing a newer version changes every account's latest: on a database of its own.
  describe('after a newer version is published', () => {
    let fresh: Awaited<ReturnType<typeof startApiUser>>;
    beforeAll(async () => {
      fresh = await startApiUser();
    });
    afterAll(async () => {
      await fresh?.close();
    });

    it('asks again after a newer version is saved, and refuses the old one with 409', async () => {
      await fresh.get(fresh.as('user_reagrees'));
      await fresh.agree('user_reagrees', 'testimony-consent', { version: 0 });
      const version = await publishVersion(fresh.t, 'testimonyConsent');
      expect(version).toBe(1);

      const account = await (await fresh.get(fresh.as('user_reagrees'))).json();
      expect(account.testimonyConsent).toMatchObject({
        agreed: { version: 0 },
        latestVersion: 1,
        upToDate: false,
      });

      // The page showed version 0: a newer one was saved meanwhile.
      const stale = await fresh.agree('user_reagrees', 'testimony-consent', {
        version: 0,
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: 'agreement_version_changed',
      });
      const unknown = await fresh.agree('user_reagrees', 'testimony-consent', {
        version: 7,
      });
      expect(unknown.status).toBe(409);
      expect(
        (await fresh.pointers('user_reagrees'))[0]['testimonyConsent'],
      ).toBe('testimonyConsent:0');

      const ok = await fresh.agree('user_reagrees', 'testimony-consent', {
        version: 1,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        agreed: { version: 1 },
        latestVersion: 1,
        upToDate: true,
      });
    });
  });

  it('gives staff their row too, with their role from the token', async () => {
    const res = await api.get(
      api.as('user_newmoderator', { role: 'Moderator' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('Moderator');
    // api-admin can now find them (it can't create rows, D13).
    expect(await api.usersFor('user_newmoderator')).toHaveLength(1);
  });

  it('answers 304 to its own ETag', async () => {
    const first = await api.get(api.as('user_etag2'));
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/"/);
    const res = await api.get({
      ...api.as('user_etag2'),
      'if-none-match': etag,
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
  });

  it('refuses a missing or forged token, and a Viewer, as problems', async () => {
    const none = await api.get();
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ status: 401 });

    const forged = newTestClerk();
    const res = await api.get({
      authorization: `Bearer ${forged.token('user_forged')}`,
    });
    expect(res.status).toBe(401);
    expect(await api.usersFor('user_forged')).toHaveLength(0);

    const viewer = await api.get(api.as('user_viewer', { role: 'Viewer' }));
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toMatchObject({
      status: 403,
      code: 'role_required',
    });
  });
});

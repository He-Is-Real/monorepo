import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  publishVersion,
  rows,
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
describe('GET /v1/account, the account bootstrap', () => {
  const contract = new Contract('api-user.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;

  const get = async (headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}/v1/account`, { headers });
    expect(await contract.check('GET', res)).toEqual([]);
    return res;
  };
  const agree = async (
    clerkUserId: string,
    agreement: string,
    body: unknown,
  ) => {
    const res = await fetch(`${url}/v1/account/agreements/${agreement}`, {
      method: 'POST',
      headers: { ...as(clerkUserId), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(await contract.check('POST', res)).toEqual([]);
    return res;
  };
  const pointers = (clerkUserId: string) =>
    rows(
      migrator,
      `SELECT termsOfUse, termsOfUseAgreedAt, testimonyConsent, testimonyConsentAgreedAt
         FROM user WHERE clerkUserId = $c`,
      { c: clerkUserId },
    );
  const as = (clerkUserId: string, claims?: Record<string, unknown>) => ({
    authorization: `Bearer ${clerk.token(clerkUserId, claims)}`,
  });
  const usersFor = (clerkUserId: string) =>
    rows(migrator, 'SELECT id, createdAt FROM user WHERE clerkUserId = $c', {
      c: clerkUserId,
    });

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
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
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('creates a newcomer’s account on their first call, then answers the same account', async () => {
    expect(await usersFor('user_firstvisit')).toHaveLength(0);

    const first = await get(as('user_firstvisit'));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const account = await first.json();
    const [row] = await usersFor('user_firstvisit');
    expect(account).toEqual({
      id: String(row['id']).replace(/^user:/, ''),
      version: null,
      role: 'User',
      createdAt: new Date(String(row['createdAt'])).toISOString(),
      // Nothing agreed yet: the site shows the terms (version 0 from the migration) first.
      termsOfUse: { agreed: null, latestVersion: 0, upToDate: false },
      testimonyConsent: { agreed: null, latestVersion: 0, upToDate: false },
    });

    const again = await get(as('user_firstvisit'));
    expect(await again.json()).toEqual(account);
    expect(await usersFor('user_firstvisit')).toHaveLength(1);
  });

  describe('agreeing (plan 4e)', () => {
    it('records the latest terms with the database’s time, and answers the same when sent again', async () => {
      await get(as('user_agrees'));
      const res = await agree('user_agrees', 'terms-of-use', { version: 0 });
      expect(res.status).toBe(200);
      const state = await res.json();
      expect(state).toEqual({
        agreed: { version: 0, agreedAt: expect.any(String) },
        latestVersion: 0,
        upToDate: true,
      });
      const [before] = await pointers('user_agrees');
      expect(before['termsOfUse']).toBe('termsOfUseAgreement:0');
      expect(new Date(String(before['termsOfUseAgreedAt'])).toISOString()).toBe(
        state.agreed.agreedAt,
      );

      // Idempotent: nothing moves, not even the time.
      const again = await agree('user_agrees', 'terms-of-use', { version: 0 });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(state);
      expect(await pointers('user_agrees')).toEqual([before]);

      const account = await (await get(as('user_agrees'))).json();
      expect(account.termsOfUse).toEqual(state);
      expect(account.testimonyConsent.agreed).toBeNull();
    });

    it('asks again after a newer version is saved, and refuses the old one with 409', async () => {
      await get(as('user_reagrees'));
      await agree('user_reagrees', 'testimony-consent', { version: 0 });
      const version = await publishVersion(t, 'testimonyConsent');
      expect(version).toBe(1);

      const account = await (await get(as('user_reagrees'))).json();
      expect(account.testimonyConsent).toMatchObject({
        agreed: { version: 0 },
        latestVersion: 1,
        upToDate: false,
      });

      // The page showed version 0: a newer one was saved meanwhile.
      const stale = await agree('user_reagrees', 'testimony-consent', {
        version: 0,
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: 'agreement_version_changed',
      });
      const unknown = await agree('user_reagrees', 'testimony-consent', {
        version: 7,
      });
      expect(unknown.status).toBe(409);
      expect((await pointers('user_reagrees'))[0]['testimonyConsent']).toBe(
        'testimonyConsent:0',
      );

      const ok = await agree('user_reagrees', 'testimony-consent', {
        version: 1,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        agreed: { version: 1 },
        latestVersion: 1,
        upToDate: true,
      });
    });

    it.each([
      ['privacy-notice', { version: 0 }],
      ['terms-of-use', {}],
      ['terms-of-use', { version: '0' }],
      ['terms-of-use', { version: 0, extra: true }],
    ])('answers 400 for %s with %j', async (agreement, body) => {
      const res = await agree('user_agrees', agreement, body);
      expect(res.status).toBe(400);
    });
  });

  it('gives staff their row too, with their role from the token', async () => {
    const res = await get(as('user_newmoderator', { role: 'Moderator' }));
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('Moderator');
    // api-admin can now find them (it can't create rows, D13).
    expect(await usersFor('user_newmoderator')).toHaveLength(1);
  });

  it('answers 304 to its own ETag', async () => {
    const first = await get(as('user_etag2'));
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/"/);
    const res = await get({ ...as('user_etag2'), 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
  });

  it('refuses a missing or forged token, and a Viewer, as problems', async () => {
    const none = await get();
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ status: 401 });

    const forged = newTestClerk();
    const res = await get({
      authorization: `Bearer ${forged.token('user_forged')}`,
    });
    expect(res.status).toBe(401);
    expect(await usersFor('user_forged')).toHaveLength(0);

    const viewer = await get(as('user_viewer', { role: 'Viewer' }));
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toMatchObject({
      status: 403,
      code: 'role_required',
    });
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import { rows, TestDatabase } from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';

/**
 * The account bootstrap (M2, `GET /v1/account`) on SurrealDB 3.2.4, through api-user's real
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
      // No sign-up form is published yet (the consent-forms PR adds them).
      signupConsent: { accepted: false },
    });

    const again = await get(as('user_firstvisit'));
    expect(await again.json()).toEqual(account);
    expect(await usersFor('user_firstvisit')).toHaveLength(1);
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

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  consentEvent,
  createPeople,
  publishDpa,
  publishForm,
  rows,
  TestDatabase,
} from '@heisreal/database/integration-testing';
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
      // No sign-up form is published yet.
      signupConsent: { accepted: false },
      testimonyConsent: { acceptanceRequired: false },
    });

    const again = await get(as('user_firstvisit'));
    expect(await again.json()).toEqual(account);
    expect(await usersFor('user_firstvisit')).toHaveLength(1);
  });

  it('says whether the sign-up form in force is accepted: both boxes, on the latest version (D73)', async () => {
    await createPeople(t, { signer: 'user_signer' });
    await publishDpa(t, 'v1'); // and v1 of the three forms
    const accepted = async () =>
      (await (await get(as('user_signer'))).json()).signupConsent.accepted;
    expect(await accepted()).toBe(false);
    const signer = await t.person('user_signer');
    await consentEvent(signer, 'account_data', 'granted', 'v1');
    expect(await accepted()).toBe(false); // 18+ not ticked yet
    await consentEvent(signer, 'age_18plus', 'granted', 'v1');
    expect(await accepted()).toBe(true);
    // A newer sign-up version needs accepting again.
    await publishForm(t, 'signup', 'v2', { dpa: 'v1' });
    expect(await accepted()).toBe(false);
  });

  it('says when a newer testimony version must be accepted before a new story (D85, the banner)', async () => {
    await createPeople(t, { teller: 'user_teller' });
    const required = async () =>
      (await (await get(as('user_teller'))).json()).testimonyConsent
        .acceptanceRequired;
    const teller = await t.person('user_teller');
    // v1 of the forms is published (previous test). No testimony consent yet: nothing to ask.
    expect(await required()).toBe(false);
    await consentEvent(teller, 'special_category_religious', 'granted', 'v1');
    expect(await required()).toBe(false);
    // A newer version that doesn't require acceptance: still nothing to ask.
    await publishForm(t, 'testimony', 'v2', { dpa: 'v1' });
    expect(await required()).toBe(false);
    await publishForm(t, 'testimony', 'v3', {
      dpa: 'v1',
      requiresAcceptanceForNewSubmissions: true,
    });
    expect(await required()).toBe(true);
    // Accepting the version in force, as the banner's page does, moves the account to it (D85).
    const res = await fetch(`${url}/v1/account/consents`, {
      method: 'POST',
      headers: {
        ...as('user_teller'),
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        form: 'testimony',
        formVersion: 'v3',
        statement: 'special_category_religious',
        mechanism: 'reconsent_prompt',
        privacyPolicyVersion: 'v1',
      }),
    });
    expect(await contract.check('POST', res)).toEqual([]);
    expect(res.status).toBe(201);
    expect(await required()).toBe(false);
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

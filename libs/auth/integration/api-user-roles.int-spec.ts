import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountConsentsModule, ConsentModule } from '@heisreal/consent';
import { SURREAL } from '@heisreal/database';
import {
  publishDpa,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import type { Surreal } from 'surrealdb';
import { ClerkAuthModule } from '../src/lib/auth.module';
import { ApiUserAuthenticator } from '../src/lib/clerk-authenticator';
import { newTestClerk, useTestClerkEnv } from '../src/testing';

/**
 * Regression for #44 review round 1, as the reviewer reproduced it: api-user's real modules
 * (Clerk sign-in, the role guard, the consent guard and endpoints) on SurrealDB. A valid token
 * with `role: "Viewer"` must not read or grant consent: the contract's minimum is User.
 */
describe('api-user consent endpoints and the User minimum (D1)', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  let clerk: ReturnType<typeof newTestClerk>;

  beforeAll(async () => {
    t = await TestDatabase.create();
    await publishDpa(t, 'v1');
    clerk = useTestClerkEnv(
      newTestClerk(t.keys, { namespace: t.namespace, database: t.database }),
    );
    const connection: Surreal = await t.service('api_user');

    @Global()
    @Module({
      providers: [{ provide: SURREAL, useValue: connection }],
      exports: [SURREAL],
    })
    class ApiUserDatabase {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ApiUserDatabase,
        ClerkAuthModule.forRoot(),
        ConsentModule.forRoot({ authenticator: ApiUserAuthenticator }),
        AccountConsentsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  const call = (method: string, sub: string, role: string, body?: unknown) =>
    fetch(`${url}/v1/account/consents`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${clerk.token(sub, { role })}`,
        ...(method === 'POST'
          ? { 'idempotency-key': `key-${sub}-${role}-0123456789` }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const grant = {
    type: 'publish',
    dpaVersion: 'v1',
    mechanism: 'web_form_submission',
  };

  it('Viewer: 403 role_required on reading and on granting, and nothing is written', async () => {
    const read = await call('GET', 'user_viewer', 'Viewer');
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({
      code: 'role_required',
      requiredRole: 'User',
    });
    expect((await call('POST', 'user_viewer', 'Viewer', grant)).status).toBe(
      403,
    );
    const migrator = await t.migrator();
    const [[count]] = (await migrator
      .query(
        'SELECT VALUE count() FROM consent WHERE subject.clerkUserId = $s GROUP ALL',
        {
          s: 'user_viewer',
        },
      )
      .collect()) as [number[]];
    expect(count ?? 0).toBe(0);
  });

  it('User: reads (200) and grants (201)', async () => {
    expect((await call('GET', 'user_reader', 'User')).status).toBe(200);
    expect((await call('POST', 'user_reader', 'User', grant)).status).toBe(201);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk } from '@heisreal/auth/testing';
import { SURREAL } from '@heisreal/database';
import { TestDatabase } from '@heisreal/database/integration-testing';
import {
  RATE_LIMIT_CLOCK,
  RATE_LIMITS,
  RATE_LIMITS_ACTIVE,
} from '@heisreal/http';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { AppModule } from '../src/app/app.module';

const MINUTE = 60_000;
const LIMIT = RATE_LIMITS.deletion.limit;

/** Our generic server error (D30), the only thing a limited caller sees (RL-5). */
const GENERIC = {
  type: 'about:blank',
  title: 'Internal server error',
  status: 500,
};

/**
 * Rate limits on api-user (Joel 2026-11-21, RL-1..RL-9) through its real AppModule, per address,
 * on the test's clock (nothing waits on real time). Requests count before sign-in is checked, so
 * these send no token: each answers 401 until the caller is over the limit.
 */
describe('api-user rate limits', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  let clock = Date.UTC(2026, 10, 21, 12);

  beforeAll(async () => {
    t = await TestDatabase.create();
    const clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
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
      .overrideProvider(RATE_LIMITS_ACTIVE)
      .useValue(true)
      .overrideProvider(RATE_LIMIT_CLOCK)
      .useValue(() => clock)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });

    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  const send = (
    ip: string,
    method = 'DELETE',
    path = '/v1/stories/some-story',
  ) =>
    fetch(`${url}${path}`, {
      method,
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });

  it('gives a caller over the limit only the generic error, until the window slides on', async () => {
    const ip = '203.0.113.40';
    for (let i = 0; i < LIMIT; i++) {
      expect((await send(ip)).status).toBe(401);
    }
    const limited = await send(ip);
    expect(limited.status).toBe(500);
    expect(limited.headers.get('content-type')).toMatch(
      /^application\/problem\+json/,
    );
    expect(limited.headers.get('retry-after')).toBeNull();
    expect(await limited.json()).toEqual(GENERIC);

    // Another address isn't affected, and deleting (a story or the account) has its own count: reads still answer.
    expect((await send('203.0.113.41')).status).toBe(401);
    expect((await send(ip, 'GET', '/v1/account')).status).toBe(401);

    clock += 3 * MINUTE;
    expect((await send(ip)).status).toBe(401);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { useBodyParser } from '../src/app/body-parser';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { SURREAL } from '@heisreal/database';
import {
  createPeople,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import {
  RATE_LIMIT_CLOCK,
  RATE_LIMITS,
  RATE_LIMITS_ACTIVE,
} from '@heisreal/http';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { AppModule } from '../src/app/app.module';

const MINUTE = 60_000;
const LIMIT = RATE_LIMITS.staffRefused.limit;

/** Our generic server error (D30), the only thing a limited caller sees (RL-5). */
const GENERIC = {
  type: 'about:blank',
  title: 'Internal server error',
  status: 500,
};

/**
 * Rate limits on api-admin (RL-2, Joel 2026-11-21: "dont rate limit moderators or admins
 * themselves when authed but do rate limit unauthenticated requests strictly") through its real
 * AppModule and a real SurrealDB, on the test's clock (nothing waits on real time). Only
 * requests refused for sign-in count, per address; signed-in staff are never counted.
 */
describe('api-admin rate limits', () => {
  let t: TestDatabase;
  let clerk: TestClerk;
  let app: INestApplication;
  let url: string;
  let clock = Date.UTC(2026, 10, 21, 12);

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    await createPeople(t, {
      admin: 'user_admin',
      moderator: 'user_mod',
      member: 'user_member',
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
      .overrideProvider(RATE_LIMITS_ACTIVE)
      .useValue(true)
      .overrideProvider(RATE_LIMIT_CLOCK)
      .useValue(() => clock)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    useBodyParser(app as NestExpressApplication);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  const as = (sub: string, role: string) =>
    `Bearer ${clerk.token(sub, { role })}`;

  const send = (
    ip: string,
    {
      path = '/v1/admin/block-list',
      auth,
    }: { path?: string; auth?: string } = {},
  ) =>
    fetch(`${url}${path}`, {
      headers: {
        'x-forwarded-for': ip,
        ...(auth ? { authorization: auth } : {}),
      },
    });

  async function expectGeneric(res: Response) {
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(
      /^application\/problem\+json/,
    );
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual(GENERIC);
  }

  it('gives an address the generic error after 10 requests refused for sign-in, until the window slides on', async () => {
    const ip = '203.0.113.40';
    for (let i = 0; i < LIMIT; i++) {
      expect((await send(ip)).status).toBe(401);
    }
    await expectGeneric(await send(ip));
    // Before sign-in is checked: an Admin at the same address is turned away too (the accepted
    // side effect of a shared address), and another address isn't affected.
    await expectGeneric(await send(ip, { auth: as('user_admin', 'Admin') }));
    expect((await send('203.0.113.41')).status).toBe(401);

    clock += 2 * MINUTE;
    expect((await send(ip)).status).toBe(401);
  });

  it('counts a signed-in person who isn’t staff, and someone the database doesn’t know', async () => {
    const ip = '203.0.113.50';
    const member = as('user_member', 'User');
    const stranger = as('user_unknown', 'Moderator');
    for (let i = 0; i < LIMIT; i++) {
      const res = await send(ip, { auth: i % 2 ? member : stranger });
      expect(res.status).toBe(403);
    }
    await expectGeneric(await send(ip, { auth: member }));
  });

  it('never limits signed-in staff, however many requests, at once or in a row', async () => {
    const ip = '203.0.113.60';
    const admin = as('user_admin', 'Admin');
    const moderator = as('user_mod', 'Moderator');
    // Far more than any old staff limit (120 reads a minute), all inside one minute.
    for (let i = 0; i < 150; i++) {
      expect((await send(ip, { auth: admin })).status).toBe(200);
    }
    // A moderator's 403 on an Admin-only page is a normal answer, not a refusal: never counted.
    for (let i = 0; i < 3 * LIMIT; i++) {
      expect((await send(ip, { auth: moderator })).status).toBe(403);
    }
    // Many at once: nothing counts while it runs.
    const parallel = await Promise.all(
      Array.from({ length: 4 * LIMIT }, () =>
        send(ip, { path: '/v1/moderation/stories', auth: moderator }),
      ),
    );
    expect(parallel.map((r) => r.status)).toEqual(Array(4 * LIMIT).fill(200));
  });
});

import {
  Global,
  type INestApplication,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import {
  createPeople,
  publishDpa,
  rows,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { AccountConsentsModule } from '../src/lib/account-consents.controller';
import { ConsentModule } from '../src/lib/consent.module';
import type {
  AuthenticatedPerson,
  PersonAuthenticator,
} from '../src/lib/person';

/**
 * api-user's consent endpoints end to end: the real ConsentModule, guard and controller on
 * api-user's service connection, with SurrealDB doing the person-session checks. Only the
 * Clerk verification (libs/auth, tested there) is stood in for: the test's bearer token is already a
 * SurrealDB-acceptable token signed by the harness's stand-in Clerk key.
 */
class BearerForTests implements PersonAuthenticator {
  async authenticate(request: Request): Promise<AuthenticatedPerson> {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException();
    return { clerkUserId: 'from-token', token };
  }
}

describe('api-user consent endpoints (contracts: api-user.yaml, tag Consent)', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  let n = 0;
  const key = () => `test-key-${Date.now()}-${++n}-padding`;

  const call = (
    path: string,
    who: string | null,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${t.token(who)}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    t = await TestDatabase.create();
    await createPeople(t, { ann: 'user_ann', bob: 'user_bob' });
    await publishDpa(t, 'v1');
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
        ConsentModule.forRoot({ authenticator: BearerForTests }),
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

  it('401 without a sign-in', async () => {
    expect((await call('/v1/account/consents', null)).status).toBe(401);
  });

  it('GET: my state, private, with a weak ETag and 304', async () => {
    const res = await call('/v1/account/consents', 'user_ann');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const etag = res.headers.get('etag') as string;
    expect(etag).toMatch(/^W\//);
    const body = (await res.json()) as {
      current: unknown[];
      history: unknown[];
    };
    expect(body.current).toHaveLength(4);
    expect(body.history).toEqual([]);
    const again = await call('/v1/account/consents', 'user_ann', {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('POST: grants, 201 { id, version: null }; a retry with the same key replays it', async () => {
    const k = key();
    const body = {
      type: 'special_category_religious',
      dpaVersion: 'v1',
      mechanism: 'web_form_submission',
    };
    const first = await call('/v1/account/consents', 'user_ann', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': k },
    });
    expect(first.status).toBe(201);
    const result = (await first.json()) as { id: string; version: null };
    expect(result).toEqual({
      id: expect.stringMatching(/^\w+$/),
      version: null,
    });

    const replay = await call('/v1/account/consents', 'user_ann', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': k },
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(result);
    const ledger = await rows(
      await t.migrator(),
      'SELECT id FROM consent WHERE subject = user:ann',
    );
    expect(ledger).toHaveLength(1); // applied once

    const reused = await call('/v1/account/consents', 'user_ann', {
      method: 'POST',
      body: { ...body, type: 'publish' },
      headers: { 'idempotency-key': k },
    });
    expect(reused.status).toBe(422);
  });

  it('POST: 400 without an Idempotency-Key or with an invalid body; 409 against a draft DPA', async () => {
    const body = {
      type: 'publish',
      dpaVersion: 'v1',
      mechanism: 'web_form_submission',
    };
    expect(
      (await call('/v1/account/consents', 'user_ann', { method: 'POST', body }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('/v1/account/consents', 'user_ann', {
          method: 'POST',
          body: { ...body, mechanism: 'legacy_import' },
          headers: { 'idempotency-key': key() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/v1/account/consents', 'user_ann', {
          method: 'POST',
          body: { ...body, dpaVersion: 'v2' },
          headers: { 'idempotency-key': key() },
        })
      ).status,
    ).toBe(409);
  });

  it('withdraw: 202, then reflected in GET; 409 if never granted; 400 for an unknown type', async () => {
    const res = await call(
      '/v1/account/consents/special_category_religious/withdraw',
      'user_ann',
      {
        method: 'POST',
        headers: { 'idempotency-key': key() },
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: expect.any(String), version: null });
    const state = (await (
      await call('/v1/account/consents', 'user_ann')
    ).json()) as {
      current: { type: string; granted: boolean }[];
    };
    expect(
      state.current.find((c) => c.type === 'special_category_religious')
        ?.granted,
    ).toBe(false);

    const never = await call(
      '/v1/account/consents/publish/withdraw',
      'user_bob',
      {
        method: 'POST',
        headers: { 'idempotency-key': key() },
      },
    );
    expect(never.status).toBe(409);
    const unknown = await call(
      '/v1/account/consents/legacy-migration/withdraw',
      'user_bob',
      {
        method: 'POST',
        headers: { 'idempotency-key': key() },
      },
    );
    expect(unknown.status).toBe(400);
  });

  it('keys are per person: the same key from someone else is a separate command', async () => {
    const k = key();
    const body = {
      type: 'age_18plus',
      dpaVersion: 'v1',
      mechanism: 'web_form_submission',
    };
    for (const who of ['user_ann', 'user_bob']) {
      const res = await call('/v1/account/consents', who, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': k },
      });
      expect(res.status).toBe(201);
    }
    expect(
      await rows(
        await t.migrator(),
        `SELECT id FROM consent WHERE type = 'age_18plus'`,
      ),
    ).toHaveLength(2);
  });
});

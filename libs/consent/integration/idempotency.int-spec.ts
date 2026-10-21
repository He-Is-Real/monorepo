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
  run,
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
 * PR #41 review round 1, finding 1: `Idempotency-Key` must commit atomically with the command
 * (D29). These reproduce the reported failures through api-user's real endpoints:
 *   - a failure between the ledger write and the key write left the grant committed without its
 *     key, so retrying the original request after a withdrawal granted again;
 *   - concurrent requests sharing a key both executed.
 */
class BearerForTests implements PersonAuthenticator {
  async authenticate(request: Request): Promise<AuthenticatedPerson> {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException();
    return { clerkUserId: 'from-token', token };
  }
}

describe('Idempotency-Key commits atomically with the consent command (D29)', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  let migrator: Surreal;
  let n = 0;
  const key = () => `regression-key-${Date.now()}-${++n}`;
  const grantBody = (type: string) => ({
    type,
    dpaVersion: 'v1',
    mechanism: 'web_form_submission',
  });

  const post = (path: string, who: string, k: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${t.token(who)}`,
        'idempotency-key': k,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const grant = (who: string, k: string, type: string) =>
    post('/v1/account/consents', who, k, grantBody(type));
  const withdraw = (who: string, k: string, type: string) =>
    post(`/v1/account/consents/${type}/withdraw`, who, k);

  const events = (person: string, type: string) =>
    rows<{ event: string }>(
      migrator,
      `SELECT event, occurredAt FROM consent WHERE subject = type::record('user', $p)
         AND type = $type ORDER BY occurredAt`,
      { p: person, type },
    );
  const keys = (person: string) =>
    rows(
      migrator,
      `SELECT id FROM idempotencyKey WHERE record::id(id)[1] = type::record('user', $p)`,
      { p: person },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cat: 'user_cat',
      dan: 'user_dan',
    });
    await publishDpa(t, 'v1');
    migrator = await t.migrator();
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

  it('a failure when storing the key leaves no ledger event either', async () => {
    // Fault injection: the key write fails, whoever writes it (the person's session or a
    // service login), after the ledger event in the same request.
    await run(
      migrator,
      `DEFINE EVENT OVERWRITE inject_fault ON idempotencyKey WHEN $event = 'CREATE'
         THEN { THROW 'injected fault: storing the idempotency key' }`,
    );
    const k = key();
    try {
      expect((await grant('user_ann', k, 'publish')).status).toBe(500);
    } finally {
      await run(migrator, 'REMOVE EVENT inject_fault ON idempotencyKey');
    }
    expect(await events('ann', 'publish')).toEqual([]); // nothing half-applied
    expect(await keys('ann')).toEqual([]);

    // The retry is then the first real attempt: it applies once, and replays after that.
    const first = await grant('user_ann', k, 'publish');
    expect(first.status).toBe(201);
    const again = await grant('user_ann', k, 'publish');
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
    expect(await events('ann', 'publish')).toHaveLength(1);
  });

  it('a retried grant after a withdrawal replays; it never grants again', async () => {
    const grantKey = key();
    const granted = await grant('user_bob', grantKey, 'publish'); // the client loses this answer
    expect(granted.status).toBe(201);
    expect((await withdraw('user_bob', key(), 'publish')).status).toBe(202);

    const retry = await grant('user_bob', grantKey, 'publish'); // the ORIGINAL request again
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(await granted.json());
    expect((await events('bob', 'publish')).map((e) => e.event)).toEqual([
      'granted',
      'withdrawn',
    ]); // consent stays withdrawn: no new decision was made
  });

  it('concurrent requests with one key apply once and all get the same answer', async () => {
    const k = key();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => grant('user_cat', k, 'age_18plus')),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await events('cat', 'age_18plus')).toHaveLength(1);
    expect(await keys('cat')).toHaveLength(1);
  });

  it('a key reused with a different body is refused (422), also when racing; one command applies', async () => {
    const k = key();
    const [a, b] = await Promise.all([
      grant('user_dan', k, 'publish'),
      grant('user_dan', k, 'share_socials'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const applied =
      (await events('dan', 'publish')).length +
      (await events('dan', 'share_socials')).length;
    expect(applied).toBe(1);
    // And sequentially, once the key is stored.
    expect((await grant('user_dan', k, 'age_18plus')).status).toBe(422);
  });
});

import {
  IdempotencyKeyReusedError,
  requestHash,
  withPersonSession,
} from '@heisreal/database';
import {
  createPeople,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { RecordId, type Surreal } from 'surrealdb';
import { ConsentLedger } from '../src/lib/consent-ledger';
import { type ConsentType, STATEMENT_FORM } from '../src/lib/consent.types';

/**
 * D29: an `Idempotency-Key` commits in the same transaction as the consent event, so a retry
 * replays and a race applies once (PR #41 review round 1, finding 1). On the connection
 * api-user uses, a session per person (D27), with the scope and request hash its consent
 * endpoints pass (account-consents.controller.ts); no HTTP route, as no page uses one yet.
 */
describe('Idempotency-Key commits atomically with the consent command (D29)', () => {
  let t: TestDatabase;
  let apiUser: Surreal;
  let migrator: Surreal;
  const ledger = new ConsentLedger();
  let n = 0;
  const key = () => `regression-key-${++n}`;

  /** One request: the person's own session, the key scoped to them and to api-user. */
  const command = (
    person: string,
    k: string,
    request: unknown,
    execute: (
      session: Parameters<ConsentLedger['grant']>[0],
      idempotency: Parameters<ConsentLedger['grant']>[2],
    ) => ReturnType<ConsentLedger['grant']>,
  ) =>
    withPersonSession(apiUser, t.token(`user_${person}`), (session) =>
      execute(session, {
        scope: {
          service: 'api-user',
          owner: new RecordId('user', person),
          key: k,
        },
        requestHash: requestHash(request),
      }),
    );
  const grant = (person: string, k: string, type: ConsentType) => {
    const input = {
      form: STATEMENT_FORM[type],
      formVersion: 'v1',
      statement: type,
      mechanism: 'web_form_submission' as const,
    };
    return command(person, k, ['POST', 'consents', input], (s, idem) =>
      ledger.grant(s, input, idem),
    );
  };
  const withdraw = (person: string, k: string, type: ConsentType) =>
    command(person, k, ['POST', 'withdraw', type], (s, idem) =>
      ledger.withdraw(s, type, idem),
    );

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
    apiUser = await t.service('api_user');
  });
  afterAll(() => t?.close());

  it('a failure when storing the key leaves no ledger event either', async () => {
    // Fault injection: the key write fails after the ledger event, in the same transaction.
    await run(
      migrator,
      `DEFINE EVENT OVERWRITE inject_fault ON idempotencyKey WHEN $event = 'CREATE'
         THEN { THROW 'injected fault: storing the idempotency key' }`,
    );
    const k = key();
    try {
      await expect(grant('ann', k, 'publish')).rejects.toThrow(
        'injected fault',
      );
    } finally {
      await run(migrator, 'REMOVE EVENT inject_fault ON idempotencyKey');
    }
    expect(await events('ann', 'publish')).toEqual([]); // nothing half-applied
    expect(await keys('ann')).toEqual([]);

    // The retry is then the first real attempt: it applies once, and replays after that.
    const first = await grant('ann', k, 'publish');
    expect(first).toMatchObject({ status: 201, replayed: false });
    const again = await grant('ann', k, 'publish');
    expect(again).toEqual({ ...first, replayed: true });
    expect(await events('ann', 'publish')).toHaveLength(1);
  });

  it('a retried grant after a withdrawal replays; it never grants again', async () => {
    const grantKey = key();
    const granted = await grant('bob', grantKey, 'publish'); // the client loses this answer
    expect((await withdraw('bob', key(), 'publish')).status).toBe(202);

    const retry = await grant('bob', grantKey, 'publish'); // the ORIGINAL request again
    expect(retry).toEqual({ ...granted, replayed: true });
    expect((await events('bob', 'publish')).map((e) => e.event)).toEqual([
      'granted',
      'withdrawn',
    ]); // consent stays withdrawn: no new decision was made
  });

  it('concurrent requests with one key apply once and all get the same answer', async () => {
    const k = key();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => grant('cat', k, 'age_18plus')),
    );
    expect(new Set(outcomes.map((o) => `${o.status} ${o.id}`)).size).toBe(1);
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(await events('cat', 'age_18plus')).toHaveLength(1);
    expect(await keys('cat')).toHaveLength(1);
  });

  it('a key reused with a different request is refused, also when racing; one command applies', async () => {
    const k = key();
    const settled = await Promise.allSettled([
      grant('dan', k, 'publish'),
      grant('dan', k, 'share_socials'),
    ]);
    expect(settled.map((s) => s.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const refused = settled.find((s) => s.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    const applied =
      (await events('dan', 'publish')).length +
      (await events('dan', 'share_socials')).length;
    expect(applied).toBe(1);
    // And sequentially, once the key is stored.
    await expect(grant('dan', k, 'age_18plus')).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
  });
});

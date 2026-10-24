import type { Surreal, SurrealSession } from 'surrealdb';
import { withPersonSession } from '../src/lib/person-session';
import { outcome, rows, TestDatabase } from './support/harness';
import { buildWorld } from './support/world';

/**
 * How api-user runs ONE PERSON'S session per request without a new connection per request
 * (surrealdb.js 2.0.8, SurrealDB 3.2.4 multi-session WebSocket RPC), with the real
 * `withPersonSession` (src/lib/person-session.ts), and the hazards it avoids:
 *   - newSession(), never forkSession(): a fresh session has no identity, a fork inherits the
 *     service login and KEEPS it if the person's token is rejected;
 *   - one session per request: authenticating requests on one shared session interleaves them.
 * The per-request cost of the alternatives was measured once (docs/db-permissions.md).
 */
const storyIds = async (db: SurrealSession) =>
  (await rows<{ id: string }>(db, 'SELECT id FROM story'))
    .map((r) => r.id)
    .sort();

describe('per-request person sessions on one connection (surrealdb.js)', () => {
  let t: TestDatabase;
  /** api-user's single long-lived connection, signed in as service:api_user. */
  let connection: Surreal;
  let scope: { namespace: string; database: string };

  beforeAll(async () => {
    t = await TestDatabase.create();
    await buildWorld(t);
    connection = await t.service('api_user');
    scope = { namespace: t.namespace, database: t.database };
  });
  afterAll(() => t?.close());

  it('newSession() starts with no identity: it can’t run any query until authenticated', async () => {
    const session = await connection.newSession();
    try {
      await session.use(scope);
      expect(await outcome(session, 'SELECT * FROM publicStory')).toEqual({
        ok: false,
        error: expect.stringContaining('Anonymous access not allowed'),
      });
      // ...while the connection's own session is still the service.
      expect(await rows(connection, 'RETURN $auth')).toEqual([
        'service:api_user',
      ]);
    } finally {
      await session.closeSession();
    }
  });

  it('DANGER: forkSession() inherits the service login and keeps it if the person’s token is rejected', async () => {
    const fork = await connection.forkSession();
    try {
      await expect(fork.authenticate(t.token('user_nobody'))).rejects.toThrow();
      expect(await rows(fork, 'RETURN $auth')).toEqual(['service:api_user']);
    } finally {
      await fork.invalidate();
      await fork.closeSession();
    }
  });

  it('a rejected token on newSession() leaves the session with no identity', async () => {
    const session = await connection.newSession();
    try {
      await session.use(scope);
      await expect(
        session.authenticate(t.token('user_ann', { expiresIn: -5 })),
      ).rejects.toThrow();
      expect((await outcome(session, 'SELECT * FROM story')).ok).toBe(false);
    } finally {
      await session.closeSession();
    }
  });

  it('runs many concurrent requests for different people on one connection, each isolated', async () => {
    const baseline = (await connection.sessions()).length;
    const people = ['user_ann', 'user_bob'] as const;
    const expected = {
      user_ann: ['story:ann_draft', 'story:ann_pending'],
      user_bob: ['story:bob_draft', 'story:bob_live', 'story:bob_pending'],
    };
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const who = people[i % 2];
        return withPersonSession(connection, t.token(who), async (s) => ({
          who,
          seen: await storyIds(s),
          auth: (await rows(s, 'RETURN $auth'))[0],
        }));
      }),
    );
    for (const r of results) {
      expect(r.seen).toEqual(expected[r.who]);
      expect(r.auth).toBe(r.who === 'user_ann' ? 'user:ann' : 'user:bob');
    }
    // Every session was detached again: nothing leaks on the connection or the server.
    expect((await connection.sessions()).length).toBe(baseline);
    // The connection's own identity never changed.
    expect(await rows(connection, 'RETURN $auth')).toEqual([
      'service:api_user',
    ]);
  });

  it('DANGER: authenticating requests on ONE shared session lets them interleave', async () => {
    // What happens if api-user called authenticate() on its connection (or one session) per
    // request: request A authenticates, request B authenticates before A queries, A then reads
    // as B. The auth state belongs to the session, not to the request.
    const shared = await connection.newSession();
    try {
      await shared.use(scope);
      await shared.authenticate(t.token('user_ann')); // request A
      await shared.authenticate(t.token('user_bob')); // request B, interleaved
      expect(await storyIds(shared)).toEqual([
        'story:bob_draft',
        'story:bob_live',
        'story:bob_pending',
      ]); // request A sees Bob's drafts
    } finally {
      await shared.invalidate();
      await shared.closeSession();
    }
  });
});

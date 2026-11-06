import type { Surreal, SurrealSession } from 'surrealdb';
import { withPersonSession } from '../src/lib/person-session';
import { outcome, rows, TestDatabase } from './support/harness';
import { buildWorld } from './support/world';

/**
 * How api-user runs ONE PERSON'S session per request without a new connection per request
 * (surrealdb.js 2.0.8, SurrealDB 3.2.4 multi-session WebSocket RPC), with the real
 * `withPersonSession` (src/lib/person-session.ts). The SDK hazards it avoids (forkSession()
 * keeping the service login, requests interleaving on one shared session) are recorded in
 * docs/db-permissions.md, "Per-request person sessions"; so is the cost of the alternatives.
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
      expect(await outcome(session, 'SELECT * FROM story')).toEqual({
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
      user_ann: ['story:ann_draft', 'story:ann_pending', 'story:bob_live'],
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

  it('clears the person’s auth while the session is still attached, then detaches it', async () => {
    // Invalidate, then close: in that order nothing of the person stays on the long-lived
    // connection. Closed first, the invalidate fails ("Session not found") and, like skipping
    // it, leaves the connection holding the person's token and its renewal timer.
    const timers = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = {
      sessions: (await connection.sessions()).length,
      timers: timers(),
    };
    let attachedWhenCleared: boolean | undefined;
    let held!: SurrealSession;
    await withPersonSession(connection, t.token('user_ann'), async (s) => {
      held = s;
      s.subscribe('auth', (auth) => {
        if (auth === null) attachedWhenCleared = s.isValid;
      });
      expect(await rows(s, 'RETURN $auth')).toEqual(['user:ann']);
    });
    expect(attachedWhenCleared).toBe(true);
    expect(held.isValid).toBe(false);
    expect((await connection.sessions()).length).toBe(before.sessions);
    expect(timers()).toBe(before.timers);
    expect(await rows(connection, 'RETURN $auth')).toEqual([
      'service:api_user',
    ]);
  });
});

import { performance } from 'node:perf_hooks';
import { Features, Surreal, type SurrealSession } from 'surrealdb';
import { outcome, rows, TestDatabase } from './support/harness';
import { buildWorld } from './support/world';

/**
 * How api-user runs ONE PERSON'S session per request without a new connection per request
 * (surrealdb.js 2.0.8, SurrealDB 3.2.4 multi-session WebSocket RPC).
 *
 * The reference pattern, `withPersonSession`, is what libs/database will provide:
 *   - newSession(), never forkSession(): a fresh session has no identity, a fork inherits the
 *     service login and KEEPS it if the person's token is rejected;
 *   - authenticate with the person's Clerk token (throws if rejected; its ns/db claims select
 *     the database);
 *   - run the request's queries on that session only;
 *   - finally invalidate() then closeSession() (2.0.8 leaks a renewal timer otherwise).
 */
async function withPersonSession<T>(
  connection: Surreal,
  token: string,
  work: (session: SurrealSession) => Promise<T>,
): Promise<T> {
  const session = await connection.newSession();
  try {
    // The token's ns/db claims select the database: no use() round trip needed.
    await session.authenticate(token);
    return await work(session);
  } finally {
    await session.invalidate().catch(() => undefined);
    await session.closeSession();
  }
}

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

  it('the server supports sessions on a WebSocket connection', () => {
    expect(connection.isFeatureSupported(Features.Sessions)).toBe(true);
  });

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

  it('HTTP alternative: a stateless request with the person’s token as a Bearer header', async () => {
    // What surrealdb.js 2.1's `.as(token)` does over HTTP. Nothing is held per person on the
    // server; Node's fetch keeps the TCP connection alive between requests.
    const httpUrl = t.url.replace(/^ws/, 'http');
    const sql = async (token: string, query: string) => {
      const response = await fetch(`${httpUrl}/sql`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Surreal-NS': t.namespace,
          'Surreal-DB': t.database,
        },
        body: query,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: response.ok ? (JSON.parse(text) as unknown) : text,
      };
    };
    const ann = await sql(t.token('user_ann'), 'SELECT VALUE id FROM story');
    expect(ann.status).toBe(200);
    expect(ann.body).toEqual([
      expect.objectContaining({
        status: 'OK',
        result: expect.arrayContaining([
          'story:ann_draft',
          'story:ann_pending',
        ]),
      }),
    ]);
    expect((ann.body as [{ result: unknown[] }])[0].result).toHaveLength(2);
    const expired = await sql(
      t.token('user_ann', { expiresIn: -5 }),
      'SELECT * FROM story',
    );
    expect(expired.status).toBe(401);
  });

  // A measurement, not a behaviour check: 800 sequential requests whose time depends on the
  // machine (about 14 s idle, past jest's 30 s under load). Run it when re-measuring the numbers
  // in docs/db-permissions.md: MEASURE_REQUEST_SESSIONS=1.
  const measure =
    process.env['MEASURE_REQUEST_SESSIONS'] === '1' ? it : it.skip;
  measure('measures the per-request cost of each approach', async () => {
    const N = 200;
    // One token for every iteration: signing RS256 costs ~1 ms on the client, which Clerk pays.
    const token = t.token('user_ann', { expiresIn: 300 });
    const query = 'SELECT id FROM story';
    const httpUrl = t.url.replace(/^ws/, 'http');
    const time = async (approach: string, once: () => Promise<unknown>) => {
      await once(); // warm-up
      const start = performance.now();
      for (let i = 0; i < N; i++) await once();
      return {
        approach,
        msPerRequest: Number(((performance.now() - start) / N).toFixed(2)),
      };
    };
    const results = [
      await time('new session on a shared WS connection', () =>
        withPersonSession(connection, token, (s) => rows(s, query)),
      ),
      await time('new WS connection per request', async () => {
        const db = new Surreal();
        await db.connect(t.url, { ...scope, reconnect: false });
        await db.authenticate(token);
        await rows(db, query);
        await db.close();
      }),
      await time('HTTP /sql with a Bearer token (keep-alive)', async () => {
        const r = await fetch(`${httpUrl}/sql`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Surreal-NS': t.namespace,
            'Surreal-DB': t.database,
          },
          body: query,
        });
        await r.json();
      }),
      await time(
        'baseline: same query on the service session (no per-person auth)',
        () => rows(connection, query),
      ),
    ];
    // Not a gate: numbers depend on the machine. Recorded in docs/db-permissions.md.
    console.table(results);
    expect(results.every((r) => r.msPerRequest > 0)).toBe(true);
  });
});

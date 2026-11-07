import { createServer, type Server, type Socket, connect } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { connectDatabase } from '@heisreal/database';
import { TestDatabase } from '@heisreal/database/integration-testing';
import type { SecretsService } from '@heisreal/secrets';
import { Surreal } from 'surrealdb';
import { startPublicRead } from './app';

/**
 * SurrealDB on Spot (Joel, 2026-11-07): when Google takes the database's machine back, every API
 * answers `503 service_restarting` with when to try again, at once rather than hanging, and
 * answers normally as soon as the database is back. api-public-read serves the copy it kept of
 * a public answer (up to 30 minutes old) instead, when it has one.
 *
 * The database "stops" behind a TCP relay the test controls: it drops every connection and
 * refuses new ones, as a restarting pod does. The test SurrealDB container itself is shared with
 * the other suites running at the same time, so it isn't stopped.
 */
function relay(target: string): Promise<{
  url: string;
  stop: () => void;
  start: () => void;
  close: () => Promise<void>;
}> {
  const { hostname, port } = new URL(target.replace(/^ws/, 'http'));
  const sockets = new Set<Socket>();
  let up = true;
  const server: Server = createServer((client) => {
    if (!up) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(port), hostname);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => undefined);
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        stop: () => {
          up = false;
          for (const s of sockets) s.destroy();
        },
        start: () => {
          up = true;
        },
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    }),
  );
}

describe('a database restart', () => {
  let t: TestDatabase;
  let app: INestApplication | undefined;
  let db: Surreal | undefined;
  let database: Awaited<ReturnType<typeof relay>> | undefined;

  const saved = process.env['PUBLIC_RESPONSE_CACHING'];
  afterEach(async () => {
    if (saved === undefined) delete process.env['PUBLIC_RESPONSE_CACHING'];
    else process.env['PUBLIC_RESPONSE_CACHING'] = saved;
    await app?.close();
    await db?.close();
    await database?.close();
    await t?.close();
  });

  it('answers 503 service_restarting while the database is away, and recovers when it is back', async () => {
    t = await TestDatabase.create();
    database = await relay(t.url);
    // The services' own connect, with their reconnect settings, through the relay.
    const password = t.servicePasswords.get('api_public_read');
    db = await connectDatabase(
      new Surreal(),
      {
        url: database.url,
        namespace: t.namespace,
        database: t.database,
        username: 'api_public_read',
        passwordSecret: 'unused',
      },
      { get: async () => password } as unknown as SecretsService,
    );
    const started = await startPublicRead(t, undefined, db);
    app = started.app;
    // A new path each time unless the answer cache is what's checked.
    const get = (path: string) => fetch(`${started.url}${path}`);
    const kept = await get('/v1/stories?limit=1');
    expect(kept.status).toBe(200);
    const keptBody: unknown = await kept.json();

    database.stop();
    await expect
      .poll(async () => (await get('/v1/stories?limit=2')).status)
      .toBe(503);

    const before = Date.now();
    const res = await get('/v1/stories?limit=3');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(
      /^application\/problem\+json/,
    );
    const body = (await res.json()) as {
      code: string;
      restartingSince: string;
      retryAfterSeconds: number;
    };
    expect(body.code).toBe('service_restarting');
    // The default estimate is 2 minutes, counted from when this copy saw it go.
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(60);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(120);
    expect(Date.parse(body.restartingSince)).toBeLessThanOrEqual(before);
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
    // The health probe still answers, and says the database is down.
    expect((await get('/health')).status).toBe(503);

    // Cache B (Joel, 2026-11-07): within its minute, an answer is served from memory as usual
    // (with shared caching on, browsers may keep it for what's left of the minute);
    process.env['PUBLIC_RESPONSE_CACHING'] = 'on';
    const fresh = await get('/v1/stories?limit=1');
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('cache-control')).toBe('public, max-age=60');
    // past it, the copy is served only because the database is away, and kept by nobody else;
    started.passTime(61_000);
    const fallback = await get('/v1/stories?limit=1');
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('cache-control')).toBe('no-store');
    expect(await fallback.json()).toEqual(keptBody);
    // after 30 minutes there's no copy, so it's the restarting answer.
    started.passTime(30 * 60_000);
    expect((await get('/v1/stories?limit=1')).status).toBe(503);

    database.start();
    await expect
      .poll(async () => (await get('/v1/stories?limit=4')).status, {
        timeout: 20_000,
      })
      .toBe(200);
    expect((await get('/health')).status).toBe(200);
  });
});

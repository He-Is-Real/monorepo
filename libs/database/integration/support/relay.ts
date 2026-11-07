import { connect, createServer, type Server, type Socket } from 'node:net';

/** A TCP relay in front of the test database, for {@link databaseRelay}. */
export interface DatabaseRelay {
  /** The relay's `ws://` URL: connect to this instead of the database. */
  url: string;
  /** The database "stops": every connection drops and new ones are refused, as a restarting pod does. */
  stop: () => void;
  /** The database is back: new connections go through again. */
  start: () => void;
  /**
   * From now on, what clients send goes nowhere (a request stays in flight, unanswered); resolves
   * when the next thing a client sends arrives, so the caller knows a request is waiting.
   */
  hold: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * SurrealDB on Spot (Joel, 2026-11-07): the database "restarts" behind a TCP relay the test
 * controls. The test SurrealDB container itself is shared with the other suites running at the
 * same time, so it isn't stopped. `target` is the test database's URL (`TestDatabase.url`).
 * `up: false`: the relay begins stopped, as when a service starts during a restart.
 */
export function databaseRelay(
  target: string,
  { up: startUp = true }: { up?: boolean } = {},
): Promise<DatabaseRelay> {
  const { hostname, port } = new URL(target.replace(/^ws/, 'http'));
  const sockets = new Set<Socket>();
  let up = startUp;
  let holding: (() => void) | undefined;
  let held = false;
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
    client.on('data', (chunk) => {
      if (held) {
        holding?.();
        holding = undefined;
        return;
      }
      upstream.write(chunk);
    });
    upstream.pipe(client);
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
          held = false;
          for (const s of sockets) s.destroy();
        },
        start: () => {
          up = true;
        },
        hold: () =>
          new Promise<void>((seen) => {
            held = true;
            holding = seen;
          }),
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    }),
  );
}

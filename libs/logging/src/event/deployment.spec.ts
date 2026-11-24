import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deployment details on every entry (LG-10, Joel 24 Nov 2026): the build, revision and
 * environment from the image and Cloud Run, the region and instance from Google's metadata
 * server, read in the background so a missing or silent one never holds anything up.
 */

const SET = [
  'K_SERVICE',
  'K_REVISION',
  'SERVICE_VERSION',
  'GCP_PROJECT',
  'GCE_METADATA_HOST',
];

/**
 * A stand-in metadata server. `answer`: `true` replies to everything; `false` accepts requests
 * and never replies; `'trickle'` answers the region at once but trickles the instance id a byte
 * at a time, forever. `requests` counts what arrived; `closed` counts requests whose connection
 * the caller cut.
 */
async function metadataServer(answer: boolean | 'trickle') {
  const seen = { requests: 0, closed: 0 };
  const values: Record<string, string> = {
    '/computeMetadata/v1/instance/region':
      'projects/236063168938/regions/europe-west2',
    '/computeMetadata/v1/instance/id': '0069c7a2b1f00d',
  };
  const server = createServer((req, res) => {
    seen.requests++;
    res.on('close', () => {
      if (!res.writableFinished) seen.closed++;
    });
    if (!answer) return;
    if (req.headers['metadata-flavor'] !== 'Google') {
      res.writeHead(403).end();
      return;
    }
    const value = values[req.url ?? ''];
    if (!value) {
      res.writeHead(404).end();
    } else if (answer === 'trickle' && req.url?.endsWith('/id')) {
      res.writeHead(200);
      const drip = setInterval(() => res.write('0'), 20);
      res.on('close', () => clearInterval(drip));
    } else {
      res.writeHead(200).end(value);
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return Object.assign(server, { seen });
}

/** Each test gets fresh modules: the lookup runs once per process. */
async function onCloudRun(server: Server) {
  vi.resetModules();
  const { port } = server.address() as AddressInfo;
  Object.assign(process.env, {
    K_SERVICE: 'api-user',
    K_REVISION: 'api-user-00042-xyz',
    SERVICE_VERSION: '1fb357f4c0de',
    GCP_PROJECT: 'heisreal-dev',
    GCE_METADATA_HOST: `127.0.0.1:${port}`,
  });
  const event = await import('./index.js');
  const core = await import('../index.js');
  return { ...event, ...core };
}

describe('deployment details on every entry (LG-10)', () => {
  let server: Server | undefined;

  afterEach(() => {
    for (const name of SET) delete process.env[name];
    server?.closeAllConnections();
    server?.close();
  });

  it('a wide event and a stand-alone line carry the build, revision, environment, region and instance', async () => {
    server = await metadataServer(true);
    const { startEvent, logEntry, serviceFields } = await onCloudRun(server);
    // The first line starts the lookup and is written straight away, without region/instance.
    expect(logEntry('INFO', 'listening')['service']).toEqual({
      name: 'api-user',
      version: '1fb357f4c0de',
      revision: 'api-user-00042-xyz',
      env: 'dev',
    });
    await vi.waitFor(() => expect(serviceFields().region).toBeDefined());
    const details = {
      name: 'api-user',
      version: '1fb357f4c0de',
      revision: 'api-user-00042-xyz',
      env: 'dev',
      region: 'europe-west2',
      instance: '0069c7a2b1f00d',
    };
    expect(logEntry('INFO', 'listening')['service']).toEqual(details);
    const { entry } = startEvent('request', 'api-user').build();
    expect(entry['service']).toEqual(details);
  });

  it('a metadata server that never answers holds up nothing, and the fields are left off', async () => {
    server = await metadataServer(false);
    const { startEvent, logEntry } = await onCloudRun(server);
    const first = logEntry('INFO', 'listening');
    // Both questions are now open at the metadata server and stay unanswered…
    const { seen } = server as Server & { seen: { requests: number } };
    await vi.waitFor(() => expect(seen.requests).toBe(2));
    // …and lines are still written there and then, without the two fields.
    const line = logEntry('INFO', 'listening');
    const { entry } = startEvent('request', 'api-user').build();
    for (const written of [first, line, entry]) {
      expect(written['service']).toEqual({
        name: 'api-user',
        version: '1fb357f4c0de',
        revision: 'api-user-00042-xyz',
        env: 'dev',
      });
    }
  });

  it('a metadata server that trickles one answer: the other field still lands, and the slow one is cut off', async () => {
    server = await metadataServer('trickle');
    const { seen } = server as Server & {
      seen: { requests: number; closed: number };
    };
    // Only the lookup's own deadline is faked; sockets and the server's trickle run for real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { logEntry, serviceFields } = await onCloudRun(server);
      logEntry('INFO', 'listening');
      await vi.waitFor(() =>
        expect(serviceFields().region).toBe('europe-west2'),
      );
      expect(serviceFields().instance).toBeUndefined();
      expect(seen.closed).toBe(0);
      vi.advanceTimersByTime(2_000);
      await vi.waitFor(() => expect(seen.closed).toBe(1));
      expect(serviceFields().instance).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('off Cloud Run: no lookup, version "dev", environment "local"', async () => {
    vi.resetModules();
    const { logEntry } = await import('../index.js');
    await import('./index.js');
    expect(logEntry('INFO', 'hello')['service']).toEqual({
      version: 'dev',
      env: 'local',
    });
  });
});

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

/** A stand-in metadata server; `answer: false` accepts requests and never replies. */
async function metadataServer(answer: boolean): Promise<Server> {
  const server = createServer((req, res) => {
    if (!answer) return;
    if (req.headers['metadata-flavor'] !== 'Google') {
      res.writeHead(403).end();
      return;
    }
    const values: Record<string, string> = {
      '/computeMetadata/v1/instance/region':
        'projects/236063168938/regions/europe-west2',
      '/computeMetadata/v1/instance/id': '0069c7a2b1f00d',
    };
    const value = values[req.url ?? ''];
    if (value) res.writeHead(200).end(value);
    else res.writeHead(404).end();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return server;
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
    const started = performance.now();
    const line = logEntry('INFO', 'listening');
    const { entry } = startEvent('request', 'api-user').build();
    expect(performance.now() - started).toBeLessThan(100);
    for (const written of [line, entry]) {
      expect(written['service']).toEqual({
        name: 'api-user',
        version: '1fb357f4c0de',
        revision: 'api-user-00042-xyz',
        env: 'dev',
      });
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

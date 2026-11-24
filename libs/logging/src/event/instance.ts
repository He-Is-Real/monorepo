import { request } from 'node:http';
import { setInstanceLookup } from '../index';

/**
 * `service.region` and `service.instance` (LG-10): read once from Google's metadata server, in the
 * background, the first time a line is written on Cloud Run (`K_SERVICE` or `CLOUD_RUN_JOB` set).
 * Nothing waits for it: start-up and requests go on, and lines simply lack the two fields until
 * it answers (or for good, if it never does). `GCE_METADATA_HOST` (the variable Google's client
 * libraries read) points it elsewhere; tests use it.
 */

const TIMEOUT_MS = 2_000;

/** One metadata value as text; rejects on anything but a quick 200. Never keeps the process up. */
function metadata(host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    const req = request(
      {
        hostname,
        port: port ? Number(port) : 80,
        path: `/computeMetadata/v1/instance/${path}`,
        headers: { 'Metadata-Flavor': 'Google' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`metadata ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length < 1_000) body += chunk;
        });
        res.on('end', () => resolve(body.trim()));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('metadata timeout')));
    req.on('error', reject);
    req.on('socket', (socket) => socket.unref());
    req.end();
  });
}

setInstanceLookup(async (env) => {
  const host = env['GCE_METADATA_HOST']?.trim() || 'metadata.google.internal';
  const [region, id] = await Promise.allSettled([
    metadata(host, 'region'),
    metadata(host, 'id'),
  ]);
  return {
    // `projects/236063168938/regions/europe-west2` → `europe-west2`
    ...(region.status === 'fulfilled' && region.value
      ? { region: region.value.slice(region.value.lastIndexOf('/') + 1) }
      : {}),
    ...(id.status === 'fulfilled' && id.value ? { instance: id.value } : {}),
  };
});

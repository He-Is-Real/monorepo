import { request } from 'node:http';
import { setInstanceLookup } from '../index';

/**
 * `service.region` and `service.instance` (LG-10): read once from Google's metadata server, in the
 * background, the first time a line is written on Cloud Run (`K_SERVICE` or `CLOUD_RUN_JOB` set).
 * Nothing waits for it: start-up and requests go on, and lines simply lack the two fields until
 * each answers (or for good, if it never does). Each field lands as soon as its own answer does.
 * `GCE_METADATA_HOST` (the variable Google's client libraries read) points it elsewhere; tests
 * use it.
 */

/** Each request is given up after this long, however slowly the server keeps answering. */
const DEADLINE_MS = 2_000;

/** One metadata value as text; rejects on anything but a 200 within the deadline. Never keeps the process up. */
function metadata(host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    const req = request(
      {
        hostname,
        port: port ? Number(port) : 80,
        path: `/computeMetadata/v1/instance/${path}`,
        headers: { 'Metadata-Flavor': 'Google' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(new Error(`metadata ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length < 1_000) body += chunk;
        });
        res.on('end', () => done(undefined, body.trim()));
        res.on('error', (err) => done(err));
      },
    );
    // An absolute deadline, not socket inactivity: a server trickling bytes is cut off too.
    const deadline = setTimeout(
      () => req.destroy(new Error('metadata deadline')),
      DEADLINE_MS,
    );
    deadline.unref();
    function done(err: Error | undefined, value?: string) {
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(value ?? '');
    }
    req.on('error', (err) => done(err));
    req.on('socket', (socket) => socket.unref());
    req.end();
  });
}

setInstanceLookup((env, found) => {
  const host = env['GCE_METADATA_HOST']?.trim() || 'metadata.google.internal';
  metadata(host, 'region').then(
    // `projects/236063168938/regions/europe-west2` → `europe-west2`
    (region) => {
      if (region) found({ region: region.slice(region.lastIndexOf('/') + 1) });
    },
    () => undefined,
  );
  metadata(host, 'id').then(
    (id) => {
      if (id) found({ instance: id });
    },
    () => undefined,
  );
});

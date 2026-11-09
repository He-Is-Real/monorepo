import {
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRenewal,
  issueWorkerCertificate,
  makeCaCertificate,
  type Signer,
} from '@heisreal/worker-identity';
import {
  httpRequestCertificate,
  MAX_TIMER_MS,
  renewOnce,
  type RequestCertificate,
  startRenewal,
} from './renewal';
import { IdentityStore } from './store';

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keySigner =
  (key: KeyObject): Signer =>
  async (data) =>
    sign('sha256', data, { key, dsaEncoding: 'der' });
const pem = (key: KeyObject) =>
  key.export({ type: 'pkcs8', format: 'pem' }) as string;

let dir: string;
let store: IdentityStore;
let ca: X509Certificate;
let caSigner: Signer;

/** The signing service's real checks and signing, in-process (apps/cert-signer does the same). */
const signingService: RequestCertificate = async (request) => {
  const { machine, publicKey } = checkRenewal(
    request,
    ca,
    new Set(['joel-pc']),
    new Date(),
  );
  return (
    await issueWorkerCertificate(
      { machine, publicKey, ca, lifetimeHours: 24, now: new Date() },
      caSigner,
    )
  ).certificate;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'worker-identity-'));
  store = new IdentityStore(join(dir, 'identity'));
  const authority = p256();
  caSigner = keySigner(authority.privateKey);
  ca = new X509Certificate(
    await makeCaCertificate(
      {
        commonName: 'test authority',
        publicKey: authority.publicKey,
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2036-01-01T00:00:00Z'),
      },
      caSigner,
    ),
  );
  // What enrol leaves behind.
  await store.prepare();
  await store.writeInfo(
    {
      machine: 'joel-pc',
      project: 'p',
      projectNumber: '1',
      pool: 'workers',
      provider: 'worker-ca',
      serviceAccount: 'media-worker@p.iam.gserviceaccount.com',
      signerUrl: 'https://cert-signer.example',
    },
    ca.toString(),
    {},
  );
  const first = p256();
  const { certificate } = await issueWorkerCertificate(
    {
      machine: 'joel-pc',
      publicKey: first.publicKey,
      ca,
      lifetimeHours: 24,
      now: new Date(),
    },
    caSigner,
  );
  await store.install(pem(first.privateKey), certificate);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the worker renews its certificate', () => {
  it('swaps in a new key and certificate with the same name at the same path, and the old key is gone', async () => {
    const before = await store.current();
    const { notAfter } = await renewOnce(store, signingService);

    const after = await store.current();
    expect(after.key).not.toBe(before.key);
    // The same path: Dapr's Go client keeps the paths it read at start-up.
    expect(after.keyPath).toBe(before.keyPath);
    expect(after.certPath).toBe(before.certPath);
    const cert = new X509Certificate(after.certificate);
    expect(cert.subject).toContain('CN=joel-pc');
    expect(cert.validToDate).toEqual(notAfter);
    const config = JSON.parse(
      await readFile(store.certificateConfigPath, 'utf8'),
    );
    expect(config).toEqual({
      cert_configs: {
        workload: { cert_path: store.pairPath, key_path: store.pairPath },
      },
    });
    // Nothing else is left on disk: the old key went with the rename.
    expect(await readdir(join(store.dir, 'keys'))).toEqual(['current.pem']);
    const pair = await readFile(store.pairPath, 'utf8');
    expect(pair).toContain(after.key.trim());
    expect(pair).not.toContain(before.key.trim());
    // Owner-only, directory and files.
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.pairPath)).mode & 0o777).toBe(0o600);
    expect((await stat(store.certificateConfigPath)).mode & 0o777).toBe(0o600);
  });

  it('keeps the current pair if the service returns a certificate for another key', async () => {
    const before = await store.current();
    const wrongKey: RequestCertificate = async () =>
      (
        await issueWorkerCertificate(
          {
            machine: 'joel-pc',
            publicKey: p256().publicKey,
            ca,
            lifetimeHours: 24,
            now: new Date(),
          },
          caSigner,
        )
      ).certificate;
    await expect(renewOnce(store, wrongKey)).rejects.toThrow(/did not ask for/);
    expect(await store.current()).toEqual(before);
  });

  it('logs one clear line per refusal without key material and retries with a growing wait', async () => {
    const waits: number[] = [];
    const pending: (() => void)[] = [];
    const timers = {
      set: (fn: () => void, ms: number) => {
        waits.push(ms);
        pending.push(fn);
        return pending.length;
      },
      clear: () => undefined,
    };
    const logs: Record<string, unknown>[] = [];
    // The signing service refusing (e.g. another copy renewed first: not the newest certificate).
    const refused = httpRequestCertificate(
      'https://cert-signer.example',
      async () => 'id-token',
      (async () =>
        new Response(
          JSON.stringify({ code: 'certificate_refused', status: 403 }),
          { status: 403 },
        )) as typeof fetch,
    );
    const stop = startRenewal({
      store,
      requestCertificate: refused,
      intervalMs: 6 * 3600_000,
      log: (e) => logs.push(e),
      timers,
      // As if the current certificate was issued 7 hours ago: renewal is due now.
      now: () => Date.now() + 7 * 3600_000,
    });
    const run = async () => {
      pending.shift()?.();
      await vi.waitFor(() => expect(pending.length).toBe(1));
    };
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(waits[0]).toBe(0);
    await run();
    await run();
    await run();
    stop();

    expect(waits.slice(1)).toEqual([60_000, 120_000, 240_000]);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({
      step: 'identity_renewal_failed',
      code: expect.stringContaining(
        'another copy of it may have renewed first; cancel the name and enrol a new one',
      ),
      retryInSeconds: 60,
    });
    expect(JSON.stringify(logs)).not.toMatch(/BEGIN|PRIVATE/);
  });

  /** Timers that record each wait and run only when the test says. */
  function manualTimers() {
    const waits: number[] = [];
    const pending: (() => void)[] = [];
    return {
      waits,
      pending,
      timers: {
        set: (fn: () => void, ms: number) => {
          waits.push(ms);
          pending.push(fn);
          return pending.length;
        },
        clear: () => undefined,
      },
    };
  }

  it('renews before a certificate that is shorter than the interval expires, and retries before it does', async () => {
    // A 4-hour certificate, but renewal every 6 hours: due at the start of its last quarter.
    const short = p256();
    const issued = Date.now();
    const { certificate } = await issueWorkerCertificate(
      {
        machine: 'joel-pc',
        publicKey: short.publicKey,
        ca,
        lifetimeHours: 4,
        now: new Date(issued),
      },
      caSigner,
    );
    await store.install(pem(short.privateKey), certificate);
    const validFrom = new X509Certificate(certificate).validFromDate.getTime();
    const validTo = new X509Certificate(certificate).validToDate.getTime();
    const { waits, pending, timers } = manualTimers();
    let clock = validFrom;
    const logs: Record<string, unknown>[] = [];
    const stop = startRenewal({
      store,
      requestCertificate: async () => {
        throw new Error('the signing service answered 503');
      },
      intervalMs: 6 * 3600_000,
      log: (e) => logs.push(e),
      timers,
      now: () => clock,
    });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(waits[0]).toBe(((validTo - validFrom) * 3) / 4);
    expect(waits[0]).toBeLessThan(4 * 3600_000);

    // 50 seconds before expiry the renewal fails: the retry comes before expiry, not in a minute.
    clock = validTo - 50_000;
    pending.shift()?.();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    stop();
    expect(waits[1]).toBe(25_000);
    expect(logs[0]).toMatchObject({
      step: 'identity_renewal_failed',
      retryInSeconds: 25,
    });
  });

  it('after a renewal, schedules the next one by the interval', async () => {
    const { waits, pending, timers } = manualTimers();
    const logs: Record<string, unknown>[] = [];
    let clock = Date.now() + 7 * 3600_000;
    const stop = startRenewal({
      store,
      requestCertificate: async (request) => {
        clock = Date.now();
        return signingService(request);
      },
      intervalMs: 6 * 3600_000,
      log: (e) => logs.push(e),
      timers,
      now: () => clock,
    });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(waits[0]).toBe(0);
    pending.shift()?.();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    stop();
    expect(logs[0]).toMatchObject({ step: 'identity_renewed' });
    // Issued "now" (the signing service backdates notBefore a little): about 6 hours.
    expect(waits[1]).toBeGreaterThan(5.9 * 3600_000);
    expect(waits[1]).toBeLessThanOrEqual(6 * 3600_000);
  });

  it("refuses an interval longer than Node's timers can hold", () => {
    const start = (intervalMs: number) =>
      startRenewal({
        store,
        requestCertificate: signingService,
        intervalMs,
        log: () => undefined,
        timers: manualTimers().timers,
      });
    expect(() => start(MAX_TIMER_MS + 1)).toThrow(/renewal interval/);
    expect(() => start(0)).toThrow(/renewal interval/);
  });

  it('keeps an older layout working until its first renewal, then leaves only the pair file', async () => {
    // As the first version left it: separate files under their own names.
    const { certificate, key } = await store.current();
    const keys = join(store.dir, 'keys');
    const certPath = join(keys, 'old.cert.pem');
    const keyPath = join(keys, 'old.key.pem');
    await writeFile(certPath, certificate, { mode: 0o600 });
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(
      store.certificateConfigPath,
      JSON.stringify({
        cert_configs: { workload: { cert_path: certPath, key_path: keyPath } },
      }),
    );
    await rm(store.pairPath);
    await writeFile(join(keys, 'interrupted.tmp'), 'x');

    // Start-up clean-up removes the interrupted write only.
    await store.remove(await store.unused());
    expect((await readdir(keys)).sort()).toEqual([
      'old.cert.pem',
      'old.key.pem',
    ]);

    await renewOnce(store, signingService);
    await store.remove(await store.unused());
    expect(await readdir(keys)).toEqual(['current.pem']);
  });
});

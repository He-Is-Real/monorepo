import {
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  gcsNewestRecords,
  issueWorkerCertificate,
  makeCaCertificate,
  newestOf,
  type NewestRecords,
  renewalRequest,
  type Signer,
} from '@heisreal/worker-identity';
import { CertificatesController } from './certificates.controller';
import {
  NEWEST,
  SIGNER,
  SIGNER_CONFIG,
  type SignerConfig,
  signerConfig,
} from './config';
import { ProblemFilter } from './problem.filter';

// The real checks and certificate code; a local key stands in for the KMS key (same algorithm).
const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keySigner =
  (key: KeyObject): Signer =>
  async (data) =>
    sign('sha256', data, { key, dsaEncoding: 'der' });

async function authority(name: string) {
  const { publicKey, privateKey } = p256();
  const ca = new X509Certificate(
    await makeCaCertificate(
      {
        commonName: name,
        publicKey,
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2036-01-01T00:00:00Z'),
      },
      keySigner(privateKey),
    ),
  );
  return { ca, signer: keySigner(privateKey) };
}

/**
 * Cloud Storage's JSON API for the records bucket, in memory: objects with generations, 404 for
 * a missing one, 412 when ifGenerationMatch no longer matches. `beforeRead` can hold reads back
 * (to line two renewals up on the same record).
 */
function fakeStorage(beforeRead: () => Promise<void> = async () => undefined) {
  const objects = new Map<string, { body: string; generation: number }>();
  let generations = 0;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (!init?.method || init.method === 'GET') {
      await beforeRead();
      const name = decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
      const found = objects.get(name);
      if (!found) return new Response('{}', { status: 404 });
      return new Response(found.body, {
        headers: { 'x-goog-generation': String(found.generation) },
      });
    }
    const name = url.searchParams.get('name') ?? '';
    const ifMatch = url.searchParams.get('ifGenerationMatch');
    if (
      ifMatch !== null &&
      ifMatch !== String(objects.get(name)?.generation ?? 0)
    ) {
      return new Response('{}', { status: 412 });
    }
    objects.set(name, { body: String(init.body), generation: ++generations });
    return new Response('{}');
  }) as typeof fetch;
  return gcsNewestRecords(
    'heisreal-test-worker-certificates',
    async () => 'token',
    fetcher,
  );
}

/** The signing service as it runs, with these settings and a local key for the KMS key. */
async function startService(
  config: SignerConfig,
  signer: Signer,
  newest: NewestRecords = fakeStorage(),
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [CertificatesController],
    providers: [
      { provide: APP_FILTER, useClass: ProblemFilter },
      { provide: SIGNER_CONFIG, useValue: config },
      { provide: SIGNER, useValue: signer },
      { provide: NEWEST, useValue: newest },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

/** A certificate from `from` for `machine`, as a worker holds it: the cert and its key. */
async function held(
  machine: string,
  from: Awaited<ReturnType<typeof authority>>,
  issuedAt = new Date(),
  lifetimeHours = 24,
) {
  const key = p256();
  const { certificate } = await issueWorkerCertificate(
    {
      machine,
      publicKey: key.publicKey,
      ca: from.ca,
      lifetimeHours,
      now: issuedAt,
    },
    from.signer,
  );
  return { certificate, key: key.privateKey };
}

/** What `worker-identity.sh enrol` does: a certificate, recorded as the machine's newest. */
async function enrolled(
  machine: string,
  from: Awaited<ReturnType<typeof authority>>,
  records: NewestRecords,
) {
  const current = await held(machine, from);
  await records.write(
    machine,
    newestOf(new X509Certificate(current.certificate)),
  );
  return current;
}

const postTo = (url: string, body: unknown) =>
  fetch(`${url}/v1/certificates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /v1/certificates (the worker renews its certificate)', () => {
  let app: INestApplication;
  let url: string;
  let ours: Awaited<ReturnType<typeof authority>>;
  const records = fakeStorage();
  const logs: string[] = [];

  const post = (body: unknown) => postTo(url, body);

  beforeAll(async () => {
    ours = await authority('He Is Real test worker authority');
    ({ app, url } = await startService(
      {
        ca: ours.ca,
        allowed: new Set(['joel-pc', 'church-1']),
        lifetimeHours: 24,
        kmsKeyVersion: 'unused',
        recordsBucket: 'unused',
      },
      ours.signer,
      records,
    ));
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('gives a certificate for the new key, with the same machine name, valid for the lifetime', async () => {
    const current = await enrolled('joel-pc', ours, records);
    const next = p256();
    const before = Date.now();
    const res = await post(
      renewalRequest(current.certificate, current.key, next.publicKey),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      certificate: string;
      notAfter: string;
    };
    const cert = new X509Certificate(body.certificate);
    expect(cert.subject).toBe('O=He Is Real Today\nCN=joel-pc');
    expect(cert.verify(ours.ca.publicKey)).toBe(true);
    expect(cert.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      next.publicKey.export({ type: 'spki', format: 'der' }),
    );
    const lifetime = cert.validToDate.getTime() - before;
    expect(lifetime).toBeGreaterThan(24 * 3600_000 - 60_000);
    expect(lifetime).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
    expect(body.notAfter).toBe(cert.validToDate.toISOString());
    // The log line names the machine and expiry, never the certificate itself.
    const issued = logs.find((l) => l.includes('certificate_issued'));
    expect(JSON.parse(issued ?? '{}')).toMatchObject({
      step: 'certificate_issued',
      machine: 'joel-pc',
    });
    expect(issued).not.toContain('BEGIN');
  });

  it('refuses an expired current certificate (the machine was off too long: enrol again)', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    const current = await held('joel-pc', ours, twoDaysAgo, 24);
    const res = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(await res.json()).toMatchObject({ code: 'certificate_refused' });
  });

  it('refuses a machine whose name was taken off the allowed list (cancelled)', async () => {
    const current = await held('old-laptop', ours);
    const res = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(res.status).toBe(403);
  });

  it('refuses a certificate from any other authority', async () => {
    const stranger = await authority('He Is Real test worker authority');
    const current = await held('joel-pc', stranger);
    const res = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(res.status).toBe(403);
  });

  it("refuses a copied certificate without its key (the request isn't signed by it)", async () => {
    const current = await held('joel-pc', ours);
    const res = await post(
      renewalRequest(current.certificate, p256().privateKey, p256().publicKey),
    );
    expect(res.status).toBe(403);
  });

  it('refuses keeping the same key, and keys that are not P-256', async () => {
    const current = await held('joel-pc', ours);
    const same = await post(
      renewalRequest(
        current.certificate,
        current.key,
        // The current certificate's own public key.
        new X509Certificate(current.certificate).publicKey,
      ),
    );
    expect(same.status).toBe(403);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const notP256 = await post(
      renewalRequest(current.certificate, current.key, rsa.publicKey),
    );
    expect(notP256.status).toBe(403);
  });

  it('renews only the newest certificate: a copy that renews second is refused, and logged as one', async () => {
    const current = await enrolled('joel-pc', ours, records);
    // The real worker renews; a copy of the same certificate and key then tries.
    const real = p256();
    const first = await post(
      renewalRequest(current.certificate, current.key, real.publicKey),
    );
    expect(first.status).toBe(200);
    const copy = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(copy.status).toBe(403);
    expect(await copy.json()).toMatchObject({ code: 'certificate_refused' });
    const refused = logs.filter((l) => l.includes('not_newest')).at(-1);
    expect(JSON.parse(refused ?? '{}')).toMatchObject({
      step: 'certificate_refused',
      reason: 'not_newest',
      machine: 'joel-pc',
      message:
        'not the newest certificate for joel-pc: possible copy; cancel and enrol a new name',
    });
    // The winner carries on renewing.
    const { certificate } = (await first.json()) as { certificate: string };
    const again = await post(
      renewalRequest(certificate, real.privateKey, p256().publicKey),
    );
    expect(again.status).toBe(200);
  });

  it('after a lost reply, gives the same certificate again for the same key, and nothing new', async () => {
    const current = await enrolled('joel-pc', ours, records);
    const next = p256();
    const request = renewalRequest(
      current.certificate,
      current.key,
      next.publicKey,
    );
    const first = await post(request);
    expect(first.status).toBe(200);
    const issued = (await first.json()) as {
      certificate: string;
      notAfter: string;
    };
    // The reply was lost: the worker still holds the old certificate and asks again, later, with
    // the same saved key (a freshly signed proof). It gets that exact certificate: same serial,
    // same expiry, so a replay never extends the lifetime.
    const retry = await post(
      renewalRequest(current.certificate, current.key, next.publicKey),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(issued);
    const replayed = logs.filter((l) => l.includes('certificate_replayed'));
    expect(JSON.parse(replayed.at(-1) ?? '{}')).toMatchObject({
      machine: 'joel-pc',
      notAfter: issued.notAfter,
    });
    expect(replayed.at(-1)).not.toContain('BEGIN');
    // Still one line of renewals: that certificate renews as normal.
    const onward = await post(
      renewalRequest(issued.certificate, next.privateKey, p256().publicKey),
    );
    expect(onward.status).toBe(200);
    // And once it has, the old certificate can't fetch anything any more, not even with the
    // key it once asked for.
    const late = await post(
      renewalRequest(current.certificate, current.key, next.publicKey),
    );
    expect(late.status).toBe(403);
  });

  it('refuses a retry from the replaced certificate that asks for any other key', async () => {
    const current = await enrolled('joel-pc', ours, records);
    const first = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(first.status).toBe(200);
    const other = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: 'certificate_refused' });
  });

  it('refuses a machine with no record (enrolled before the newest-only check: enrol again)', async () => {
    const current = await held('church-1', ours);
    const res = await post(
      renewalRequest(current.certificate, current.key, p256().publicKey),
    );
    expect(res.status).toBe(403);
  });

  it('enrolling again makes the new certificate the newest, so an older copy is refused', async () => {
    const stolen = await enrolled('joel-pc', ours, records);
    const fresh = await enrolled('joel-pc', ours, records);
    const byCopy = await post(
      renewalRequest(stolen.certificate, stolen.key, p256().publicKey),
    );
    expect(byCopy.status).toBe(403);
    const byWorker = await post(
      renewalRequest(fresh.certificate, fresh.key, p256().publicKey),
    );
    expect(byWorker.status).toBe(200);
  });

  it('answers 400 to a request that is not a renewal, or asks for a name', async () => {
    const current = await held('joel-pc', ours);
    const asksForAName = {
      ...renewalRequest(current.certificate, current.key, p256().publicKey),
      machine: 'church-1',
    };
    for (const body of [
      {},
      { certificate: 'x', publicKey: 'y' },
      [1, 2],
      'text',
      asksForAName,
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
  });
});

describe('the signing service after the last machine was cancelled', () => {
  const settings = (ca: X509Certificate) => ({
    CA_CERTIFICATE: ca.toString(),
    CERTIFICATE_LIFETIME_HOURS: '24',
    KMS_KEY_VERSION:
      'projects/heisreal-dev/locations/europe-west2/keyRings/worker-identity/cryptoKeys/worker-ca/cryptoKeyVersions/1',
    CERTIFICATE_RECORDS_BUCKET: 'heisreal-dev-worker-certificates',
  });

  it('starts with an empty machine list and refuses every renewal', async () => {
    const ours = await authority('He Is Real test worker authority');
    const { app, url } = await startService(
      signerConfig({ ...settings(ours.ca), ALLOWED_MACHINES: '' }),
      ours.signer,
    );
    try {
      const current = await enrolled('joel-pc', ours, fakeStorage());
      const res = await postTo(
        url,
        renewalRequest(current.certificate, current.key, p256().publicKey),
      );
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('refuses to start without the machine list setting at all', async () => {
    const ours = await authority('He Is Real test worker authority');
    expect(() => signerConfig(settings(ours.ca))).toThrow(
      'ALLOWED_MACHINES is missing',
    );
  });
});

describe('two renewals of the same certificate at once', () => {
  /** Both requests read the same record before either writes (Cloud Storage held back). */
  async function raced(bodies: (cert: string, key: KeyObject) => unknown[]) {
    const ours = await authority('He Is Real test worker authority');
    let waiting = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    let gate = false;
    const records = fakeStorage(async () => {
      if (!gate) return;
      if (++waiting === 2) release();
      if (waiting <= 2) await bothRead;
    });
    const { app, url } = await startService(
      {
        ca: ours.ca,
        allowed: new Set(['joel-pc']),
        lifetimeHours: 24,
        kmsKeyVersion: 'unused',
        recordsBucket: 'unused',
      },
      ours.signer,
      records,
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const current = await enrolled('joel-pc', ours, records);
      gate = true;
      return await Promise.all(
        bodies(current.certificate, current.key).map(async (body) => {
          const res = await postTo(url, body);
          return { status: res.status, body: (await res.json()) as unknown };
        }),
      );
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  }

  it('lets exactly one win (the record is written only if it is unchanged)', async () => {
    const results = await raced((cert, key) =>
      [p256(), p256()].map((next) => renewalRequest(cert, key, next.publicKey)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it("gives a retry racing the first request (same key) the winner's certificate", async () => {
    const next = p256();
    const results = await raced((cert, key) => [
      renewalRequest(cert, key, next.publicKey),
      renewalRequest(cert, key, next.publicKey),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
  });
});

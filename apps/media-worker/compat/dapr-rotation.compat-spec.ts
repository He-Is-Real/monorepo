/**
 * Dapr's sidecar keeps signing in across certificate renewals (Codex review of the worker
 * identity, round 1, finding 1). LOCAL ONLY, never in CI: it needs Go and openssl and downloads
 * Go modules. `pnpm nx run media-worker:compat-test`.
 *
 * The stand-in for daprd (go-auth/main.go) is Google's Go client library at the version daprd
 * 1.19.1 ships, loading our credentials.json once, as daprd does. A fake Google token service on
 * 127.0.0.1 checks what the real one relies on: an mTLS client certificate from our authority,
 * and a subject token naming that same certificate. Then the worker's real renewal (renewOnce)
 * swaps the pair twice while the stand-in keeps running; each later token must come from the new
 * certificate, over a handshake with the new certificate, and the old key must be gone.
 *
 * The fake service closes each connection after answering: a kept-alive connection would carry
 * the old handshake, but daprd refreshes about hourly and Go drops idle connections after 90 s.
 */
import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TLSSocket } from 'node:tls';
import {
  checkRenewal,
  issueWorkerCertificate,
  makeCaCertificate,
  type Signer,
} from '@heisreal/worker-identity';
import { credentialConfig } from '../src/identity/google';
import { renewOnce, type RequestCertificate } from '../src/identity/renewal';
import { IdentityStore } from '../src/identity/store';

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keySigner =
  (key: KeyObject): Signer =>
  async (data) =>
    sign('sha256', data, { key, dsaEncoding: 'der' });

let dir: string;
let store: IdentityStore;
let ca: X509Certificate;
let caSigner: Signer;
let server: Server;
let harness: ChildProcessWithoutNullStreams;
let nextLine: () => Promise<string>;
/** What the fake token service saw: one entry per request. */
const seen: { path: string; tlsSerial: string; subjectSerial?: string }[] = [];

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

const serial = async () =>
  new X509Certificate((await store.current()).certificate).serialNumber;

/** The fake STS and IAM Credentials: refuse anything not proven with a certificate of ours. */
function tokenService(req: import('node:http').IncomingMessage, body: string) {
  const peer = (req.socket as TLSSocket).getPeerX509Certificate();
  if (!peer || !peer.verify(ca.publicKey)) return { status: 401, json: {} };
  const tlsSerial = peer.serialNumber;
  if (req.url === '/v1/token') {
    const chain = JSON.parse(
      new URLSearchParams(body).get('subject_token') ?? '[]',
    ) as string[];
    const leaf = new X509Certificate(Buffer.from(chain[0] ?? '', 'base64'));
    seen.push({ path: 'sts', tlsSerial, subjectSerial: leaf.serialNumber });
    // Google's token service takes the subject certificate only over a handshake with it.
    if (!leaf.raw.equals(peer.raw)) return { status: 401, json: {} };
    return {
      status: 200,
      json: {
        access_token: `federated-${leaf.serialNumber}`,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 1,
      },
    };
  }
  if (req.url?.endsWith(':generateAccessToken')) {
    seen.push({ path: 'iam', tlsSerial });
    if (req.headers.authorization !== `Bearer federated-${tlsSerial}`) {
      return { status: 401, json: {} };
    }
    return {
      status: 200,
      json: {
        accessToken: `media-worker-${tlsSerial}`,
        expireTime: new Date(Date.now() + 1000).toISOString(),
      },
    };
  }
  return { status: 404, json: {} };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dapr-rotation-'));
  // The fake service's own TLS certificate, trusted by the stand-in through SSL_CERT_FILE.
  const serverKey = join(dir, 'server.key');
  const serverCert = join(dir, 'server.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      serverKey,
      '-out',
      serverCert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  server = createServer(
    {
      key: await readFile(serverKey),
      cert: await readFile(serverCert),
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { status, json } = tokenService(req, body);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(JSON.stringify(json));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Our authority, and the identity directory as enrol leaves it.
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
  store = new IdentityStore(join(dir, 'identity'));
  await store.prepare();
  const info = {
    machine: 'joel-pc',
    project: 'p',
    projectNumber: '1',
    pool: 'workers',
    provider: 'worker-ca',
    serviceAccount: 'media-worker@p.iam.gserviceaccount.com',
    signerUrl: 'https://cert-signer.example',
  };
  // The real configuration, pointed at the fake service instead of Google's.
  await store.writeInfo(info, ca.toString(), {
    ...credentialConfig(info, store.certificateConfigPath),
    token_url: `${url}/v1/token`,
    service_account_impersonation_url: `${url}/v1/projects/-/serviceAccounts/${info.serviceAccount}:generateAccessToken`,
  });
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
  await store.install(
    first.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certificate,
  );

  const binary = join(dir, 'daprd-auth');
  execFileSync('go', ['build', '-o', binary, '.'], {
    cwd: join(__dirname, 'go-auth'),
    stdio: 'ignore',
  });
  harness = spawn(binary, [], {
    env: {
      ...process.env,
      GOOGLE_APPLICATION_CREDENTIALS: store.credentialsPath,
      SSL_CERT_FILE: serverCert,
    },
  });
  const lines = createInterface({ input: harness.stdout })[
    Symbol.asyncIterator
  ]();
  nextLine = async () => {
    harness.stdin.write('token\n');
    const { value } = await lines.next();
    return String(value);
  };
});

afterAll(async () => {
  harness?.kill();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  await rm(dir, { recursive: true, force: true });
});

describe("Dapr's Go client across renewals", () => {
  it('signs in with each new certificate, over a handshake with it, without a restart', async () => {
    const serials = [await serial()];
    expect(await nextLine()).toBe(`media-worker-${serials[0]}`);

    for (let i = 0; i < 2; i++) {
      await renewOnce(store, signingService);
      serials.push(await serial());
      expect(await nextLine()).toBe(`media-worker-${serials.at(-1)}`);
      // The old key is gone: only the current pair is on disk.
      expect(await readdir(join(store.dir, 'keys'))).toEqual(['current.pem']);
    }

    expect(new Set(serials).size).toBe(3);
    // Every request was made over a handshake with the certificate it presented.
    for (const entry of seen) {
      if (entry.subjectSerial)
        expect(entry.tlsSerial).toBe(entry.subjectSerial);
    }
    expect(seen.map((e) => e.tlsSerial)).toEqual(
      serials.flatMap((s) => [s, s]),
    );
  });
});

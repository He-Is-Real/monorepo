/**
 * The two commands a developer runs with their own gcloud login (never a key file), through
 * tools/scripts/worker-identity.sh:
 *
 *   enrol   on the worker machine: its first certificate, or a new one after it was off for
 *           longer than the lifetime. Makes a key here, has the authority's KMS key sign a
 *           certificate for it, records it as the machine's newest (W2-1 A: only that one
 *           may renew, and any older copy can't), and writes the identity directory (store.ts).
 *   ca      once (or to replace it): the authority's own certificate, self-signed with the KMS
 *           key, written to the given file (public; committed for OpenTofu).
 *   check   used by media-worker.sh before it starts: is there a certificate, and still valid?
 *           Prints the Google project number (for the result writer's address).
 *
 * enrol reads the signing service's description (`gcloud run services describe cert-signer
 * --format=json`) on stdin: its settings are what OpenTofu deployed (allowed machines, lifetime,
 * KMS key, the authority's certificate) and its address. The access token is read from
 * `gcloud auth print-access-token` and never printed.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  gcsNewestRecords,
  issueWorkerCertificate,
  kmsPublicKey,
  kmsSigner,
  MACHINE_NAME,
  makeCaCertificate,
  newestOf,
} from '@heisreal/worker-identity';
import { credentialConfig } from './google';
import { defaultIdentityDir, IdentityStore } from './store';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

const accessToken = async () =>
  execFileSync('gcloud', ['auth', 'print-access-token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

/** The signing service's settings and address, from its Cloud Run description on stdin. */
function signingService(): { settings: Map<string, string>; url: string } {
  const service = JSON.parse(readFileSync(0, 'utf8')) as {
    spec?: {
      template?: {
        spec?: { containers?: { env?: { name: string; value?: string }[] }[] };
      };
    };
    status?: { url?: string };
  };
  const settings = new Map(
    (service.spec?.template?.spec?.containers?.[0]?.env ?? []).map((e) => [
      e.name,
      e.value ?? '',
    ]),
  );
  const url = service.status?.url ?? '';
  if (!/^https:\/\/[a-z0-9.-]+$/.test(url))
    throw new Error('the signing service has no https address yet');
  return { settings, url };
}

async function enrol(machine: string): Promise<void> {
  if (!MACHINE_NAME.test(machine))
    throw new Error(`"${machine}" is not a machine name`);
  const { settings, url } = signingService();
  const setting = (name: string) => {
    const value = settings.get(name);
    if (!value) throw new Error(`the signing service has no ${name} setting`);
    return value;
  };
  const allowed = setting('ALLOWED_MACHINES')
    .split(',')
    .map((m) => m.trim());
  if (!allowed.includes(machine)) {
    throw new Error(
      `"${machine}" isn't in worker_identity.machines (infra/terraform/live/dev/gcp/main.tf): add it there and apply first`,
    );
  }
  const caPem = setting('CA_CERTIFICATE');
  const ca = new X509Certificate(caPem);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { certificate, notAfter } = await issueWorkerCertificate(
    {
      machine,
      publicKey: key.publicKey,
      ca,
      lifetimeHours: Number(setting('CERTIFICATE_LIFETIME_HOURS')),
      now: new Date(),
    },
    kmsSigner(setting('KMS_KEY_VERSION'), accessToken),
  );
  // Unconditional: enrolling resets the machine's line of renewals to this certificate.
  await gcsNewestRecords(
    setting('CERTIFICATE_RECORDS_BUCKET'),
    accessToken,
  ).write(machine, newestOf(new X509Certificate(certificate)));
  const store = new IdentityStore(defaultIdentityDir());
  await store.prepare();
  const info = {
    machine,
    project: env('GCP_PROJECT'),
    projectNumber: env('GCP_PROJECT_NUMBER'),
    pool: env('WORKLOAD_IDENTITY_POOL'),
    provider: env('WORKLOAD_IDENTITY_PROVIDER'),
    serviceAccount: env('MEDIA_WORKER_ACCOUNT'),
    signerUrl: url,
  };
  await store.writeInfo(
    info,
    caPem,
    credentialConfig(info, store.certificateConfigPath),
  );
  await store.install(
    key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certificate,
  );
  // Files from an older layout or an interrupted write.
  await store.remove(await store.unused());
  console.error(
    `worker-identity: ${machine} enrolled in ${store.dir}; certificate valid until ${notAfter.toISOString()}`,
  );
}

async function ca(out: string): Promise<void> {
  const keyVersion = env('KMS_KEY_VERSION');
  const years = Number(env('CA_YEARS'));
  if (!Number.isInteger(years) || years < 1 || years > 20)
    throw new Error('CA_YEARS is out of range');
  const token = await accessToken();
  const publicKey = await kmsPublicKey(keyVersion, token);
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  const pem = await makeCaCertificate(
    { commonName: env('CA_NAME'), publicKey, notBefore, notAfter },
    kmsSigner(keyVersion, async () => token),
  );
  await writeFile(out, pem);
  console.error(
    `worker-identity: wrote the authority's certificate to ${out} (valid until ${notAfter.toISOString()})`,
  );
}

async function check(): Promise<void> {
  const store = new IdentityStore(defaultIdentityDir());
  let info;
  let cert: X509Certificate;
  try {
    info = await store.info();
    cert = new X509Certificate((await store.current()).certificate);
  } catch {
    throw new Error(
      "this machine has no worker identity: run 'tools/scripts/worker-identity.sh enrol <machine>' (docs/media-runbook.md)",
    );
  }
  if (cert.validToDate <= new Date()) {
    throw new Error(
      `${info.machine}'s certificate expired at ${cert.validToDate.toISOString()} (off longer than its lifetime): run 'tools/scripts/worker-identity.sh enrol ${info.machine}'`,
    );
  }
  console.error(
    `worker-identity: ${info.machine}, certificate valid until ${cert.validToDate.toISOString()}`,
  );
  console.log(info.projectNumber);
}

const [command, arg] = process.argv.slice(2);
const run =
  command === 'enrol' && arg
    ? enrol(arg)
    : command === 'ca' && arg
      ? ca(arg)
      : command === 'check'
        ? check()
        : Promise.reject(
            new Error(
              'usage: identity.js enrol <machine> | ca <out.pem> | check',
            ),
          );
run.catch((err: unknown) => {
  console.error(
    `worker-identity: ${err instanceof Error ? err.message : 'failed'}`,
  );
  process.exit(1);
});

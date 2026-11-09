/**
 * The worker's own identity (W1-A; Joel, 2026-11-08, worker-and-gcloud-sign-in.html): X.509
 * certificates our own authority signs, which Google's workload identity federation trusts
 * (infra/terraform/modules/gcp/worker_identity.tf). The authority's key is a Cloud KMS key that
 * never leaves Google; whoever signs passes a `Signer` that calls it.
 *
 * Shared by the signing service (apps/cert-signer: checks a renewal, signs the new certificate),
 * the media worker (asks for renewals) and the enrol and CA commands
 * (tools/scripts/worker-identity.sh), so all three write and read certificates the same way.
 *
 * Every key is EC P-256 (Google accepts P-256 for federation; KMS EC_SIGN_P256_SHA256).
 */
import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';
import {
  bitString,
  bool,
  children,
  explicit,
  implicit,
  octetString,
  oid,
  read,
  sequence,
  set,
  time,
  tlv,
  unsignedInteger,
  utf8,
} from './der';

/** A machine's name: the certificate's subject CN, and what Google maps to the principal. */
export const MACHINE_NAME = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;

/** Google's limit for a federated leaf certificate is 390 days; ours stays well inside it. */
export const MAX_LIFETIME_HOURS = 30 * 24;

/** Started this many minutes ago, so a worker whose clock is a little behind can use it at once. */
const BACKDATE_MS = 5 * 60_000;

const ORGANISATION = 'He Is Real Today';

/** Signs `data` (SHA-256, ECDSA P-256) and returns the DER signature: Cloud KMS, or a test key. */
export type Signer = (data: Buffer) => Promise<Buffer>;

const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organisation: '2.5.4.10',
  subjectKeyId: '2.5.29.14',
  keyUsage: '2.5.29.15',
  basicConstraints: '2.5.29.19',
  authorityKeyId: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

const ECDSA_SHA256 = sequence(oid(OID.ecdsaWithSha256));

/** Why a certificate or renewal was refused: logged by the signing service, never sent back. */
export type RefusalReason =
  | 'malformed'
  | 'not_ours'
  | 'is_ca'
  | 'not_yet_valid'
  | 'expired'
  | 'name_not_allowed'
  | 'bad_key'
  | 'same_key'
  | 'bad_proof'
  /** Not the newest certificate issued for the machine: possibly a copy (newest.ts). */
  | 'not_newest';

export class CertificateRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`certificate refused: ${reason}`);
    this.name = 'CertificateRefused';
  }
}

function name(commonName: string): Buffer {
  return sequence(
    set(sequence(oid(OID.organisation), utf8(ORGANISATION))),
    set(sequence(oid(OID.commonName), utf8(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [bool(true)] : []),
    octetString(value),
  );
}

/** KeyUsage as a DER BIT STRING: one byte, its trailing zero bits counted as unused. */
function keyUsage(byte: number): Buffer {
  let unused = 0;
  while (unused < 7 && !(byte & (1 << unused))) unused++;
  return tlv(0x03, Buffer.from([unused, byte]));
}

/** An EC P-256 public key, or refuse. */
export function p256(key: KeyObject): KeyObject {
  if (
    key.type !== 'public' ||
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new CertificateRefused('bad_key');
  }
  return key;
}

const spkiOf = (key: KeyObject) =>
  key.export({ type: 'spki', format: 'der' }) as Buffer;

/** RFC 5280 4.2.1.2 method 1: SHA-1 of the public key's bits. */
function keyId(spki: Buffer): Buffer {
  const [, bits] = children(read(spki).value);
  return createHash('sha1').update(bits.value.subarray(1)).digest();
}

/** The subject (as DER) of a certificate we hold, to name it as the issuer. */
function subjectOf(cert: X509Certificate): Buffer {
  const [tbs] = children(read(cert.raw).value);
  const fields = children(tbs.value);
  // version [0], serial, signature, issuer, validity, subject
  return fields[5].raw;
}

function serial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x40; // positive, and always 16 bytes long
  return unsignedInteger(bytes);
}

async function signed(
  tbs: Buffer,
  signer: Signer,
  issuerKey: KeyObject,
): Promise<X509Certificate> {
  const signature = await signer(tbs);
  const cert = new X509Certificate(
    sequence(tbs, ECDSA_SHA256, bitString(signature)),
  );
  // The signer is a remote key: check what it gave us before anyone relies on it.
  if (!cert.verify(issuerKey)) {
    throw new Error('the signer returned a signature that does not verify');
  }
  return cert;
}

/**
 * Our certificate authority's own certificate, self-signed with its KMS key (once, by a
 * developer: `tools/scripts/worker-identity.sh ca`). Only its public part is ever written down.
 */
export async function makeCaCertificate(
  input: {
    commonName: string;
    publicKey: KeyObject;
    notBefore: Date;
    notAfter: Date;
  },
  signer: Signer,
): Promise<string> {
  const spki = spkiOf(p256(input.publicKey));
  const subject = name(input.commonName);
  const tbs = sequence(
    explicit(0, unsignedInteger(Buffer.from([2]))), // v3
    serial(),
    ECDSA_SHA256,
    subject,
    sequence(time(input.notBefore), time(input.notAfter)),
    subject,
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence(bool(true))),
        extension(OID.keyUsage, true, keyUsage(0x06)), // keyCertSign, cRLSign
        extension(OID.subjectKeyId, false, octetString(keyId(spki))),
      ),
    ),
  );
  return (await signed(tbs, signer, input.publicKey)).toString();
}

/**
 * A worker certificate for `machine` and `publicKey`, valid `lifetimeHours` from now (backdated
 * five minutes), signed by our authority. Callers have already decided the name may have one.
 */
export async function issueWorkerCertificate(
  input: {
    machine: string;
    publicKey: KeyObject;
    ca: X509Certificate;
    lifetimeHours: number;
    now: Date;
  },
  signer: Signer,
): Promise<{ certificate: string; notAfter: Date }> {
  if (!MACHINE_NAME.test(input.machine)) {
    throw new CertificateRefused('name_not_allowed');
  }
  if (
    !Number.isInteger(input.lifetimeHours) ||
    input.lifetimeHours < 1 ||
    input.lifetimeHours > MAX_LIFETIME_HOURS
  ) {
    throw new Error(`lifetime must be 1 to ${MAX_LIFETIME_HOURS} hours`);
  }
  const spki = spkiOf(p256(input.publicKey));
  // Certificates hold whole seconds: round down, so notAfter is exactly what the certificate says.
  const now = Math.floor(input.now.getTime() / 1000) * 1000;
  const notBefore = new Date(now - BACKDATE_MS);
  const notAfter = new Date(now + input.lifetimeHours * 3600_000);
  const caSpki = spkiOf(input.ca.publicKey);
  const tbs = sequence(
    explicit(0, unsignedInteger(Buffer.from([2]))),
    serial(),
    ECDSA_SHA256,
    subjectOf(input.ca),
    sequence(time(notBefore), time(notAfter)),
    name(input.machine),
    spki,
    explicit(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        extension(OID.keyUsage, true, keyUsage(0x80)), // digitalSignature
        extension(OID.extKeyUsage, false, sequence(oid(OID.clientAuth))),
        extension(OID.subjectKeyId, false, octetString(keyId(spki))),
        extension(
          OID.authorityKeyId,
          false,
          sequence(implicit(0, keyId(caSpki))),
        ),
      ),
    ),
  );
  const cert = await signed(tbs, signer, input.ca.publicKey);
  return { certificate: cert.toString(), notAfter };
}

/** The subject's single CN, or null. */
function commonName(cert: X509Certificate): string | null {
  const cns = cert.subject
    .split('\n')
    .filter((line) => line.startsWith('CN='))
    .map((line) => line.slice(3));
  return cns.length === 1 ? cns[0] : null;
}

/**
 * The machine a worker certificate names, if our authority issued it, it is valid at `now`,
 * and the name is still allowed. Otherwise throws CertificateRefused.
 */
export function checkWorkerCertificate(
  pem: string,
  ca: X509Certificate,
  allowed: ReadonlySet<string>,
  now: Date,
): { machine: string; cert: X509Certificate } {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new CertificateRefused('malformed');
  }
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) {
    throw new CertificateRefused('not_ours');
  }
  if (cert.ca) throw new CertificateRefused('is_ca');
  if (now < cert.validFromDate) throw new CertificateRefused('not_yet_valid');
  if (now >= cert.validToDate) throw new CertificateRefused('expired');
  const machine = commonName(cert);
  if (!machine || !MACHINE_NAME.test(machine) || !allowed.has(machine)) {
    throw new CertificateRefused('name_not_allowed');
  }
  return { machine, cert };
}

/** What the worker's current key signs to ask for a certificate for its next key. */
export function renewalProofMessage(newPublicKey: KeyObject): Buffer {
  return Buffer.concat([
    Buffer.from('heisreal worker certificate renewal v1\n', 'utf8'),
    spkiOf(newPublicKey),
  ]);
}

/** A renewal request, as the signing service receives it (libs/contracts/openapi/cert-signer.yaml). */
export interface RenewalRequest {
  /** The current certificate (PEM). */
  certificate: string;
  /** The new key's public part (SPKI PEM). */
  publicKey: string;
  /** base64url DER ECDSA signature, by the current key, over renewalProofMessage(new key). */
  proof: string;
}

/** The worker's side: prove the current key holds the current certificate, for the new key. */
export function renewalRequest(
  currentCertificate: string,
  currentKey: KeyObject,
  newPublicKey: KeyObject,
): RenewalRequest {
  return {
    certificate: currentCertificate,
    publicKey: newPublicKey.export({ type: 'spki', format: 'pem' }) as string,
    proof: sign('sha256', renewalProofMessage(newPublicKey), {
      key: currentKey,
      dsaEncoding: 'der',
    }).toString('base64url'),
  };
}

/**
 * The signing service's check: the current certificate is ours, valid and still allowed, the
 * request was signed by its key, and the new key is a different P-256 key. Returns the machine
 * (the new certificate gets exactly this name), the current certificate and the new key. Throws
 * CertificateRefused.
 */
export function checkRenewal(
  request: RenewalRequest,
  ca: X509Certificate,
  allowed: ReadonlySet<string>,
  now: Date,
): { machine: string; current: X509Certificate; publicKey: KeyObject } {
  const { machine, cert } = checkWorkerCertificate(
    request.certificate,
    ca,
    allowed,
    now,
  );
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: request.publicKey, format: 'pem' });
  } catch {
    throw new CertificateRefused('malformed');
  }
  p256(publicKey);
  if (spkiOf(publicKey).equals(spkiOf(cert.publicKey))) {
    throw new CertificateRefused('same_key');
  }
  const proof = Buffer.from(request.proof, 'base64url');
  let ok = false;
  try {
    ok = verify(
      'sha256',
      renewalProofMessage(publicKey),
      { key: cert.publicKey, dsaEncoding: 'der' },
      proof,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new CertificateRefused('bad_proof');
  return { machine, current: cert, publicKey };
}

import {
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from 'node:crypto';
import {
  checkWorkerCertificate,
  issueWorkerCertificate,
  makeCaCertificate,
  type Signer,
} from './certificates';

// A local key stands in for Cloud KMS: same algorithm, same DER signatures.
const keySigner =
  (key: KeyObject): Signer =>
  async (data) =>
    sign('sha256', data, { key, dsaEncoding: 'der' });

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const now = new Date('2026-11-08T12:00:00Z');

async function authority() {
  const { publicKey, privateKey } = p256();
  const pem = await makeCaCertificate(
    {
      commonName: 'He Is Real dev worker authority',
      publicKey,
      notBefore: new Date('2026-11-01T00:00:00Z'),
      notAfter: new Date('2031-11-01T00:00:00Z'),
    },
    keySigner(privateKey),
  );
  return { ca: new X509Certificate(pem), signer: keySigner(privateKey) };
}

// What Google's federation needs of the chain (docs: "Workload identity federation with X.509
// certificates"): a CA with basicConstraints CA:TRUE and keyCertSign, a leaf that isn't a CA
// with digitalSignature, P-256 keys, the machine's name in the subject CN.
describe('certificates our authority writes', () => {
  it('makes a self-signed authority certificate Google can use as a trust anchor', async () => {
    const { ca } = await authority();
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe(
      'O=He Is Real Today\nCN=He Is Real dev worker authority',
    );
    expect(ca.issuer).toBe(ca.subject);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(ca.validToDate.toISOString()).toBe('2031-11-01T00:00:00.000Z');
    expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });

  it('issues a client certificate naming the machine, valid for the lifetime', async () => {
    const { ca, signer } = await authority();
    const worker = p256();
    const { certificate, notAfter } = await issueWorkerCertificate(
      {
        machine: 'joel-pc',
        publicKey: worker.publicKey,
        ca,
        lifetimeHours: 24,
        now,
      },
      signer,
    );
    const cert = new X509Certificate(certificate);
    expect(cert.ca).toBe(false);
    expect(cert.subject).toBe('O=He Is Real Today\nCN=joel-pc');
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']); // clientAuth
    expect(cert.validToDate).toEqual(notAfter);
    expect(notAfter.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    // Backdated a little for a worker whose clock is behind.
    expect(cert.validFromDate.toISOString()).toBe('2026-11-08T11:55:00.000Z');
    expect(cert.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      worker.publicKey.export({ type: 'spki', format: 'der' }),
    );
    expect(
      checkWorkerCertificate(certificate, ca, new Set(['joel-pc']), now)
        .machine,
    ).toBe('joel-pc');
  });

  it('refuses a signer that returns a wrong signature (KMS is checked, not trusted)', async () => {
    const { ca } = await authority();
    const other = p256();
    await expect(
      issueWorkerCertificate(
        {
          machine: 'joel-pc',
          publicKey: p256().publicKey,
          ca,
          lifetimeHours: 24,
          now,
        },
        keySigner(other.privateKey),
      ),
    ).rejects.toThrow(/does not verify/);
  });

  it('refuses names that are not machine names, and keys that are not P-256', async () => {
    const { ca, signer } = await authority();
    await expect(
      issueWorkerCertificate(
        {
          machine: 'Joel PC',
          publicKey: p256().publicKey,
          ca,
          lifetimeHours: 24,
          now,
        },
        signer,
      ),
    ).rejects.toThrow(/name_not_allowed/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      issueWorkerCertificate(
        {
          machine: 'joel-pc',
          publicKey: rsa.publicKey,
          ca,
          lifetimeHours: 24,
          now,
        },
        signer,
      ),
    ).rejects.toThrow(/bad_key/);
  });
});

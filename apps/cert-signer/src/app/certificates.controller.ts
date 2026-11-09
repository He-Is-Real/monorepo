import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import {
  CertificateRefused,
  checkRenewal,
  isNewest,
  issueWorkerCertificate,
  newestOf,
  type NewestRecord,
  type NewestRecords,
  type RenewalRequest,
  replayFor,
  type Signer,
} from '@heisreal/worker-identity';
import { X509Certificate } from 'node:crypto';
import { NEWEST, SIGNER, SIGNER_CONFIG, type SignerConfig } from './config';
import { log } from './log';

/** A PEM certificate or public key, or a base64url signature: a few hundred bytes each. */
const MAX_FIELD = 8192;

function parse(body: unknown): RenewalRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const fields = body as Record<string, unknown>;
  // Exactly these three (the contract's additionalProperties: false): no name can be asked for.
  if (Object.keys(fields).sort().join() !== 'certificate,proof,publicKey')
    return null;
  const { certificate, publicKey, proof } = fields;
  const ok = [certificate, publicKey, proof].every(
    (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD,
  );
  return ok
    ? {
        certificate: certificate as string,
        publicKey: publicKey as string,
        proof: proof as string,
      }
    : null;
}

const problem = (status: HttpStatus, code: string, title: string) =>
  new HttpException({ type: 'about:blank', title, status, code }, status);

/**
 * The signing service's one route (W1-A; Joel, 2026-11-08: "give me a certificate for this new
 * key"). Cloud Run lets only the media-worker Google account call it. The caller proves it holds
 * a current certificate from our authority by signing the request with that certificate's key;
 * the new certificate names the same machine, never one the caller didn't prove. Only the newest
 * certificate issued for the machine may renew (W2-1 A, Joel 2026-11-09; newest.ts), so a copied
 * certificate and key can't keep renewing alongside the real worker. A retry after a lost reply
 * (the certificate that newest one replaced, asking for the same key) gets the very same
 * certificate back, nothing new signed (W3-1 A, Joel 2026-11-09; replayFor).
 */
@Controller('v1/certificates')
export class CertificatesController {
  constructor(
    @Inject(SIGNER_CONFIG) private readonly config: SignerConfig,
    @Inject(SIGNER) private readonly signer: Signer,
    @Inject(NEWEST) private readonly newest: NewestRecords,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async renew(
    @Body() body: unknown,
  ): Promise<{ certificate: string; notAfter: string }> {
    const request = parse(body);
    if (!request) {
      log('WARNING', {
        step: 'certificate_refused',
        reason: 'validation_failed',
      });
      throw problem(HttpStatus.BAD_REQUEST, 'validation_failed', 'Bad request');
    }
    const now = new Date();
    let machine: string;
    let current: X509Certificate;
    let publicKey;
    try {
      ({ machine, current, publicKey } = checkRenewal(
        request,
        this.config.ca,
        this.config.allowed,
        now,
      ));
    } catch (err) {
      if (!(err instanceof CertificateRefused)) throw err;
      // The reason is for us (the logs); the caller only learns "refused".
      log('WARNING', { step: 'certificate_refused', reason: err.reason });
      throw problem(HttpStatus.FORBIDDEN, 'certificate_refused', 'Forbidden');
    }
    const unavailable = (reason: string, err: unknown) => {
      log('ERROR', {
        step: 'certificate_sign_failed',
        reason,
        machine,
        error: err instanceof Error ? err.message : 'error',
      });
      return problem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'signing_unavailable',
        'Service Unavailable',
      );
    };
    // Someone else's copy renewed first, or the machine was never enrolled with a record.
    const notNewest = () => {
      log('WARNING', {
        step: 'certificate_refused',
        reason: 'not_newest',
        machine,
        message: `not the newest certificate for ${machine}: possible copy; cancel and enrol a new name`,
      });
      return problem(HttpStatus.FORBIDDEN, 'certificate_refused', 'Forbidden');
    };
    const readRecord = async () => {
      try {
        return await this.newest.read(machine);
      } catch (err) {
        throw unavailable('record_unavailable', err);
      }
    };
    // A retry of the renewal that made the newest certificate: that certificate, unchanged.
    const replay = (latest: NewestRecord | null) => {
      const found = replayFor(latest, current, publicKey);
      if (!found) throw notNewest();
      log('INFO', {
        step: 'certificate_replayed',
        machine,
        notAfter: found.notAfter.toISOString(),
      });
      return {
        certificate: found.certificate,
        notAfter: found.notAfter.toISOString(),
      };
    };
    const record = await readRecord();
    if (!record || !isNewest(current, record)) return replay(record);
    let issued: { certificate: string; notAfter: Date };
    try {
      issued = await issueWorkerCertificate(
        {
          machine,
          publicKey,
          ca: this.config.ca,
          lifetimeHours: this.config.lifetimeHours,
          now,
        },
        this.signer,
      );
    } catch (err) {
      throw unavailable('signing_failed', err);
    }
    const { certificate, notAfter } = issued;
    // Only if nobody renewed since we read the record: of two renewals of the same certificate,
    // one wins and the other's certificate is never handed out.
    let won: boolean;
    try {
      won = await this.newest.write(
        machine,
        newestOf(new X509Certificate(certificate), current),
        record.generation,
      );
    } catch (err) {
      throw unavailable('record_unavailable', err);
    }
    // Lost the race: if the winner was this same renewal asked twice (a retry while the first
    // was still running), the caller gets the winner's certificate; anyone else is refused.
    if (!won) return replay(await readRecord());
    log('INFO', {
      step: 'certificate_issued',
      machine,
      notAfter: notAfter.toISOString(),
    });
    return { certificate, notAfter: notAfter.toISOString() };
  }
}

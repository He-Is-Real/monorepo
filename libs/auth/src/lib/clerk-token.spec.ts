import { createHmac, generateKeyPairSync } from 'node:crypto';
import { newTestClerk, signRs256, TEST_AUTHORIZED_PARTY } from '../testing';
import { parseClerkConfig } from './clerk-config';
import { ClerkTokenError, verifyClerkToken } from './clerk-token';

const clerk = newTestClerk();
const config = parseClerkConfig({
  issuer: clerk.issuer,
  publicKeyPem: clerk.publicKeyPem,
  authorizedParties: `${TEST_AUTHORIZED_PARTY},https://web-abc-nw.a.run.app`,
});
const now = () => Math.floor(Date.now() / 1000);

function refused(token: string, at?: number) {
  try {
    verifyClerkToken(token, config, at);
  } catch (err) {
    if (err instanceof ClerkTokenError) return err.reason;
    throw err;
  }
  throw new Error('the token was accepted');
}

const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString('base64url');

describe('verifyClerkToken', () => {
  it('accepts a valid session token and returns the user id, role and the token itself', () => {
    const token = clerk.token('user_ann', { role: 'Moderator' });
    expect(verifyClerkToken(token, config)).toEqual({
      clerkUserId: 'user_ann',
      role: 'Moderator',
      token,
    });
  });

  it('accepts every allowed origin in azp', () => {
    const token = clerk.token('user_ann', {
      azp: 'https://web-abc-nw.a.run.app',
    });
    expect(verifyClerkToken(token, config).clerkUserId).toBe('user_ann');
  });

  describe('time claims (5 s clock skew)', () => {
    it('refuses an expired token', () => {
      expect(refused(clerk.token('user_ann', { exp: now() - 6 }))).toBe(
        'expired',
      );
    });

    it('allows a token that expired within the clock skew, and no more', () => {
      const exp = now();
      const token = clerk.token('user_ann', { exp });
      expect(verifyClerkToken(token, config, exp + 4).clerkUserId).toBe(
        'user_ann',
      );
      expect(refused(token, exp + 5)).toBe('expired');
    });

    it('refuses a token that is not valid yet (nbf), beyond the skew', () => {
      expect(refused(clerk.token('user_ann', { nbf: now() + 30 }))).toBe(
        'not_yet_valid',
      );
    });

    it('refuses a token issued in the future', () => {
      expect(refused(clerk.token('user_ann', { iat: now() + 30 }))).toBe(
        'issued_in_future',
      );
    });

    it('requires exp and nbf', () => {
      expect(refused(clerk.token('user_ann', { exp: undefined }))).toBe(
        'malformed',
      );
      expect(refused(clerk.token('user_ann', { nbf: undefined }))).toBe(
        'malformed',
      );
      expect(refused(clerk.token('user_ann', { exp: '9999999999' }))).toBe(
        'malformed',
      );
    });
  });

  it('refuses another instance (wrong iss)', () => {
    expect(
      refused(
        clerk.token('user_ann', { iss: 'https://other.clerk.accounts.dev' }),
      ),
    ).toBe('issuer');
    expect(refused(clerk.token('user_ann', { iss: undefined }))).toBe('issuer');
  });

  it('refuses a token minted for another origin (wrong or missing azp)', () => {
    expect(
      refused(clerk.token('user_ann', { azp: 'https://evil.example' })),
    ).toBe('authorized_party');
    expect(
      refused(clerk.token('user_ann', { azp: 'http://localhost:3001' })),
    ).toBe('authorized_party');
    expect(refused(clerk.token('user_ann', { azp: undefined }))).toBe(
      'authorized_party',
    );
  });

  describe('signature', () => {
    it('refuses a token signed by another key', () => {
      const other = newTestClerk();
      expect(refused(other.token('user_ann'))).toBe('signature');
    });

    it('refuses a tampered payload', () => {
      const [h, payload, s] = clerk.token('user_ann').split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const forged = b64({ ...claims, role: 'SuperAdmin' });
      expect(refused(`${h}.${forged}.${s}`)).toBe('signature');
    });

    it('refuses alg none and HS256 signed with the public key (algorithm confusion)', () => {
      const claims = JSON.parse(
        Buffer.from(
          clerk.token('user_ann').split('.')[1],
          'base64url',
        ).toString(),
      );
      expect(refused(`${b64({ alg: 'none' })}.${b64(claims)}.x`)).toBe(
        'algorithm',
      );
      const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
      const mac = createHmac('sha256', clerk.publicKeyPem)
        .update(input)
        .digest('base64url');
      expect(refused(`${input}.${mac}`)).toBe('algorithm');
    });

    it('refuses embedded keys in the header (jwk, jku)', () => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const claims = { sub: 'user_ann', role: 'User' };
      const token = signRs256(claims, privateKey, {
        alg: 'RS256',
        jwk: publicKey.export({ format: 'jwk' }),
      });
      expect(refused(token)).toBe('malformed');
    });
  });

  describe('role claim (D1)', () => {
    it('refuses a token without the role claim', () => {
      expect(refused(clerk.token('user_ann', { role: undefined }))).toBe(
        'role',
      );
    });

    it('refuses an unknown or non-string role', () => {
      expect(refused(clerk.token('user_ann', { role: 'admin' }))).toBe('role');
      expect(refused(clerk.token('user_ann', { role: null }))).toBe('role');
      expect(refused(clerk.token('user_ann', { role: ['Admin'] }))).toBe(
        'role',
      );
    });
  });

  it('refuses a pending session (sts) and a subject that is not a Clerk user id', () => {
    expect(refused(clerk.token('user_ann', { sts: 'pending' }))).toBe(
      'session_status',
    );
    expect(refused(clerk.token('org_x'))).toBe('subject');
    expect(refused(clerk.token('user_ann', { sub: 42 }))).toBe('subject');
  });

  it('refuses malformed input before checking anything else', () => {
    for (const bad of [
      '',
      'abc',
      'a.b',
      'a.b.c.d',
      'a!.b.c',
      'x'.repeat(9000),
    ]) {
      expect(refused(bad)).toBe('malformed');
    }
    expect(refused(`${b64([1])}.${b64({})}.sig`)).toBe('malformed');
  });
});

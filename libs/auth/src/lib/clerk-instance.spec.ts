import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClerkConfig } from './clerk-config';
import { ClerkTokenError, verifyClerkToken } from './clerk-token';

/**
 * The pieces that must agree with each other, checked together: the sign-in methods Joel chose
 * (D2) in the Clerk instance config (infra/clerk/dev.json), and a real token from the dev
 * instance against the pinned key.
 */
const root = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const instance = JSON.parse(read('infra/clerk/dev.json'));

/** The PEM pinned for SurrealDB in the cluster root (the same key the APIs pin). */
const pinnedPem = (() => {
  const tfvars = read('infra/terraform/live/dev/cluster/clerk.auto.tfvars');
  const body = /<<-EOT\n([\s\S]*?)\nEOT/.exec(tfvars)?.[1];
  if (!body) throw new Error('no heredoc PEM in clerk.auto.tfvars');
  return body
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
})();

describe('the Clerk dev instance config (infra/clerk/dev.json)', () => {
  it('matches D2: Google + email code, optional 8+ character passwords with HIBP, no MFA', () => {
    expect(instance.connection_oauth_google.enabled).toBe(true);
    expect(instance.auth_email.sign_in_strategies).toEqual(['email_code']);
    expect(instance.auth_password).toMatchObject({
      enabled: true,
      required: false,
      min_length: 8,
      disable_hibp: false,
    });
    expect(instance.auth_multi_factor.required_for_sign_in).toBe(false);
    expect(instance.auth_attack_protection).toMatchObject({
      bot_protection: { captcha_enabled: true },
      user_lockout: { enabled: true },
    });
  });
});

describe('a real dev-instance session token (fixtures/dev-instance-token.jwt)', () => {
  // Minted through the Backend API for a throwaway user (since deleted) with
  // publicMetadata.role = Moderator. Expired; a Backend API token has no Origin, so no azp.
  const token = readFileSync(
    join(__dirname, 'fixtures/dev-instance-token.jwt'),
    'utf8',
  ).trim();
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  );
  const env = read('apps/api-user/.env.example');
  const config = parseClerkConfig({
    issuer: /^CLERK_ISSUER=(.*)$/m.exec(env)?.[1] ?? '',
    publicKeyPem: pinnedPem,
    authorizedParties: 'http://localhost:3000',
  });

  it('passes the signature (pinned PEM), time and issuer checks, and is refused only for its missing azp', () => {
    let reason: string | undefined;
    try {
      verifyClerkToken(token, config, payload.iat + 1);
    } catch (err) {
      reason = (err as ClerkTokenError).reason;
    }
    expect(reason).toBe('authorized_party');
  });

  it('is refused for its signature once tampered with', () => {
    const [h, , s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...payload, role: 'SuperAdmin' }),
    ).toString('base64url');
    expect(() =>
      verifyClerkToken(`${h}.${forged}.${s}`, config, payload.iat + 1),
    ).toThrow('signature');
  });

  it('the services’ .env.example pins the same key as SurrealDB', () => {
    for (const app of ['api-user', 'api-admin']) {
      const pem = /^CLERK_JWT_PUBLIC_KEY="(.*)"$/m.exec(
        read(`apps/${app}/.env.example`),
      )?.[1];
      expect(pem?.replace(/\\n/g, '\n')).toBe(pinnedPem);
    }
  });
});

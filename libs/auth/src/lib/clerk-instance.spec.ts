import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClerkConfig } from './clerk-config';
import { ClerkTokenError, verifyClerkToken } from './clerk-token';
import { DEFAULT_ROLE, ROLE_CLAIM, ROLES } from '@heisreal/roles';

/**
 * The pieces that must agree with each other, checked together: the role set and the
 * contract, the Clerk instance config (infra/clerk/dev.json) and the claims the code and
 * SurrealDB expect, and a real token from the dev instance against the pinned key.
 */
const root = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const instance = JSON.parse(read('infra/clerk/dev.json'));
const claims = instance.session.claims as Record<string, string>;

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

describe('roles and the contract', () => {
  it('ROLES equals the Role enum in components.yaml, in order', () => {
    const yaml = read('libs/contracts/openapi/components.yaml');
    const enumLine = /\n {4}Role:\n(?: {6}.*\n)*? {6}enum: \[([^\]]+)\]/.exec(
      yaml,
    )?.[1];
    expect(enumLine?.split(',').map((r) => r.trim())).toEqual([...ROLES]);
  });
});

describe('the Clerk dev instance config (infra/clerk/dev.json)', () => {
  it('puts the role in the session token, defaulting to User', () => {
    expect(claims[ROLE_CLAIM]).toBe(
      `{{user.public_metadata.role || '${DEFAULT_ROLE}'}}`,
    );
  });

  it('routes the token to SurrealDB’s person access (ns/db as the services use, ac = clerk)', () => {
    const env = read('apps/api-user/.env.example');
    expect(claims['ns']).toBe(/^SURREAL_NAMESPACE=(.*)$/m.exec(env)?.[1]);
    expect(claims['db']).toBe(/^SURREAL_DATABASE=(.*)$/m.exec(env)?.[1]);
    expect(claims['ac']).toBe('clerk');
    expect(read('libs/database/schema/access-clerk.surql')).toContain(
      'DEFINE ACCESS OVERWRITE clerk ON DATABASE',
    );
  });

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

  it('carries the custom claims from dev.json', () => {
    expect(payload).toMatchObject({
      ns: 'heisreal',
      db: 'main',
      ac: 'clerk',
      role: 'Moderator',
      v: 2,
    });
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

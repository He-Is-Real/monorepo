import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { listRolePolicies } from './lib/auth.module';

/**
 * A stand-in Clerk instance for tests: an RS256 key pair made per run (never Clerk's), and
 * tokens shaped like the dev instance's session tokens (Clerk's v2 default claims plus the
 * custom `ns`/`db`/`ac`/`role` claims from infra/clerk/dev.json).
 */
export interface TestClerk {
  issuer: string;
  authorizedParty: string;
  publicKeyPem: string;
  privateKey: KeyObject;
  /** Signs a session token for `sub`; `claims` override or add (`undefined` removes one). */
  token(sub: string, claims?: Record<string, unknown>): string;
}

export const TEST_ISSUER = 'https://test-instance.clerk.accounts.dev';
export const TEST_AUTHORIZED_PARTY = 'http://localhost:3000';

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export function signRs256(
  claims: Record<string, unknown>,
  key: KeyObject,
  header: Record<string, unknown> = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'ins_test',
  },
): string {
  const input = `${b64url(header)}.${b64url(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

export function newTestClerk(
  keys?: { publicKeyPem: string; privateKey: KeyObject },
  defaults: { namespace?: string; database?: string } = {},
): TestClerk {
  const pair =
    keys ??
    (() => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      return {
        publicKeyPem: publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
        privateKey,
      };
    })();
  return {
    issuer: TEST_ISSUER,
    authorizedParty: TEST_AUTHORIZED_PARTY,
    ...pair,
    token(sub, claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      const all: Record<string, unknown> = {
        azp: TEST_AUTHORIZED_PARTY,
        exp: now + 60,
        fva: [0, -1],
        iat: now,
        iss: TEST_ISSUER,
        jti: 'test',
        nbf: now - 5,
        sid: 'sess_test',
        sts: 'active',
        sub,
        v: 2,
        ns: defaults.namespace ?? 'heisreal',
        db: defaults.database ?? 'main',
        ac: 'clerk',
        role: 'User',
        ...claims,
      };
      for (const [k, v] of Object.entries(all))
        if (v === undefined) delete all[k];
      return signRs256(all, pair.privateKey);
    },
  };
}

/**
 * Sets the CLERK_* settings `ClerkAuthModule` reads at startup to a stand-in instance, so an
 * app's real AppModule compiles in its unit tests. Returns the instance to sign tokens with.
 */
export function useTestClerkEnv(clerk: TestClerk = newTestClerk()): TestClerk {
  process.env['CLERK_ISSUER'] = clerk.issuer;
  process.env['CLERK_JWT_PUBLIC_KEY'] = clerk.publicKeyPem;
  process.env['CLERK_AUTHORIZED_PARTIES'] = clerk.authorizedParty;
  return clerk;
}

/**
 * The role-listing check (D1), like `listAppRoutePolicies` for consent: compiles a service's
 * real AppModule (SurrealDB and Secret Manager stubbed out, a stand-in Clerk instance) and
 * lists every route with its role policy.
 */
export async function listAppRolePolicies(
  appModule: Type,
  requireDeclared: boolean,
): Promise<{ routes: string[]; problems: string[] }> {
  useTestClerkEnv();
  const moduleRef = await Test.createTestingModule({ imports: [appModule] })
    .overrideProvider(SURREAL)
    .useValue({ query: async () => [true], close: async () => true })
    .overrideProvider(SECRET_MANAGER_CLIENT)
    .useValue({})
    .overrideProvider(SECRETS_PROJECT)
    .useValue('test-project')
    .compile();
  try {
    const all = listRolePolicies(
      moduleRef.get(DiscoveryService),
      requireDeclared,
    );
    return {
      routes: all.map((p) => p.line),
      problems: all.filter((p) => p.problem).map((p) => p.line),
    };
  } finally {
    await moduleRef.close();
  }
}

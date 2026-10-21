import { generateKeyPairSync } from 'node:crypto';
import { newTestClerk } from '../testing';
import {
  ClerkConfigError,
  clerkConfigFromEnv,
  parseClerkConfig,
} from './clerk-config';

const clerk = newTestClerk();
const good = {
  issuer: 'https://superb-mink-8967.clerk.accounts.dev',
  publicKeyPem: clerk.publicKeyPem,
  authorizedParties: 'http://localhost:3000, https://web-abc-nw.a.run.app',
};

describe('parseClerkConfig', () => {
  it('parses the settings, with a 5 s default clock skew', () => {
    const config = parseClerkConfig(good);
    expect(config.issuer).toBe(good.issuer);
    expect([...config.authorizedParties]).toEqual([
      'http://localhost:3000',
      'https://web-abc-nw.a.run.app',
    ]);
    expect(config.clockSkewSeconds).toBe(5);
    expect(config.publicKey.asymmetricKeyType).toBe('rsa');
  });

  it('accepts a one-line PEM with \\n escapes (env files)', () => {
    const oneLine = clerk.publicKeyPem.trim().replace(/\n/g, '\\n');
    expect(
      parseClerkConfig({ ...good, publicKeyPem: oneLine }).publicKey,
    ).toBeDefined();
  });

  it.each([
    [
      'an http issuer',
      { issuer: 'http://superb-mink-8967.clerk.accounts.dev' },
    ],
    [
      'an issuer with a path',
      { issuer: 'https://superb-mink-8967.clerk.accounts.dev/x' },
    ],
    [
      'a private key',
      {
        publicKeyPem:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      },
    ],
    ['garbage for the key', { publicKeyPem: 'not a key' }],
    [
      'a non-RSA key',
      {
        publicKeyPem: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .publicKey.export({ type: 'spki', format: 'pem' })
          .toString(),
      },
    ],
    ['no authorized parties', { authorizedParties: ' , ' }],
    [
      'a URL with a path as a party',
      { authorizedParties: 'https://web.example/app' },
    ],
    [
      'plain http for a non-local party',
      { authorizedParties: 'http://web.example' },
    ],
    ['a wildcard party', { authorizedParties: '*' }],
  ])('refuses %s', (_name, override) => {
    expect(() => parseClerkConfig({ ...good, ...override })).toThrow(
      ClerkConfigError,
    );
  });
});

describe('clerkConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('fails at startup when a setting is missing', () => {
    delete process.env['CLERK_ISSUER'];
    expect(() => clerkConfigFromEnv()).toThrow(
      'Missing required environment variable CLERK_ISSUER',
    );
  });

  it('reads all three settings', () => {
    process.env['CLERK_ISSUER'] = good.issuer;
    process.env['CLERK_JWT_PUBLIC_KEY'] = good.publicKeyPem;
    process.env['CLERK_AUTHORIZED_PARTIES'] = good.authorizedParties;
    expect(clerkConfigFromEnv().issuer).toBe(good.issuer);
  });
});

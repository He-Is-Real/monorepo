import { apiPublicReadUrl, clerkPublishableKey } from './config';

describe('apiPublicReadUrl', () => {
  const saved = process.env['API_PUBLIC_READ_URL'];
  afterEach(() => {
    if (saved === undefined) delete process.env['API_PUBLIC_READ_URL'];
    else process.env['API_PUBLIC_READ_URL'] = saved;
  });

  it('returns the base URL without a trailing slash', () => {
    process.env['API_PUBLIC_READ_URL'] =
      'https://api-public-read-abc.a.run.app/';
    expect(apiPublicReadUrl()).toBe('https://api-public-read-abc.a.run.app');
  });

  it('fails clearly when it is not set', () => {
    delete process.env['API_PUBLIC_READ_URL'];
    expect(() => apiPublicReadUrl()).toThrow('API_PUBLIC_READ_URL is not set');
  });
});

describe('clerkPublishableKey', () => {
  const saved = process.env['CLERK_PUBLISHABLE_KEY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CLERK_PUBLISHABLE_KEY'];
    else process.env['CLERK_PUBLISHABLE_KEY'] = saved;
  });

  it('returns the publishable key', () => {
    process.env['CLERK_PUBLISHABLE_KEY'] = 'pk_test_abc123';
    expect(clerkPublishableKey()).toBe('pk_test_abc123');
  });

  it('is undefined when not set (no sign-in control)', () => {
    delete process.env['CLERK_PUBLISHABLE_KEY'];
    expect(clerkPublishableKey()).toBeUndefined();
  });

  it('refuses anything that is not a publishable key, such as a secret key', () => {
    process.env['CLERK_PUBLISHABLE_KEY'] = 'sk_test_abc123';
    expect(() => clerkPublishableKey()).toThrow('not a Clerk publishable key');
  });
});

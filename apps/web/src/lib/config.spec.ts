import {
  apiPublicReadUrl,
  clerkPublishableKey,
  indexingAllowed,
  siteUrl,
} from './config';

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

describe('siteUrl', () => {
  const saved = process.env['SITE_URL'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
  });

  it('returns the public origin without a trailing slash', () => {
    process.env['SITE_URL'] = 'https://web-abc-nw.a.run.app/';
    expect(siteUrl()).toBe('https://web-abc-nw.a.run.app');
  });

  it('is undefined when not set or blank', () => {
    delete process.env['SITE_URL'];
    expect(siteUrl()).toBeUndefined();
    process.env['SITE_URL'] = '  ';
    expect(siteUrl()).toBeUndefined();
  });

  it.each(['ftp://example.com', 'https://example.com/path', 'example.com'])(
    'refuses %s (an http(s) origin only)',
    (value) => {
      process.env['SITE_URL'] = value;
      expect(() => siteUrl()).toThrow('SITE_URL');
    },
  );
});

describe('indexingAllowed', () => {
  const saved = {
    noindex: process.env['ROBOTS_NOINDEX'],
    site: process.env['SITE_URL'],
  };
  afterEach(() => {
    for (const [name, value] of [
      ['ROBOTS_NOINDEX', saved.noindex],
      ['SITE_URL', saved.site],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('is off while ROBOTS_NOINDEX is on (dev), even with a site URL', () => {
    process.env['ROBOTS_NOINDEX'] = 'true';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(indexingAllowed()).toBe(false);
  });

  it('is off without a site URL: no absolute URLs to offer', () => {
    delete process.env['ROBOTS_NOINDEX'];
    delete process.env['SITE_URL'];
    expect(indexingAllowed()).toBe(false);
  });

  it('is on with ROBOTS_NOINDEX off and a site URL (Go live)', () => {
    process.env['ROBOTS_NOINDEX'] = 'false';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(indexingAllowed()).toBe(true);
  });
});

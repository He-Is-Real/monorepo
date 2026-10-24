import {
  e2eSignedInName,
  clerkPublishableKey,
  indexingAllowed,
  robotsNoindex,
  siteUrl,
} from './config';

describe('clerkPublishableKey', () => {
  const saved = process.env['CLERK_PUBLISHABLE_KEY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CLERK_PUBLISHABLE_KEY'];
    else process.env['CLERK_PUBLISHABLE_KEY'] = saved;
  });

  it('refuses anything that is not a publishable key, such as a secret key', () => {
    process.env['CLERK_PUBLISHABLE_KEY'] = 'sk_test_abc123';
    expect(() => clerkPublishableKey()).toThrow('not a Clerk publishable key');
  });
});

const withEnv = (names: string[]) => {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

describe('siteUrl', () => {
  withEnv(['SITE_URL']);

  it.each([
    'ftp://example.com',
    'https://example.com/path',
    'example.com',
    'https://999.999.999.999',
    'https://1.2.3',
    'https://example.123',
    'https://-bad-.example.com',
    'https://exa_mple.com',
  ])(
    'treats %s as unset (logged), so a bad value can’t take the site down',
    (value) => {
      const error = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      process.env['SITE_URL'] = value;
      expect(siteUrl()).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('SITE_URL is not an http(s) origin'),
      );
      error.mockRestore();
    },
  );
});

describe('indexing (explicit opt-in: INDEXING=allow)', () => {
  withEnv(['INDEXING', 'SITE_URL', 'ROBOTS_NOINDEX']);
  const live = () => {
    process.env['INDEXING'] = 'allow';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
  };

  it('is allowed only with INDEXING=allow exactly and a site URL', () => {
    live();
    expect(indexingAllowed()).toBe(true);
    expect(robotsNoindex()).toBe(false);
  });

  it.each([undefined, '', 'Allow', 'allow ', 'true', 'yes', 'alow', 'deny'])(
    'is noindex with INDEXING=%p (omitted or misspelled fails closed)',
    (value) => {
      live();
      if (value === undefined) delete process.env['INDEXING'];
      else process.env['INDEXING'] = value;
      expect(indexingAllowed()).toBe(false);
      expect(robotsNoindex()).toBe(true);
    },
  );

  it('is noindex without a site URL, even with INDEXING=allow', () => {
    live();
    delete process.env['SITE_URL'];
    expect(indexingAllowed()).toBe(false);
    expect(robotsNoindex()).toBe(true);
  });

  it('ignores the old ROBOTS_NOINDEX switch (kept on Cloud Run only for older images)', () => {
    delete process.env['INDEXING'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    process.env['ROBOTS_NOINDEX'] = 'false';
    expect(robotsNoindex()).toBe(true);
  });
});

describe('e2eSignedInName (the e2e signed-in fixture)', () => {
  afterEach(() => {
    delete process.env['E2E_FIXTURES'];
    delete process.env['E2E_SIGNED_IN_NAME'];
  });

  it('is ignored unless E2E_FIXTURES=true, so a deployed site always uses Clerk', () => {
    process.env['E2E_SIGNED_IN_NAME'] = 'Ann Example';
    expect(e2eSignedInName()).toBeUndefined();
    process.env['E2E_FIXTURES'] = '1';
    expect(e2eSignedInName()).toBeUndefined();
    process.env['E2E_FIXTURES'] = 'true';
    expect(e2eSignedInName()).toBe('Ann Example');
  });
});

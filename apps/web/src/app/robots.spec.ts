import robots, { dynamic } from './robots';

describe('robots.txt', () => {
  const saved = {
    INDEXING: process.env['INDEXING'],
    SITE_URL: process.env['SITE_URL'],
  };
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('is built per request, from the deployment’s environment (not at build time)', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('disallows everything and lists no sitemap in dev (INDEXING unset)', () => {
    delete process.env['INDEXING'];
    process.env['SITE_URL'] = 'https://web-abc-nw.a.run.app';
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });

  it('disallows everything without a site URL, even with INDEXING=allow', () => {
    process.env['INDEXING'] = 'allow';
    delete process.env['SITE_URL'];
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });

  it('invites crawlers and lists the sitemap at Go live', () => {
    process.env['INDEXING'] = 'allow';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/', disallow: '/health' },
      sitemap: 'https://www.heisreal.today/sitemap.xml',
    });
  });
});

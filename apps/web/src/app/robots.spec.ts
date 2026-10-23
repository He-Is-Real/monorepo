import robots, { dynamic } from './robots';

describe('robots.txt', () => {
  const saved = {
    ROBOTS_NOINDEX: process.env['ROBOTS_NOINDEX'],
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

  it('disallows everything and lists no sitemap in dev (ROBOTS_NOINDEX)', () => {
    process.env['ROBOTS_NOINDEX'] = 'true';
    process.env['SITE_URL'] = 'https://web-abc-nw.a.run.app';
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });

  it('disallows everything without a site URL, even with ROBOTS_NOINDEX off', () => {
    process.env['ROBOTS_NOINDEX'] = 'false';
    delete process.env['SITE_URL'];
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });

  it('invites crawlers and lists the sitemap at Go live', () => {
    process.env['ROBOTS_NOINDEX'] = 'false';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/', disallow: '/health' },
      sitemap: 'https://www.heisreal.today/sitemap.xml',
    });
  });
});

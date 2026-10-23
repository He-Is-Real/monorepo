import {
  DEFAULT_OG_IMAGE,
  jsonLdScript,
  pageMetadata,
  SITE_NAME,
  siteJsonLd,
} from './seo';

describe('pageMetadata', () => {
  const saved = process.env['SITE_URL'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
  });
  const about = () =>
    pageMetadata({
      title: 'About us',
      description: 'Why He Is Real Today exists.',
      path: '/about',
    });
  const card = {
    ...DEFAULT_OG_IMAGE,
    url: 'https://www.heisreal.today/og-default.png',
  };

  describe('with SITE_URL', () => {
    beforeEach(() => {
      process.env['SITE_URL'] = 'https://www.heisreal.today';
    });

    it('sets the title, description and the page’s own absolute canonical URL', () => {
      const metadata = about();
      expect(metadata.title).toBe('About us');
      expect(metadata.description).toBe('Why He Is Real Today exists.');
      expect(metadata.alternates).toEqual({
        canonical: 'https://www.heisreal.today/about',
      });
    });

    it('keeps the site’s Open Graph defaults (Next replaces the whole object per page)', () => {
      const metadata = about();
      expect(metadata.openGraph).toEqual({
        siteName: SITE_NAME,
        locale: 'en_GB',
        type: 'website',
        title: 'About us',
        description: 'Why He Is Real Today exists.',
        url: 'https://www.heisreal.today/about',
        images: [card],
      });
      expect(metadata.twitter).toEqual({
        card: 'summary_large_image',
        title: 'About us',
        description: 'Why He Is Real Today exists.',
        images: [card],
      });
    });

    it('takes an absolute title (the home page) and uses its text for Open Graph', () => {
      const home = pageMetadata({
        title: { absolute: 'He Is Real Today' },
        description: 'd',
        path: '/',
      });
      expect(home.title).toEqual({ absolute: 'He Is Real Today' });
      expect(home.openGraph?.title).toBe('He Is Real Today');
      expect(home.alternates).toEqual({
        canonical: 'https://www.heisreal.today/',
      });
    });

    it('merges extra Open Graph fields over the defaults (story pages)', () => {
      const story = pageMetadata({
        title: 't',
        description: 'd',
        path: '/stories/s',
        openGraph: { type: 'article', publishedTime: '2026-10-23T00:00:00Z' },
      });
      expect(story.openGraph).toMatchObject({
        siteName: SITE_NAME,
        type: 'article',
        publishedTime: '2026-10-23T00:00:00Z',
        url: 'https://www.heisreal.today/stories/s',
      });
    });

    it('uses the given images instead of the default card, made absolute', () => {
      const m = pageMetadata({
        title: 't',
        description: 'd',
        path: '/',
        images: [{ url: '/x.png', width: 1200, height: 630, alt: 'x' }],
      });
      const image = {
        url: 'https://www.heisreal.today/x.png',
        width: 1200,
        height: 630,
        alt: 'x',
      };
      expect(m.openGraph?.images).toEqual([image]);
      expect(m.twitter?.images).toEqual([image]);
    });
  });

  describe('without SITE_URL', () => {
    beforeEach(() => {
      delete process.env['SITE_URL'];
    });

    it('emits no URLs: no canonical, og:url or images (no localhost or relative fallbacks)', () => {
      const metadata = about();
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.openGraph).toEqual({
        siteName: SITE_NAME,
        locale: 'en_GB',
        type: 'website',
        title: 'About us',
        description: 'Why He Is Real Today exists.',
      });
      expect(metadata.twitter).toEqual({
        card: 'summary',
        title: 'About us',
        description: 'Why He Is Real Today exists.',
      });
      expect(JSON.stringify(metadata)).not.toMatch(/url|http|\.png/i);
    });

    it('drops given images and URL-bearing Open Graph extras too', () => {
      const m = pageMetadata({
        title: 't',
        description: 'd',
        path: '/stories/s',
        images: [{ url: '/x.png', width: 1, height: 1, alt: 'x' }],
        openGraph: { type: 'article', url: '/elsewhere' },
      });
      expect(m.openGraph).toMatchObject({ type: 'article' });
      expect(JSON.stringify(m)).not.toMatch(/url|http|\.png/i);
    });
  });
});

describe('siteJsonLd', () => {
  const data = siteJsonLd('https://www.heisreal.today') as {
    '@context': string;
    '@graph': Record<string, unknown>[];
  };

  it('describes the organisation and the website with absolute URLs', () => {
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@graph']).toEqual([
      expect.objectContaining({
        '@type': 'Organization',
        name: SITE_NAME,
        url: 'https://www.heisreal.today/',
        logo: 'https://www.heisreal.today/logo.png',
      }),
      expect.objectContaining({
        '@type': 'WebSite',
        name: SITE_NAME,
        url: 'https://www.heisreal.today/',
        inLanguage: 'en-GB',
      }),
    ]);
  });
});

describe('jsonLdScript', () => {
  it('can’t close its <script> element early', () => {
    const out = jsonLdScript({ text: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({
      text: '</script><script>alert(1)</script>',
    });
  });
});

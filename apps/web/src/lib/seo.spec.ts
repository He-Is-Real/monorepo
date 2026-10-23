import {
  DEFAULT_OG_IMAGE,
  jsonLdScript,
  pageMetadata,
  SITE_NAME,
  siteJsonLd,
} from './seo';

describe('pageMetadata', () => {
  const metadata = pageMetadata({
    title: 'About us',
    description: 'Why He Is Real Today exists.',
    path: '/about',
  });

  it('sets the title, description and the page’s own canonical URL', () => {
    expect(metadata.title).toBe('About us');
    expect(metadata.description).toBe('Why He Is Real Today exists.');
    expect(metadata.alternates).toEqual({ canonical: '/about' });
  });

  it('keeps the site’s Open Graph defaults (Next replaces the whole object per page)', () => {
    expect(metadata.openGraph).toEqual({
      siteName: SITE_NAME,
      locale: 'en_GB',
      type: 'website',
      title: 'About us',
      description: 'Why He Is Real Today exists.',
      url: '/about',
      images: [DEFAULT_OG_IMAGE],
    });
    expect(metadata.twitter).toEqual({
      card: 'summary_large_image',
      title: 'About us',
      description: 'Why He Is Real Today exists.',
      images: [DEFAULT_OG_IMAGE],
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
      url: '/stories/s',
    });
  });

  it('uses the given images instead of the default card', () => {
    const image = { url: '/x.png', width: 1200, height: 630, alt: 'x' };
    const m = pageMetadata({
      title: 't',
      description: 'd',
      path: '/',
      images: [image],
    });
    expect(m.openGraph?.images).toEqual([image]);
    expect(m.twitter?.images).toEqual([image]);
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

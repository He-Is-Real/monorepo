import { jsonLdScript, pageMetadata, SITE_NAME } from './seo';

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

describe('jsonLdScript', () => {
  it('can’t close its <script> element early', () => {
    const out = jsonLdScript({ text: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({
      text: '</script><script>alert(1)</script>',
    });
  });
});

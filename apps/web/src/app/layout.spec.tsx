import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout, { generateMetadata, viewport } from './layout';

// The header reads its config per request (site-header.spec.tsx); here it's a placeholder.
jest.mock('@/components/site-header', () => ({
  SiteHeader: () => <header>site header</header>,
}));
// So is the footer, which reads D48's setting from api-public-read (site-footer.spec.tsx).
jest.mock('@/components/site-footer', () => ({
  SiteFooter: () => <footer>site footer</footer>,
}));

describe('RootLayout', () => {
  // <html> can't be mounted inside jsdom's document, so render it to markup.
  const html = renderToStaticMarkup(
    <RootLayout>
      <main id="main">content</main>
    </RootLayout>,
  );

  it('declares the language, and leaves the theme class to the pre-paint script', () => {
    expect(html).toMatch(/^<html lang="en-GB" class="[^"]+">/);
    expect(html).not.toMatch(/^<html[^>]*class="[^"]*\bdark\b/);
    expect(html).toMatch(
      /<head><script>\(function\(\)\{[^<]*prefers-color-scheme: dark[^<]*<\/script>/,
    );
  });

  it('starts with a skip link to the main content, then the header', () => {
    expect(html).toMatch(
      /<body[^>]*><a href="#main"[^>]*>Skip to content<\/a><header>site header<\/header><main id="main">content<\/main>/,
    );
  });

  it('ends with the footer, after the main content', () => {
    expect(html).toMatch(
      /<main id="main">content<\/main><footer>site footer<\/footer><\/body>/,
    );
  });

  it('fits notched phones and both colour schemes', () => {
    expect(viewport).toMatchObject({
      viewportFit: 'cover',
      colorScheme: 'light dark',
    });
  });
});

const restoreEnv = (names: string[]) => {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

describe('site JSON-LD', () => {
  afterEach(restoreEnv(['SITE_URL']));
  const render = () =>
    renderToStaticMarkup(
      <RootLayout>
        <main id="main">content</main>
      </RootLayout>,
    );

  it('describes the organisation and website when the site URL is known', () => {
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const scripts = render().match(
      /<script type="application\/ld\+json">([^<]*)<\/script>/g,
    );
    expect(scripts).toHaveLength(1);
    expect(scripts?.[0]).toContain('"@type":"Organization"');
    expect(scripts?.[0]).toContain('"url":"https://www.heisreal.today/"');
  });

  it('is left out without a site URL (no absolute URLs to give)', () => {
    delete process.env['SITE_URL'];
    expect(render()).not.toContain('application/ld+json');
  });
});

describe('generateMetadata', () => {
  afterEach(restoreEnv(['INDEXING', 'SITE_URL']));

  it('resolves URLs against SITE_URL and shares the brand card by absolute URL', () => {
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    expect(metadata.metadataBase).toEqual(
      new URL('https://www.heisreal.today'),
    );
    expect(metadata.openGraph).toMatchObject({
      siteName: 'He Is Real Today',
      locale: 'en_GB',
      type: 'website',
      images: [
        expect.objectContaining({
          url: 'https://www.heisreal.today/og-default.png',
        }),
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: 'summary_large_image',
      images: [
        expect.objectContaining({
          url: 'https://www.heisreal.today/og-default.png',
        }),
      ],
    });
  });

  it('emits no URL at all without SITE_URL (no localhost or relative fallbacks)', () => {
    delete process.env['SITE_URL'];
    const metadata = generateMetadata();
    expect(metadata.metadataBase).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toMatch(/url|og-default|http/i);
    expect(metadata.openGraph).toEqual({
      siteName: 'He Is Real Today',
      locale: 'en_GB',
      type: 'website',
    });
    expect(metadata.twitter).toEqual({ card: 'summary' });
  });

  it('sets no canonical (pages set their own)', () => {
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(generateMetadata().alternates).toBeUndefined();
  });

  it('sets the site title', () => {
    expect(generateMetadata().title).toEqual({
      default: 'He Is Real Today',
      template: '%s | He Is Real Today',
    });
  });

  it('asks search engines not to index or follow unless indexing is allowed (the default)', () => {
    delete process.env['INDEXING'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(generateMetadata().robots).toEqual({ index: false, follow: false });
  });

  it('has no robots tag once INDEXING=allow and a site URL (Go live)', () => {
    process.env['INDEXING'] = 'allow';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(generateMetadata().robots).toBeUndefined();
  });
});

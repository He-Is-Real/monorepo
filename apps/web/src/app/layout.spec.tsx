import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout, { generateMetadata, viewport } from './layout';

// The header reads its config per request (site-header.spec.tsx); here it's a placeholder.
jest.mock('@/components/site-header', () => ({
  SiteHeader: () => <header>site header</header>,
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

  it('fits notched phones and both colour schemes', () => {
    expect(viewport).toMatchObject({
      viewportFit: 'cover',
      colorScheme: 'light dark',
    });
  });
});

describe('generateMetadata', () => {
  const saved = process.env['ROBOTS_NOINDEX'];
  afterEach(() => {
    if (saved === undefined) delete process.env['ROBOTS_NOINDEX'];
    else process.env['ROBOTS_NOINDEX'] = saved;
  });

  it('sets the site title, and lets pages be indexed by default', () => {
    delete process.env['ROBOTS_NOINDEX'];
    const metadata = generateMetadata();
    expect(metadata.title).toEqual({
      default: 'He Is Real Today',
      template: '%s | He Is Real Today',
    });
    expect(metadata.robots).toBeUndefined();
  });

  it('asks search engines not to index or follow when ROBOTS_NOINDEX is on (dev)', () => {
    process.env['ROBOTS_NOINDEX'] = 'true';
    expect(generateMetadata().robots).toEqual({ index: false, follow: false });
  });
});

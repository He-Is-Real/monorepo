import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout, { metadata } from './layout';

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

  it('declares the language and the dark theme', () => {
    expect(html).toMatch(/^<html lang="en-GB" class="dark [^"]+">/);
  });

  it('starts with a skip link to the main content, then the header', () => {
    expect(html).toMatch(
      /<body><a href="#main"[^>]*>Skip to content<\/a><header>site header<\/header><main id="main">content<\/main>/,
    );
  });

  it('sets the site title', () => {
    expect(metadata.title).toEqual({
      default: 'He Is Real Today',
      template: '%s | He Is Real Today',
    });
  });
});

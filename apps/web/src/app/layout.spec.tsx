import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout, { metadata } from './layout';

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

  it('starts with a skip link to the main content', () => {
    expect(html).toMatch(/<body><a href="#main"[^>]*>Skip to content<\/a>/);
    expect(html).toContain('<main id="main">content</main>');
  });

  it('sets the site title', () => {
    expect(metadata.title).toEqual({
      default: 'He Is Real Today',
      template: '%s | He Is Real Today',
    });
  });
});

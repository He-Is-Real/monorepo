import React from 'react';
import { render, screen } from '@testing-library/react';
import ContactPage, { generateMetadata } from './page';

describe('Contact page', () => {
  beforeEach(() => render(<ContactPage />));

  it('has the heading and a warm intro', () => {
    expect(
      screen.getByRole('heading', { level: 1, name: 'Get in touch' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/A real person will read your message/),
    ).toBeTruthy();
  });

  it('collects nothing: no form until there is a backend and a privacy basis', () => {
    expect(document.querySelector('form, input, textarea, select')).toBeNull();
    expect(screen.getByText(/contact form is coming soon/i)).toBeTruthy();
  });

  it('offers email instead', () => {
    expect(
      screen
        .getByRole('link', { name: 'Email info@heisreal.today' })
        .getAttribute('href'),
    ).toBe('mailto:info@heisreal.today');
  });

  it('has its own canonical URL', () => {
    const saved = process.env['SITE_URL'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
    expect(metadata.alternates).toEqual({
      canonical: 'https://www.heisreal.today/contact',
    });
  });
});

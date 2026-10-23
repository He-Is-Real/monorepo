import React from 'react';
import { render, screen } from '@testing-library/react';
import NextStepsPage, { generateMetadata } from './page';

describe('Next Steps page', () => {
  beforeEach(() => render(<NextStepsPage />));

  it('has the heading and three gentle steps', () => {
    expect(
      screen.getByRole('heading', { level: 1, name: 'Next steps' }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      'Try the Alpha Course',
      'Find a church near you',
      'Ask us a question',
    ]);
  });

  it('links out to Alpha and a church finder without sending a referrer', () => {
    for (const [name, href] of [
      [/Find an Alpha course/, 'https://alpha.org/'],
      [/Find a church/, 'https://www.achurchnearyou.com/'],
    ] as const) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('offers a message to a real person', () => {
    expect(
      screen
        .getByRole('link', { name: 'Send us a message' })
        .getAttribute('href'),
    ).toBe('/contact');
  });

  it('has its own canonical URL', () => {
    const saved = process.env['SITE_URL'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
    expect(metadata.alternates).toEqual({
      canonical: 'https://www.heisreal.today/next-steps',
    });
  });
});

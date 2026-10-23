import React from 'react';
import { render, screen } from '@testing-library/react';
import GreatestStoryPage, { generateMetadata } from './page';

describe('Greatest Story page', () => {
  beforeEach(() => render(<GreatestStoryPage />));

  it('has one h1 and the six parts of the story in order', () => {
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'The Greatest Story Ever Told',
    );
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      'God created you to know Him',
      'Something went wrong',
      'God came to find us',
      'He gave everything',
      'Death couldn’t hold Him',
      'The invitation is for you',
      'A simple prayer',
      'What now?',
    ]);
  });

  it('numbers the parts as an ordered list', () => {
    const list = screen.getByRole('list', { name: 'The story in six parts' });
    expect(list.tagName).toBe('OL');
    expect(list.querySelectorAll(':scope > li')).toHaveLength(6);
  });

  it('quotes each verse with its reference', () => {
    const quotes = document.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(6);
    expect(screen.getByText('John 3:16')).toBeTruthy();
    expect(screen.getByText('Romans 10:9')).toBeTruthy();
  });

  it('keeps the illustrations away from screen readers', () => {
    const svgs = document.querySelectorAll('svg');
    expect(svgs.length).toBe(5);
    svgs.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
  });

  it('credits the Bible translation (NIV)', () => {
    expect(screen.getByText(/New International Version/)).toBeTruthy();
  });

  it('offers ways to keep going', () => {
    for (const [name, href] of [
      ['Explore next steps', '/next-steps'],
      ['Read more stories', '/stories'],
      ['Talk to someone', '/contact'],
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(
        href,
      );
    }
  });

  it('has its own canonical URL and a description with a search term', () => {
    const saved = process.env['SITE_URL'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
    expect(metadata.alternates).toEqual({
      canonical: 'https://www.heisreal.today/greatest-story',
    });
    expect(generateMetadata().description).toMatch(/Jesus/);
  });
});

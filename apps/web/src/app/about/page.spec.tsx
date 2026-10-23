import React from 'react';
import { render, screen } from '@testing-library/react';
import AboutPage, { metadata } from './page';

describe('About page', () => {
  beforeEach(() => render(<AboutPage />));

  it('opens with the heart behind He Is Real', () => {
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'The heart behind He Is Real',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText('Hear from our founder, Stephen Linnecar'),
    ).toBeTruthy();
  });

  it('shows a placeholder for the founder’s video, and loads nothing from anyone else', () => {
    expect(screen.getByText(/Founder’s introduction/)).toBeTruthy();
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
    expect(document.querySelector('iframe, video, script[src]')).toBeNull();
  });

  it('tells the mission, with “does God exist?”', () => {
    expect(screen.getByText(/does God exist\?/)).toBeTruthy();
    expect(
      screen.getByText(/locked inside four walls/).closest('blockquote'),
    ).not.toBeNull();
  });

  it('has the three values', () => {
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent),
    ).toEqual(['Open to everyone', 'No pressure', 'Not for profit']);
  });

  it('invites people to share or get in touch', () => {
    expect(
      screen
        .getByRole('link', { name: 'Get ready to share' })
        .getAttribute('href'),
    ).toBe('/get-ready');
    expect(
      screen.getByRole('link', { name: 'Get in touch' }).getAttribute('href'),
    ).toBe('/contact');
  });

  it('has its own canonical URL', () => {
    expect(metadata.alternates).toEqual({ canonical: '/about' });
  });
});

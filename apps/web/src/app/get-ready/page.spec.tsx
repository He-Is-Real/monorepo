import React from 'react';
import { render, screen } from '@testing-library/react';
import GetReadyPage, { metadata } from './page';

describe('Get Ready to Share page', () => {
  beforeEach(() => render(<GetReadyPage />));

  it('has the heading, resources, video and tips', () => {
    expect(
      screen.getByRole('heading', { level: 1, name: 'Get ready to share' }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      'Resources',
      'Watch: how to share your story',
      'Quick tips',
      'Ready?',
    ]);
    for (const name of [
      'Preparation guidelines',
      'Starter topics',
      'Questions to guide you',
      'Be yourself',
      'Find a quiet space',
      'It’s OK to be emotional',
      'Keep it focused',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeTruthy();
    }
  });

  it('marks the downloads and video as coming soon, with no dead links', () => {
    expect(screen.getAllByText('PDF and audio coming soon')).toHaveLength(3);
    for (const a of screen.getAllByRole('link')) {
      expect(a.getAttribute('href')).not.toBe('#');
    }
    expect(document.querySelector('iframe, video')).toBeNull();
  });

  it('says sharing opens soon (no submit page in M1) and points to the FAQs', () => {
    expect(screen.getByText(/Story sharing opens soon/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Share your story/ })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Read the FAQs' }).getAttribute('href'),
    ).toBe('/faqs');
  });

  it('has its own canonical URL', () => {
    expect(metadata.alternates).toEqual({ canonical: '/get-ready' });
  });
});

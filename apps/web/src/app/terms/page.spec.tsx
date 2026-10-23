import React from 'react';
import { render, screen } from '@testing-library/react';
import TermsPage, { metadata } from './page';

describe('Terms (draft)', () => {
  beforeEach(() => render(<TermsPage />));

  it('says plainly that it is a draft for the dev site', () => {
    expect(
      screen.getByRole('heading', { level: 1, name: 'Terms of use' }),
    ).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/Draft — dev only/);
  });

  it('has its own canonical URL', () => {
    expect(metadata.alternates).toEqual({ canonical: '/terms' });
  });
});

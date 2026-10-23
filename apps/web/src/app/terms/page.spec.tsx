import React from 'react';
import { render, screen } from '@testing-library/react';
import TermsPage, { generateMetadata } from './page';

describe('Terms (draft)', () => {
  beforeEach(() => render(<TermsPage />));

  it('says plainly that it is a draft for the dev site', () => {
    expect(
      screen.getByRole('heading', { level: 1, name: 'Terms of use' }),
    ).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/Draft — dev only/);
  });

  it('has its own canonical URL', () => {
    const saved = process.env['SITE_URL'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
    expect(metadata.alternates).toEqual({
      canonical: 'https://www.heisreal.today/terms',
    });
  });
});

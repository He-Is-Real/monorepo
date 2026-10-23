import React from 'react';
import { render, screen, within } from '@testing-library/react';
import PrivacyPage, { generateMetadata } from './page';

describe('Privacy policy (draft)', () => {
  beforeEach(() => render(<PrivacyPage />));

  it('says plainly that it is a draft for the dev site', () => {
    expect(
      screen.getByRole('heading', { level: 1, name: 'Privacy policy' }),
    ).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/Draft — dev only/);
  });

  it('lists every cookie and storage item the site uses, at #cookies', () => {
    const section = document.getElementById('cookies');
    expect(section).not.toBeNull();
    const table = within(section as HTMLElement).getByRole('table');
    const names = within(table)
      .getAllByRole('rowheader')
      .map((c) => c.textContent);
    expect(names).toEqual([
      'theme',
      '__client_uat',
      '__session',
      '__clerk_environment',
      '__cf_bm, _cfuvid',
      '__clerk_db_jwt',
    ]);
  });

  it('explains why there is no cookie banner', () => {
    expect(screen.getByText(/no cookie banner/i)).toBeTruthy();
  });

  it('has its own canonical URL', () => {
    const saved = process.env['SITE_URL'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
    expect(metadata.alternates).toEqual({
      canonical: 'https://www.heisreal.today/privacy',
    });
  });
});

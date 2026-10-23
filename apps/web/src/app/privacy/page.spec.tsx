import React from 'react';
import { render, screen, within } from '@testing-library/react';
import PrivacyPage, { metadata } from './page';

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
    expect(metadata.alternates).toEqual({ canonical: '/privacy' });
  });
});

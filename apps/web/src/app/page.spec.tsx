import React from 'react';
import { render, screen } from '@testing-library/react';
import Page from './page';

describe('Page', () => {
  it('renders the main landmark, the site name and the logo', () => {
    render(<Page />);
    expect(screen.getByRole('main').id).toBe('main');
    expect(
      screen.getByRole('heading', { level: 1, name: 'He Is Real Today' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'He Is Real: Encounters with God' }),
    ).toBeTruthy();
  });
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import Page from './page';

describe('Page', () => {
  it('renders the site name', () => {
    render(<Page />);
    expect(
      screen.getByRole('heading', { name: 'He Is Real Today' }),
    ).toBeTruthy();
  });
});

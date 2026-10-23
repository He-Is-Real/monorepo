import React from 'react';
import { render, screen } from '@testing-library/react';
import { BrowseFilters } from './browse-filters';

jest.mock('next/form', () => ({
  __esModule: true,
  default: (props: React.FormHTMLAttributes<HTMLFormElement>) => (
    <form {...props} />
  ),
}));

describe('BrowseFilters', () => {
  // Codex review of #66, finding 3: after Back, the fields show the URL's filters.
  it('shows the current filters when they change without a remount (Back)', () => {
    const { rerender } = render(
      <BrowseFilters
        filters={{ q: 'hope', tags: [], format: 'audio', sort: 'oldest' }}
      />,
    );
    rerender(
      <BrowseFilters
        filters={{ q: '', tags: ['loss'], format: null, sort: 'latest' }}
      />,
    );
    expect(
      (screen.getByLabelText('Search stories') as HTMLInputElement).value,
    ).toBe('');
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe(
      '',
    );
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe(
      'latest',
    );
    const hidden = document.querySelectorAll('input[type=hidden][name=tag]');
    expect(
      Array.from(hidden).map((i) => (i as HTMLInputElement).value),
    ).toEqual(['loss']);
  });
});

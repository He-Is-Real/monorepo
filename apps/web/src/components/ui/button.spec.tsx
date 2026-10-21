import React from 'react';
import { render, screen } from '@testing-library/react';
import { Button } from './button';

describe('Button (shadcn/ui)', () => {
  it('renders the theme classes', () => {
    render(<Button>Share your story</Button>);
    const button = screen.getByRole('button', { name: 'Share your story' });
    expect(button.className).toContain('bg-primary');
    expect(button.className).toContain('text-primary-foreground');
  });

  it('renders as its child with asChild', () => {
    render(
      <Button asChild variant="link">
        <a href="/stories">Stories</a>
      </Button>,
    );
    expect(
      screen.getByRole('link', { name: 'Stories' }).dataset['variant'],
    ).toBe('link');
  });
});

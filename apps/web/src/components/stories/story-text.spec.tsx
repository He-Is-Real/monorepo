import React from 'react';
import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StoryText } from './story-text';

const long = [
  `First paragraph. ${'Some words here. '.repeat(30)}`.trim(), // ~527 characters
  `Second paragraph. ${'More words follow. '.repeat(20)}`.trim(),
  'The very last sentence.',
];

describe('StoryText', () => {
  it('shows short text whole, without a button', () => {
    render(<StoryText id="t" paragraphs={['A short story.']} />);
    expect(screen.getByText('A short story.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('server-renders the full text, collapsed, with an accessible button', () => {
    const html = renderToString(<StoryText id="t" paragraphs={long} />);
    for (const p of long) {
      // Every word reaches the HTML (React may split a paragraph into text nodes).
      expect(html.replace(/<!-- -->/g, '')).toContain(p.slice(-40));
    }
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="t"');
    expect(html).toContain('Continue reading');
    expect(html).toContain('<noscript>');
  });

  it('expands in place and collapses again, keeping focus on the button', async () => {
    render(<StoryText id="t" paragraphs={long} />);
    const button = screen.getByRole('button', { name: 'Continue reading' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('t');
    expect(button.className).toContain('min-h-11');
    const last = screen.getByText('The very last sentence.');
    expect(last.className).toContain('hidden');
    expect(document.getElementById('t')?.hasAttribute('data-collapsed')).toBe(
      true,
    );

    button.focus();
    await act(async () => fireEvent.click(button));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toBe('Show less');
    expect(last.className).not.toContain('hidden');
    expect(document.activeElement).toBe(button);

    await act(async () => fireEvent.click(button));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Continue reading');
    expect(last.className).toContain('hidden');
    expect(document.activeElement).toBe(button);
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FaqAccordion } from './faq-accordion';

const items = [
  { id: 'kinds', question: 'What kind of stories?', answer: 'Real ones.' },
  { id: 'anon', question: 'Can I stay anonymous?', answer: 'Yes.' },
];

describe('FaqAccordion (WAI-ARIA accordion)', () => {
  it('puts each question in a heading, as a button that controls its answer', () => {
    render(<FaqAccordion items={items} />);
    const heading = screen.getByRole('heading', {
      level: 3,
      name: 'What kind of stories?',
    });
    const button = screen.getByRole('button', {
      name: 'What kind of stories?',
    });
    expect(heading.contains(button)).toBe(true);
    const panel = document.getElementById(
      button.getAttribute('aria-controls') ?? '',
    );
    expect(panel?.getAttribute('role')).toBe('region');
    expect(panel?.getAttribute('aria-labelledby')).toBe(button.id);
  });

  it('starts with every answer collapsed but in the page (search engines, find in page)', () => {
    const html = renderToStaticMarkup(<FaqAccordion items={items} />);
    expect(html).toContain('Real ones.');
    expect(html).toContain('Yes.');
    render(<FaqAccordion items={items} />);
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.getByText('Real ones.').closest('[hidden]')).not.toBeNull();
  });

  it('opens and closes each answer independently', async () => {
    render(<FaqAccordion items={items} />);
    const first = screen.getByRole('button', { name: 'What kind of stories?' });
    const second = screen.getByRole('button', {
      name: 'Can I stay anonymous?',
    });
    await act(async () => fireEvent.click(first));
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Real ones.').closest('[hidden]')).toBeNull();
    await act(async () => fireEvent.click(second));
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    await act(async () => fireEvent.click(first));
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Real ones.').closest('[hidden]')).not.toBeNull();
  });

  it('has 44 px targets', () => {
    render(<FaqAccordion items={items} />);
    expect(screen.getAllByRole('button')[0].className).toContain('min-h-11');
  });
});

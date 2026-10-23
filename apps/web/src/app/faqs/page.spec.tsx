import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { FAQ_GROUPS } from '@/lib/faqs';
import FaqsPage, { generateMetadata } from './page';

describe('FAQs page', () => {
  beforeEach(() => render(<FaqsPage />));

  it('has one h1 and a section per group', () => {
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Frequently asked questions',
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
    ).toEqual(['Sharing your story', 'About He Is Real', 'Bigger questions']);
  });

  it('lists every question as an accordion button', () => {
    const questions = FAQ_GROUPS.flatMap((g) => g.items.map((i) => i.question));
    expect(questions).toContain('What proof is there that God exists?');
    for (const q of questions) {
      expect(screen.getByRole('button', { name: q })).toBeTruthy();
    }
  });

  it('says socials are a separate choice, as the consent model has it (share_socials)', () => {
    const answer = FAQ_GROUPS.flatMap((g) => g.items).find(
      (i) => i.id === 'where-shared',
    )?.answer;
    expect(answer).toMatch(/only if you say yes/i);
    expect(answer).not.toMatch(/by submitting you consent/i);
  });

  it('ends with a way to ask something else', () => {
    expect(
      screen.getByRole('link', { name: 'Get in touch' }).getAttribute('href'),
    ).toBe('/contact');
  });

  it('describes the questions as FAQPage structured data', () => {
    const script = document.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(script?.textContent ?? '{}');
    expect(data['@type']).toBe('FAQPage');
    expect(data.mainEntity).toHaveLength(
      FAQ_GROUPS.reduce((n, g) => n + g.items.length, 0),
    );
    expect(data.mainEntity[0]).toEqual({
      '@type': 'Question',
      name: FAQ_GROUPS[0].items[0].question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: FAQ_GROUPS[0].items[0].answer,
      },
    });
  });

  it('is in the main landmark', () => {
    expect(within(screen.getByRole('main')).getAllByRole('button').length).toBe(
      FAQ_GROUPS.reduce((n, g) => n + g.items.length, 0),
    );
  });
});

describe('FAQs metadata', () => {
  it('has its own canonical URL and a description with a search term', () => {
    const saved = process.env['SITE_URL'];
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    const metadata = generateMetadata();
    if (saved === undefined) delete process.env['SITE_URL'];
    else process.env['SITE_URL'] = saved;
    expect(metadata.alternates).toEqual({
      canonical: 'https://www.heisreal.today/faqs',
    });
    expect(generateMetadata().description).toContain('Is God real?');
  });
});

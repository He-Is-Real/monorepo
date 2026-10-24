import React from 'react';
import { render, screen } from '@testing-library/react';
import type { StorySummary } from '@/lib/browse';
import { formatDuration, readingMinutes, StoryCard } from './story-card';

const base: StorySummary = {
  id: 'seed_w01',
  slug: 'test-written',
  title: 'Test written story',
  excerpt: 'Dummy written story about hope.',
  bylineName: 'Test Person',
  primaryFormat: 'written',
  durationSeconds: null,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 2400,
  tags: [
    { slug: 'hope', name: 'Hope', category: 'emotion', version: 1 },
    { slug: 'faith', name: 'Faith', category: 'journey', version: 1 },
  ],
  publishedAt: '2026-10-21T20:00:00Z',
};
const THUMB = 'https://vz-x.b-cdn.net/1/thumbnail.jpg?token=t&expires=1';

describe('formatDuration and readingMinutes', () => {
  it.each([
    [12, '0:12'],
    [65, '1:05'],
    [3605, '60:05'],
  ])('%p s → %p', (s, text) => expect(formatDuration(s)).toBe(text));

  it('rounds reading time up, at least 1 minute', () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(2400)).toBe(3);
  });
});

describe('StoryCard', () => {
  it('names its one link after the story, to the story page', () => {
    render(<StoryCard story={base} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/stories/test-written');
    expect(link.textContent).toBe('Test written story');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
      'Test written story',
    );
  });

  it('shows a written story without an image as a quote, with its reading time', () => {
    const { container } = render(<StoryCard story={base} />);
    expect(screen.getByText('Written · 3 min read')).toBeTruthy();
    expect(container.querySelector('blockquote')?.textContent).toContain(
      'Dummy written story about hope.',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Hope')).toBeTruthy();
    expect(screen.getByText('Faith')).toBeTruthy();
  });

  it('shows a video’s signed thumbnail at its clamped shape with its length', () => {
    const { container } = render(
      <StoryCard
        story={{
          ...base,
          primaryFormat: 'video',
          durationSeconds: 75,
          thumbnailUrl: THUMB,
          thumbnailWidth: 300,
          thumbnailHeight: 900, // 1:3 → clamped to 9:16
        }}
      />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(THUMB);
    expect(img?.getAttribute('alt')).toBe(''); // the link names the card
    const media = container.querySelector('[data-card-media]') as HTMLElement;
    expect(media.style.aspectRatio).toBe(String(9 / 16));
    expect(screen.getByText('Video · 1:15')).toBeTruthy();
  });

  it('gives a video without a signed thumbnail a placeholder of the same shape', () => {
    const { container } = render(
      <StoryCard
        story={{
          ...base,
          primaryFormat: 'video',
          durationSeconds: 12,
          thumbnailWidth: 1920,
          thumbnailHeight: 1080,
        }}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    const media = container.querySelector('[data-card-media]') as HTMLElement;
    expect(media.style.aspectRatio).toBe(String(1920 / 1080));
  });

  it('gives audio a 2:1 band with the teller’s initial', () => {
    const { container } = render(
      <StoryCard
        story={{ ...base, primaryFormat: 'audio', durationSeconds: 30 }}
      />,
    );
    const media = container.querySelector('[data-card-media]') as HTMLElement;
    expect(media.style.aspectRatio).toBe('2');
    expect(media.textContent).toContain('T');
    expect(screen.getByText('Audio · 0:30')).toBeTruthy();
  });

  it('shows a written story’s image', () => {
    const { container } = render(
      <StoryCard
        story={{
          ...base,
          image: { url: THUMB, width: 1200, height: 800, alt: 'A field' },
        }}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(THUMB);
    expect(container.querySelector('blockquote')).toBeNull();
  });

  it('says Anonymous without a byline and never shows a count', () => {
    const { container } = render(
      <StoryCard story={{ ...base, bylineName: null }} />,
    );
    expect(screen.getByText('Anonymous')).toBeTruthy();
    expect(container.textContent).not.toMatch(/views|likes|helped/i);
  });

  it('crops to a uniform 16:10 box on home', () => {
    const { container } = render(
      <StoryCard
        story={{
          ...base,
          primaryFormat: 'video',
          durationSeconds: 12,
          thumbnailUrl: THUMB,
          thumbnailWidth: 360,
          thumbnailHeight: 640,
        }}
        uniform
      />,
    );
    const media = container.querySelector('[data-card-media]') as HTMLElement;
    expect(media.style.aspectRatio).toBe(String(16 / 10));
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicStory } from '@/lib/public-stories';
import { playerSrc, StoryMedia } from './story-media';

const PLAYER =
  'https://player.mediadelivery.net/embed/786537/b8a77258-abfd-469d-ba63-9b89b62fcce6?token=abc&expires=1792789200';
const base: PublicStory = {
  id: 's1',
  slug: 'a-story',
  title: 'A story',
  description: 'About it',
  body: null,
  bylineName: null,
  primaryFormat: 'video',
  media: [],
  image: null,
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 1,
};
const video = (over: Partial<PublicStory['media'][number]> = {}) => ({
  format: 'video' as const,
  playbackUrl: PLAYER,
  thumbnailUrl: null,
  width: 360,
  height: 640,
  captionsUrl: null,
  durationSeconds: 12,
  ...over,
});

describe('playerSrc', () => {
  it('keeps the signature and turns autoplay and preload off', () => {
    const src = new URL(playerSrc(PLAYER)!);
    expect(src.searchParams.get('token')).toBe('abc');
    expect(src.searchParams.get('expires')).toBe('1792789200');
    expect(src.searchParams.get('autoplay')).toBe('false');
    expect(src.searchParams.get('preload')).toBe('false');
  });

  it('overrides an autoplay the URL already asks for', () => {
    expect(
      new URL(playerSrc(`${PLAYER}&autoplay=true`)!).searchParams.getAll(
        'autoplay',
      ),
    ).toEqual(['false']);
  });

  it.each(['javascript:alert(1)', 'not a url', 'data:text/html,hi'])(
    'refuses %p',
    (url) => {
      expect(playerSrc(url)).toBeNull();
    },
  );
});

describe('StoryMedia', () => {
  it('embeds the signed player without autoplay, at the video’s shape', () => {
    const html = renderToStaticMarkup(
      <StoryMedia story={{ ...base, media: [video()] }} />,
    );
    expect(html).toContain('<iframe');
    expect(html).toContain('title="Video: A story"');
    expect(html).toContain('autoplay=false');
    // The iframe may not autoplay: `allow` grants no autoplay.
    expect(html).toMatch(/allow="[^"]*fullscreen[^"]*"/);
    expect(html).not.toMatch(/allow="[^"]*autoplay/);
    expect(html).toContain('aspect-ratio:360 / 640');
    expect(html).toContain('loading="lazy"');
  });

  it('gives audio a short player', () => {
    const html = renderToStaticMarkup(
      <StoryMedia
        story={{
          ...base,
          primaryFormat: 'audio',
          media: [video({ format: 'audio', width: null, height: null })],
        }}
      />,
    );
    expect(html).toContain('title="Audio: A story"');
    expect(html).not.toContain('aspect-ratio');
  });

  it('shows a written story’s signed image with its alt text, or the neutral default', () => {
    const image = {
      url: 'https://images.b-cdn.net/dev-seed/a.webp?token=HS256-x&expires=1',
      width: 1200,
      height: 1600,
      alt: null,
    };
    const html = renderToStaticMarkup(
      <StoryMedia story={{ ...base, primaryFormat: 'written', image }} />,
    );
    expect(html).toContain('<img');
    expect(html).toContain(
      'src="https://images.b-cdn.net/dev-seed/a.webp?token=HS256-x&amp;expires=1"',
    );
    expect(html).toContain('alt="A photo shared with this story"');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="1600"');
  });

  it('renders nothing without signed URLs (signing off, or no media)', () => {
    expect(
      renderToStaticMarkup(
        <StoryMedia
          story={{
            ...base,
            media: [video({ playbackUrl: null })],
            image: { url: null, width: 1, height: 1, alt: 'x' },
          }}
        />,
      ),
    ).toBe('');
    expect(renderToStaticMarkup(<StoryMedia story={base} />)).toBe('');
  });
});

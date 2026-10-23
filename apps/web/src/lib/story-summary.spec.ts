import type { PublicStory } from './public-stories';
import { excerptOf, summaryFromStory } from './story-summary';

const story: PublicStory = {
  id: 'seed_v01',
  slug: 'test-video',
  title: 'Test video',
  description: 'Dummy video story.',
  body: 'Some text.',
  bylineName: 'Test Person',
  primaryFormat: 'video',
  media: [
    {
      format: 'video',
      playbackUrl: 'https://player.example/embed/1/x?token=a',
      thumbnailUrl: 'https://cdn.example/x/thumbnail.jpg?token=b',
      width: 360,
      height: 640,
      captionsUrl: null,
      durationSeconds: 12,
    },
  ],
  image: null,
  tags: [{ slug: 'hope', name: 'Hope' }],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 3,
};

describe('excerptOf (like the API’s card excerpt)', () => {
  it('keeps short text, on one line', () => {
    expect(excerptOf('One.\n\nTwo.')).toBe('One. Two.');
  });

  it('cuts at a word before 240 characters and adds …', () => {
    const cut = excerptOf('word '.repeat(100));
    expect(cut.endsWith('word…')).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(241);
  });
});

describe('summaryFromStory', () => {
  it('makes a card from a full story, never carrying the player link', () => {
    const card = summaryFromStory(story);
    expect(card).toEqual({
      id: 'seed_v01',
      slug: 'test-video',
      title: 'Test video',
      excerpt: 'Dummy video story.',
      bylineName: 'Test Person',
      primaryFormat: 'video',
      durationSeconds: 12,
      thumbnailUrl: 'https://cdn.example/x/thumbnail.jpg?token=b',
      thumbnailWidth: 360,
      thumbnailHeight: 640,
      image: null,
      textLength: 10,
      tags: [{ slug: 'hope', name: 'Hope' }],
      publishedAt: '2026-10-21T20:00:00Z',
    });
    expect(JSON.stringify(card)).not.toContain('player.example');
  });

  it('uses the text when there is no description', () => {
    expect(
      summaryFromStory({ ...story, description: '', media: [] }).excerpt,
    ).toBe('Some text.');
  });
});

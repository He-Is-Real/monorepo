import { MediaUrls } from './media-urls';
import { clipPicture, EXCERPT_CHARS, excerpt } from './story-summary';

describe('excerpt', () => {
  it('keeps short text whole, on one line', () => {
    expect(excerpt('  A short\n\ndescription.  ')).toBe('A short description.');
  });

  it('cuts long text at a word, with an ellipsis', () => {
    const text = 'word '.repeat(100);
    const cut = excerpt(text);
    expect(cut.endsWith('word…')).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(EXCERPT_CHARS + 1);
    expect([...cut].length).toBeGreaterThan(EXCERPT_CHARS - 10);
  });

  it('drops a comma, semicolon or colon before the ellipsis', () => {
    expect(excerpt('word, '.repeat(100))).toMatch(/word…$/);
    expect(excerpt('word; '.repeat(100))).toMatch(/word…$/);
  });

  it('cuts text without spaces (Japanese) at a character', () => {
    const cut = excerpt('物'.repeat(500));
    expect(cut).toBe(`${'物'.repeat(EXCERPT_CHARS)}…`);
  });

  it('never splits a character outside the BMP', () => {
    const cut = excerpt('😀'.repeat(300));
    expect(cut).toBe(`${'😀'.repeat(EXCERPT_CHARS)}…`);
  });

  it('cuts at the character when the last space is far back', () => {
    const text = `a ${'b'.repeat(400)}`;
    expect(excerpt(text)).toBe(`${text.slice(0, EXCERPT_CHARS)}…`);
  });

  it('is empty for no text', () => {
    expect(excerpt('')).toBe('');
  });
});

describe('clipPicture (M2 plan PR 10; Joel, 2026-10-30)', () => {
  const urls = new MediaUrls(null);
  const signed = {
    imageUrl: (p: string) => `img:${p}`,
    thumbnailUrl: (v: string, p: string) => `bunny:${v}/${p}`,
  } as unknown as MediaUrls;
  const clip = {
    format: 'video' as const,
    bunnyVideoId: 'v',
    thumbnailPath: 'v/thumbnail.jpg',
    width: 1080,
    height: 1920,
  };

  it('shows the person’s own image in place of Bunny’s thumbnail, at its own size', () => {
    expect(
      clipPicture(
        clip,
        { path: 'stories/s/a.webp', width: 1280, height: 720 },
        signed,
      ),
    ).toEqual({ url: 'img:stories/s/a.webp', width: 1280, height: 720 });
  });

  it('keeps Bunny’s thumbnail without one, and nothing without a clip', () => {
    expect(clipPicture(clip, undefined, signed)).toEqual({
      url: 'bunny:v/v/thumbnail.jpg',
      width: 1080,
      height: 1920,
    });
    expect(clipPicture(undefined, undefined, urls)).toEqual({
      url: null,
      width: null,
      height: null,
    });
  });
});

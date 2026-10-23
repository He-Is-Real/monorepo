import { MediaUrls } from '../media/media-urls';
import {
  EXCERPT_CHARS,
  excerpt,
  type SummaryRow,
  toSummary,
} from './story-summary';

const SIGNING_OFF = new MediaUrls(null);

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

const row = (over: Partial<SummaryRow> = {}): SummaryRow => ({
  id: 'seed_v01',
  slug: 'a-story',
  title: 'A story',
  description: 'What happened.',
  bodyStart: 'The text.',
  textLength: 9,
  primaryFormat: 'video',
  media: [
    {
      format: 'video',
      width: 1080,
      height: 1920,
      bunnyVideoId: 'internal',
      thumbnailPath: 'internal/thumb.jpg',
    },
  ],
  tags: [{ slug: 'hope', name: 'Hope', category: 'emotion', version: 2 }],
  publishedAt: '2026-10-21T20:00:00Z',
  cursorAt: '2026-10-21T20:00:00.123456789Z',
  durationSeconds: 75,
  ...over,
});

describe('toSummary', () => {
  it('builds a video card from the read model, with no internal media fields', () => {
    expect(toSummary(row(), SIGNING_OFF)).toEqual({
      id: 'seed_v01',
      slug: 'a-story',
      title: 'A story',
      excerpt: 'What happened.',
      bylineName: null,
      primaryFormat: 'video',
      durationSeconds: 75,
      thumbnailUrl: null,
      thumbnailWidth: 1080,
      thumbnailHeight: 1920,
      image: null,
      textLength: 9,
      tags: [{ slug: 'hope', name: 'Hope', category: 'emotion', version: 2 }],
      publishedAt: '2026-10-21T20:00:00Z',
    });
  });

  it('uses the text when there is no description', () => {
    expect(toSummary(row({ description: ' ' }), SIGNING_OFF).excerpt).toBe(
      'The text.',
    );
  });

  it('builds a written card with its image shape, never its path', () => {
    const card = toSummary(
      row({
        primaryFormat: 'written',
        media: [],
        durationSeconds: undefined,
        bylineName: 'Ruth',
        image: { path: 'images/x.webp', width: 1200, height: 1600 },
      }),
      SIGNING_OFF,
    );
    expect(card).toMatchObject({
      bylineName: 'Ruth',
      durationSeconds: null,
      thumbnailWidth: null,
      thumbnailHeight: null,
      image: { url: null, width: 1200, height: 1600, alt: null },
    });
    expect(JSON.stringify(card)).not.toContain('x.webp');
  });

  it('gives an audio card no picture size', () => {
    expect(
      toSummary(
        row({ primaryFormat: 'audio', media: [{ format: 'audio' }] }),
        SIGNING_OFF,
      ),
    ).toMatchObject({ thumbnailWidth: null, thumbnailHeight: null });
  });
});

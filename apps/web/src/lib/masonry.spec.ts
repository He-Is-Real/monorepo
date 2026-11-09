import type { StorySummary } from './browse';
import {
  BANDS,
  BREAKPOINTS,
  cardShape,
  COLUMN_COUNTS,
  layoutFor,
  lineCount,
  place,
  predictHeight,
} from './masonry';

const card = (over: Partial<StorySummary> = {}): StorySummary => ({
  id: 's',
  slug: 's',
  title: 'A test story',
  excerpt: 'A short excerpt.',
  bylineName: 'Test Person',
  primaryFormat: 'written',
  durationSeconds: null,
  playbackUrl: null,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 900,
  themes: [],
  publishedAt: '2026-10-21T20:00:00Z',
  isNew: false,
  ...over,
});
const video = (width: number, height: number) =>
  card({
    primaryFormat: 'video',
    durationSeconds: 12,
    thumbnailWidth: width,
    thumbnailHeight: height,
  });
const image = (width: number, height: number) =>
  card({ image: { url: null, width, height, alt: null } });
const h = (s: StorySummary, width = 340) => predictHeight(cardShape(s), width);

describe('lineCount (wrapping as the browser does)', () => {
  it('wraps word by word, and breaks a word longer than the line anywhere', () => {
    expect(lineCount('', 200, 'excerpt')).toBe(0);
    expect(lineCount('A few words', 200, 'excerpt')).toBe(1);
    expect(lineCount('word '.repeat(20), 200, 'excerpt')).toBeGreaterThan(1);
    // One unbroken 40-letter word at 15 px is about 330 px: two lines at 200 px.
    expect(lineCount('a'.repeat(40), 200, 'excerpt')).toBe(2);
  });

  it('counts text with a character it has no width for (emoji, other alphabets) as its most lines', () => {
    expect(lineCount('Joy 🎉', 400, 'title')).toBe(Infinity);
    // Spaces other than U+0020 and soft hyphens wrap differently (Codex review of #163, round 2).
    expect(lineCount(Array(25).fill('i').join('\u2003'), 400, 'title')).toBe(
      Infinity,
    );
    expect(lineCount('trans\u00ADfor\u00ADma\u00ADtion', 400, 'title')).toBe(
      Infinity,
    );
    expect(lineCount('A few\n words', 200, 'excerpt')).toBe(1);
    expect(h(card({ title: 'Joy 🎉' }))).toBe(
      h(card({ title: 'word '.repeat(60) })),
    );
  });
});

describe('place (each card into the shortest column)', () => {
  it('breaks ties to the leftmost column', () => {
    expect(place([100, 100, 100], 3).column).toEqual([0, 1, 2]);
  });

  it('continues from the columns already on screen', () => {
    const first = place([500, 100], 2);
    expect(first.heights).toEqual([500 + 24, 100 + 24]); // each card adds its gap
    expect(place([100], 2, first.heights).column).toEqual([1]);
  });
});

describe('spanFor and layoutFor', () => {
  it('lays out every card for every column count and band, continuing from start', () => {
    const cards = [video(360, 640), card(), image(1200, 800)];
    const { cards: layout, heights } = layoutFor(cards);
    expect(layout).toHaveLength(3);
    for (const n of COLUMN_COUNTS) {
      expect(heights[n]).toHaveLength(n);
      for (const c of layout) {
        expect(c.col[n]).toBeGreaterThanOrEqual(0);
        expect(c.col[n]).toBeLessThan(n);
      }
    }
    // A 9:16 video's span grows with its band's card width at the default text size (from the
    // list at 640 px less the page's padding; with larger text, narrower cards wrap more lines).
    expect(layout[0].span).toHaveLength(BANDS.length);
    const two = BANDS.flatMap((b, i) =>
      b.columns === 2 && b.minWidth >= BREAKPOINTS[2] - 80
        ? [layout[0].span[i]]
        : [],
    );
    expect(two).toEqual([...two].sort((a, b) => a - b));
    expect(layout.map((c) => c.col[3])).toEqual([0, 1, 2]);
    // The next page continues: its first card goes into the shortest column (the flat written one).
    const more = layoutFor([card()], heights);
    expect(more.cards[0].col[3]).toBe(1);
  });
});

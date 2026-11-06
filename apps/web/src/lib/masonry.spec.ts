import type { StorySummary } from './browse';
import { COLUMN_COUNTS, layoutFor, place } from './masonry';

const card = (over: Partial<StorySummary> = {}): StorySummary => ({
  id: 's',
  slug: 's',
  title: 'A test story',
  excerpt: 'A short excerpt.',
  bylineName: 'Test Person',
  primaryFormat: 'written',
  durationSeconds: null,
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
  it('lays out every card for every column count, continuing from start', () => {
    const cards = [video(360, 640), card(), image(1200, 800)];
    const { cards: layout, heights } = layoutFor(cards);
    expect(layout).toHaveLength(3);
    for (const n of COLUMN_COUNTS) {
      expect(heights[n]).toHaveLength(n);
      for (const c of layout) {
        expect(c.col[n]).toBeGreaterThanOrEqual(0);
        expect(c.col[n]).toBeLessThan(n);
        expect(c.span[n]).toBeGreaterThan(0);
      }
    }
    expect(layout.map((c) => c.col[3])).toEqual([0, 1, 2]);
    // The next page continues: its first card goes into the shortest column (the flat written one).
    const more = layoutFor([card()], heights);
    expect(more.cards[0].col[3]).toBe(1);
  });
});

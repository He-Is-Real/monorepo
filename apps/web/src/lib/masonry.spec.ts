import type { StorySummary } from './browse';
import {
  cardShape,
  COLUMN_COUNTS,
  layoutFor,
  place,
  predictHeight,
  ROW_UNIT,
  spanFor,
} from './masonry';

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
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
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

describe('predictHeight (D55: fixed parts + clamped media + text)', () => {
  it('makes a written story with an image taller than one without', () => {
    expect(h(image(1200, 800))).toBeGreaterThan(h(card()));
  });

  it('makes a 9:16 video taller than a 16:9 one at the same width', () => {
    expect(h(video(360, 640))).toBeGreaterThan(h(video(1920, 1080)));
  });

  it('clamps shapes to 9:16..2:1 (D53): 1:3 predicts like 9:16, 3:1 like 2:1', () => {
    expect(h(video(300, 900))).toBe(h(video(900, 1600)));
    expect(h(image(3000, 1000))).toBe(h(image(2000, 1000)));
  });

  it('gives a media item its card width ÷ shape', () => {
    // Same text, so the difference is the media alone: 340/(9/16) − 340/2.
    expect(h(video(900, 1600)) - h(video(2000, 1000))).toBeCloseTo(
      340 / (9 / 16) - 340 / 2,
      0,
    );
  });

  it('caps excerpt lines, so a long excerpt is no taller than a 3-line one', () => {
    const long = 'word '.repeat(48).trim(); // 239 characters
    const three = 'word '.repeat(30).trim();
    expect(h(video(1920, 1080), 200)).toBeLessThan(
      h(card({ ...video(1920, 1080), excerpt: long }), 200),
    );
    expect(h(card({ ...video(1920, 1080), excerpt: long }), 200)).toBe(
      h(card({ ...video(1920, 1080), excerpt: three + three }), 200),
    );
  });

  it('adds a row for tags', () => {
    const tags = [
      { slug: 'hope', name: 'Hope', category: 'emotion' as const, version: 1 },
    ];
    expect(h(card({ tags }))).toBeGreaterThan(h(card()));
  });

  it('gives audio its thumbnail’s shape (the default’s 16:9 without one) and grows narrower cards’ text', () => {
    const audio = card({ primaryFormat: 'audio', durationSeconds: 30 });
    expect(h(audio)).toBe(h(video(1280, 720)));
    const own = card({
      primaryFormat: 'audio',
      thumbnailWidth: 1080,
      thumbnailHeight: 1350,
    });
    expect(h(own)).toBe(h(video(1080, 1350)));
    // A written story without an image has no media: only its text grows when narrow.
    const long = card({ title: 'A longer title that wraps on a narrow card' });
    expect(h(long, 200)).toBeGreaterThan(h(long, 400));
  });
});

describe('place (each card into the shortest column)', () => {
  it('balances 3 tall and 3 flat cards across 2 columns', () => {
    const { heights } = place([600, 600, 600, 200, 200, 200], 2);
    expect(Math.abs(heights[0] - heights[1])).toBeLessThan(600);
  });

  it('keeps date order in one column', () => {
    expect(place([100, 300, 200], 1).column).toEqual([0, 0, 0]);
  });

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
  it('rounds a height plus the gap up to whole row units', () => {
    expect(spanFor(100)).toBe(Math.ceil((100 + 24) / ROW_UNIT));
    expect(spanFor(101)).toBe(Math.ceil((101 + 24) / ROW_UNIT));
  });

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

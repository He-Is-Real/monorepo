import { CARD_ASPECT, cardAspect, DEFAULT_IMAGE_ALT, imageAlt } from './shape';

describe('cardAspect (D53: cards clamp between 9:16 and 2:1)', () => {
  it.each([
    ['square', 1080, 1080, 1],
    ['landscape 16:9', 1920, 1080, 16 / 9],
    ['portrait 9:16 (the tall limit)', 1080, 1920, 9 / 16],
    ['wide 2:1 (the wide limit)', 2000, 1000, 2],
    ['a taller phone clip, 9:19.5 → 9:16 (letterboxed)', 1080, 2340, 9 / 16],
    ['a panorama, 3:1 → 2:1 (cropped)', 3000, 1000, 2],
  ])('%s', (_name, width, height, expected) => {
    expect(cardAspect(width, height)).toBeCloseTo(expected, 10);
  });

  it('falls back to square for a missing or invalid size', () => {
    expect(cardAspect(null, null)).toBe(1);
    expect(cardAspect(0, 100)).toBe(1);
    expect(cardAspect(100, Number.NaN)).toBe(1);
  });

  it('exposes the limits', () => {
    expect(CARD_ASPECT).toEqual({ min: 9 / 16, max: 2 });
  });
});

describe('imageAlt (D53: a neutral default without one)', () => {
  it('uses the person’s description', () => {
    expect(imageAlt({ alt: 'A sunrise' })).toBe('A sunrise');
  });
  it.each([null, '', '   '])('falls back to the default for %p', (alt) => {
    expect(imageAlt({ alt })).toBe(DEFAULT_IMAGE_ALT);
  });
});

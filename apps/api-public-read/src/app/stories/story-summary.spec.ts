import { EXCERPT_CHARS, excerpt } from './story-summary';

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

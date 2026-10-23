import { MIN_HIDDEN_CHARS, PREVIEW_CHARS, previewCut } from './story-preview';

const words = (n: number) => Array(n).fill('word').join(' '); // 5n - 1 characters

describe('previewCut', () => {
  it('shows short text whole', () => {
    expect(previewCut(['Short story.'])).toBeNull();
    expect(previewCut([words(120)])).toBeNull(); // 599 characters
  });

  it('shows the text whole when the preview would hide only a few words', () => {
    const p = 'a'.repeat(PREVIEW_CHARS + MIN_HIDDEN_CHARS - 10) + ' end';
    expect(previewCut([p])).toBeNull();
  });

  it('cuts at the last space at or before 600 characters, never inside a word', () => {
    const text = words(200); // 999 characters
    const cut = previewCut([text]);
    expect(cut).toEqual({ paragraph: 0, offset: 599 });
    expect(text[599]).toBe(' ');
    expect(text.slice(0, 599).endsWith('word')).toBe(true);
  });

  it('counts characters across paragraphs and cuts in the one where 600 falls', () => {
    const paragraphs = [words(60), words(60), words(60)]; // 299 each
    const cut = previewCut(paragraphs);
    expect(cut?.paragraph).toBe(2);
    const offset = cut?.offset ?? 0;
    expect(offset).toBeLessThanOrEqual(2);
    expect(offset === 0 || /\s/.test(paragraphs[2][offset])).toBe(true);
  });

  it('ends at a paragraph when 600 falls exactly on its end', () => {
    expect(previewCut(['a'.repeat(600), words(40)])).toEqual({
      paragraph: 1,
      offset: 0,
    });
  });

  it('ends with the paragraphs before a long unbroken word (a pasted link)', () => {
    expect(previewCut([words(20), 'x'.repeat(900)])).toEqual({
      paragraph: 1,
      offset: 0,
    });
  });

  it('keeps a first paragraph’s long first word whole', () => {
    const first = `${'x'.repeat(650)} and the rest ${words(40)}`;
    expect(previewCut([first])).toEqual({ paragraph: 0, offset: 650 });
    expect(previewCut(['y'.repeat(900)])).toBeNull();
    expect(previewCut(['y'.repeat(900), words(40)])).toEqual({
      paragraph: 1,
      offset: 0,
    });
  });
});

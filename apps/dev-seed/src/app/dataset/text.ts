/**
 * Obviously fake story text (D47): plain sentences that say they're test content, so nothing
 * on dev can be mistaken for a real testimony. Deterministic: the same dataset every reset.
 */
const SENTENCES = [
  'This is dummy text for the development site, written to test how stories look and read.',
  'Nothing in it happened, and nobody shared it: it is here so pages have something to show.',
  'A real story would describe a moment of faith in the words of the person who lived it.',
  'This paragraph exists to fill space, check line lengths and see how long text wraps on a phone.',
  'The moderators of the real site read every story before it is published; this one is a fixture.',
  'Placeholder sentences repeat in a fixed order, so every reset produces exactly the same text.',
  'If you can read this on the public site, the development dataset was loaded where it should not be.',
  'Test content keeps the layout honest: short paragraphs, long paragraphs and the gaps between them.',
];

/** Paragraphs of dummy text, exactly `length` characters long, with no leading or trailing space. */
export function dummyText(length: number, offset = 0): string {
  if (length < 1) throw new Error('dummyText: length must be positive');
  let text = '';
  for (let i = 0; text.length < length; i++) {
    const sentence = SENTENCES[(i + offset) % SENTENCES.length];
    const joiner = text === '' ? '' : (i + 1) % 4 === 0 ? '\n\n' : ' ';
    text += joiner + sentence;
  }
  text = text.slice(0, length);
  // Never end on whitespace: the length is what the schema checks (trimmed).
  return text.replace(/\s$/, '.');
}

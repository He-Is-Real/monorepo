// Long written stories open as a preview with a "Continue reading" button (Joel, 2026-10-23; the
// POC showed the first 600 characters). The full text is always in the server-rendered HTML;
// only the rest is hidden until the reader expands it.

/** About how many characters the preview shows (the POC's 600). */
export const PREVIEW_CHARS = 600;
/** Show the whole text when the preview would hide less than this: no button for a few words. */
export const MIN_HIDDEN_CHARS = 100;

/** Where the preview ends: in paragraph `paragraph`, before character `offset`. */
export interface PreviewCut {
  paragraph: number;
  offset: number;
}

/**
 * Where to cut the preview of these paragraphs, or `null` to show them whole. Cuts at a word
 * boundary (whitespace) at or before `limit` characters, never inside a word. If the paragraph
 * where the limit falls has no space before it, the preview ends with the paragraphs before it;
 * if that's the first paragraph, after its first word.
 */
export function previewCut(
  paragraphs: string[],
  limit = PREVIEW_CHARS,
): PreviewCut | null {
  const total = paragraphs.reduce((n, p) => n + p.length, 0);
  if (total <= limit + MIN_HIDDEN_CHARS) return null;
  let left = limit;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (p.length <= left) {
      left -= p.length;
      if (left === 0)
        return i + 1 < paragraphs.length
          ? { paragraph: i + 1, offset: 0 }
          : null;
      continue;
    }
    const space = lastSpaceAtOrBefore(p, left);
    if (space > 0) return { paragraph: i, offset: space };
    if (i > 0) return { paragraph: i, offset: 0 };
    const after = p.slice(left).search(/\s/);
    return after < 0 && paragraphs.length === 1
      ? null // one enormous word: show it whole
      : after < 0
        ? { paragraph: 1, offset: 0 }
        : { paragraph: 0, offset: left + after };
  }
  return null;
}

function lastSpaceAtOrBefore(text: string, index: number): number {
  for (let i = Math.min(index, text.length - 1); i > 0; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}

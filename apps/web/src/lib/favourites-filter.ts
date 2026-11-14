import type { StorySummary } from './browse';
import type { BrowseFilters } from './browse-query';

// "Favourites only" with browse's filters (FV-2 B; Joel, 2026-11-14: "make it searchable and
// filterable… I dont expect people to have more than 100… we will do optimization later"). The
// browser holds the person's whole favourites list and filters it here, with browse's meanings:
//
// - **format**: the story's main format, as browse.
// - **theme**: stories carrying that theme, as browse.
// - **search**: every word of the search appears in the card's title, description or the names
//   of its themes (browse's search words, less the written text, which cards don't carry). Case
//   and accents are ignored, and a word matches inside a longer one ("heal" finds "healing"),
//   standing in for the database's word stems.
// - **sort**: "Latest first" and "Oldest first" by when the story was published, as browse;
//   "Best match" (with a search) by how often the search's words appear, all fields counting
//   equally as in browse, newest first among equals.
//
// Stories that tie keep the list's own order (newest heart first).

/** Lower case, without accents, so "Café" and "cafe" are the same. */
const fold = (s: string) =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** The search's words, folded. */
const wordsOf = (q: string) => fold(q).split(/\s+/).filter(Boolean);

/** How many times `word` appears in `text`. */
function occurrences(text: string, word: string): number {
  let n = 0;
  for (
    let at = text.indexOf(word);
    at !== -1;
    at = text.indexOf(word, at + word.length)
  )
    n += 1;
  return n;
}

const searchText = (c: StorySummary) =>
  fold([c.title, c.excerpt, ...c.themes.map((t) => t.name)].join('\n'));

const published = (c: StorySummary) => Date.parse(c.publishedAt) || 0;

/** The favourites `filters` keep, in `filters.sort`'s order. */
export function filterFavourites(
  cards: readonly StorySummary[],
  filters: BrowseFilters,
): StorySummary[] {
  const words = wordsOf(filters.q);
  const kept: { card: StorySummary; score: number }[] = [];
  for (const card of cards) {
    if (filters.format && card.primaryFormat !== filters.format) continue;
    if (filters.theme && !card.themes.some((t) => t.id === filters.theme))
      continue;
    let score = 0;
    if (words.length) {
      const text = searchText(card);
      const counts = words.map((w) => occurrences(text, w));
      if (counts.some((n) => n === 0)) continue;
      score = counts.reduce((a, b) => a + b, 0);
    }
    kept.push({ card, score });
  }
  const byDate = (a: StorySummary, b: StorySummary) =>
    filters.sort === 'oldest'
      ? published(a) - published(b)
      : published(b) - published(a);
  // Array.prototype.sort is stable: ties keep the list's order.
  kept.sort((a, b) =>
    filters.sort === 'relevance' && words.length
      ? b.score - a.score || byDate(a.card, b.card)
      : byDate(a.card, b.card),
  );
  return kept.map((k) => k.card);
}

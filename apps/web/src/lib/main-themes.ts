// The main themes (O5, Joel 2026-10-31): wherever people choose or filter by themes, the ones an
// admin picked come first, in the admin's order, and every other theme sits behind "More themes".

interface Named {
  slug: string;
  name: string;
}

/**
 * The themes to show first (`main`, in the admin's order) and the rest (`more`, by name). With no
 * main themes set (`main` empty), every theme is shown first and there is nothing more.
 */
export function splitThemes<T extends Named>(
  themes: T[],
  main: string[],
): { main: T[]; more: T[] } {
  const bySlug = new Map(themes.map((t) => [t.slug, t]));
  const first = main.flatMap((slug) => bySlug.get(slug) ?? []);
  if (first.length === 0) return { main: themes, more: [] };
  const shown = new Set(first.map((t) => t.slug));
  return {
    main: first,
    more: themes
      .filter((t) => !shown.has(t.slug))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

/** The themes whose name contains the search, ignoring case and spaces at the ends. */
export function searchThemes<T extends Named>(
  themes: T[],
  search: string,
): T[] {
  const q = search.trim().toLocaleLowerCase('en');
  return q
    ? themes.filter((t) => t.name.toLocaleLowerCase('en').includes(q))
    : themes;
}

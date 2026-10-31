// The main themes (O5, Joel 2026-10-31): wherever people choose or filter by themes, the ones an
// admin picked come first, in the admin's order, and every other theme sits behind "More themes".

interface Named {
  id: string;
  name: string;
}

/**
 * The themes to show first (`main`, in the admin's order) and the rest (`more`, by name). The rest
 * always stay behind "More themes", even when none of the main themes is here (none set, or, on
 * browse, none used by a published story): a phone never gets the whole list at once.
 */
export function splitThemes<T extends Named>(
  themes: T[],
  main: string[],
): { main: T[]; more: T[] } {
  const byId = new Map(themes.map((t) => [t.id, t]));
  const first = main.flatMap((id) => byId.get(id) ?? []);
  const shown = new Set(first.map((t) => t.id));
  return {
    main: first,
    more: themes
      .filter((t) => !shown.has(t.id))
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

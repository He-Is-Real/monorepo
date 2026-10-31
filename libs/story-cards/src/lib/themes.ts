/** `components.yaml#/components/schemas/ThemeRef`: a theme as a story carries it. */
export interface ThemeRef {
  id: string;
  name: string;
}

/** `components.yaml#/components/schemas/Theme`. */
export interface Theme {
  id: string;
  name: string;
  highlighted: boolean;
}

/** `components.yaml#/components/schemas/ThemeCategory`: a category and its themes. */
export interface ThemeCategory {
  id: string;
  name: string;
  themes: Theme[];
}

/** The fixed category (`themeCategory:other`): listed last, never deleted or renamed. */
export const OTHER_CATEGORY = 'other';

/** Every category and theme, as `THEMES_SQL` selects them. */
export const THEMES_SQL = `SELECT record::id(id) AS id, name FROM themeCategory;
  SELECT record::id(id) AS id, name, highlighted, record::id(category) AS category FROM theme;`;

export interface ThemeRow extends Theme {
  category: string;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

/**
 * Themes plan v3's order everywhere: categories A–Z with Other last, themes A–Z inside each.
 * `keep` chooses the themes to list; a category left with none isn't listed.
 */
export function groupThemes<T extends ThemeRow>(
  categories: { id: string; name: string }[],
  themes: T[],
  keep: (theme: T) => boolean = () => true,
): ThemeCategory[] {
  return [...categories]
    .sort(
      (a, b) =>
        Number(a.id === OTHER_CATEGORY) - Number(b.id === OTHER_CATEGORY) ||
        byName(a, b),
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      themes: themes
        .filter((t) => t.category === c.id && keep(t))
        .sort(byName)
        .map(({ id, name, highlighted }) => ({ id, name, highlighted })),
    }))
    .filter((c) => c.themes.length > 0);
}

/**
 * /admin/themes' held changes (themes plan v3). The page keeps the whole picture of categories
 * and themes as it should be; Save sends it (SaveThemes, A1) at the version it loaded (A2). What
 * changed is worked out by comparing that picture with the one loaded, never kept as a list of
 * steps.
 */

export const OTHER = 'other';

/** The contract's `AdminThemes`. */
export interface AdminThemes {
  version: number;
  categories: {
    id: string;
    name: string;
    themes: {
      id: string;
      name: string;
      highlighted: boolean;
      storyCount: number;
    }[];
  }[];
}

export interface EditTheme {
  id: string;
  name: string;
  highlighted: boolean;
  /** How many stories carry it (0 for a new one): for the Save summary. */
  storyCount: number;
  /** Deleted on the page (greyed out until Save; can be undone). */
  deleted: boolean;
}

export interface EditCategory {
  id: string;
  name: string;
  themes: EditTheme[];
}

/** The page's picture: categories A–Z with Other last, as the API sends them. */
export type Picture = EditCategory[];

export const fromApi = (data: AdminThemes): Picture =>
  data.categories.map((c) => ({
    ...c,
    themes: c.themes.map((t) => ({ ...t, deleted: false })),
  }));

/**
 * A name as everyone sees it, as api-admin tidies it: no spaces at the ends, single spaces
 * inside, the first character capitalised (A4).
 */
export function tidyName(name: string): string {
  const spaced = name.trim().replace(/\s+/gu, ' ');
  const [first = '', ...rest] = spaced;
  return first.toUpperCase() + rest.join('');
}

/** "delete Doubt", ignoring spaces at the ends and capitals (A10). */
export const confirmsDelete = (typed: string, name: string) =>
  typed.trim().toLowerCase() === `delete ${name}`.toLowerCase();

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

/** Categories A–Z with Other last; themes A–Z (themes plan v3: no manual order). */
export const sorted = (picture: Picture): Picture =>
  [...picture]
    .sort(
      (a, b) => Number(a.id === OTHER) - Number(b.id === OTHER) || byName(a, b),
    )
    .map((c) => ({ ...c, themes: [...c.themes].sort(byName) }));

/** SaveThemes' body: the picture without deleted themes or story counts. */
export const toSave = (picture: Picture) => ({
  categories: picture.map((c) => ({
    id: c.id,
    name: c.name,
    themes: c.themes
      .filter((t) => !t.deleted)
      .map(({ id, name, highlighted }) => ({ id, name, highlighted })),
  })),
});

export interface Change {
  /** Changes more than this page (stories lose a theme, themes move to Other). */
  sideEffect: boolean;
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Every change between the loaded picture and the page's, in words, the ones with a side effect
 * first ("Doubt will be removed from 4 stories", "Feelings' 3 themes move to Other").
 */
export function changesBetween(loaded: Picture, now: Picture): Change[] {
  const changes: Change[] = [];
  const wasCategory = new Map(loaded.map((c) => [c.id, c]));
  const nowCategory = new Map(now.map((c) => [c.id, c]));
  const wasTheme = new Map(
    loaded.flatMap((c) => c.themes.map((t) => [t.id, { ...t, category: c }])),
  );
  const deletedCategories = new Set(
    loaded.filter((c) => !nowCategory.has(c.id)).map((c) => c.id),
  );

  for (const c of loaded) {
    if (!deletedCategories.has(c.id)) continue;
    const moved = now
      .flatMap((n) => n.themes)
      .filter((t) => !t.deleted && wasTheme.get(t.id)?.category.id === c.id);
    changes.push({
      sideEffect: moved.length > 0,
      text:
        moved.length > 0
          ? `${c.name} is deleted. Its ${plural(moved.length, 'theme')} move to Other, not highlighted.`
          : `${c.name} is deleted.`,
    });
  }
  for (const c of now) {
    const was = wasCategory.get(c.id);
    if (!was) changes.push({ sideEffect: false, text: `${c.name} created` });
    else if (was.name !== c.name)
      changes.push({
        sideEffect: false,
        text: `${was.name} renamed “${c.name}”`,
      });
    for (const t of c.themes) {
      const before = wasTheme.get(t.id);
      if (!before) {
        if (!t.deleted)
          changes.push({
            sideEffect: false,
            text: `${t.name} added to ${c.name}${t.highlighted ? ', highlighted' : ''}`,
          });
        continue;
      }
      if (t.deleted) {
        changes.push({
          sideEffect: before.storyCount > 0,
          text:
            before.storyCount > 0
              ? `${before.name} is deleted. It’s used by ${plural(before.storyCount, 'story', 'stories')} and will be removed from them.`
              : `${before.name} is deleted.`,
        });
        continue;
      }
      if (before.name !== t.name)
        changes.push({
          sideEffect: false,
          text: `${before.name} renamed “${t.name}”`,
        });
      // Moved with its deleted category: said once, with the category.
      if (deletedCategories.has(before.category.id)) continue;
      if (before.category.id !== c.id)
        changes.push({
          sideEffect: false,
          text: `${t.name} moved to ${c.name}`,
        });
      if (before.highlighted !== t.highlighted)
        changes.push({
          sideEffect: false,
          text: `${t.name} ${t.highlighted ? 'highlighted' : 'no longer highlighted'}`,
        });
    }
  }
  return [
    ...changes.filter((c) => c.sideEffect),
    ...changes.filter((c) => !c.sideEffect),
  ];
}

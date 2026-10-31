import { randomBytes } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { type FieldError, ProblemException } from '@heisreal/http';

/**
 * SaveThemes' body (api-admin.yaml, themes plan v3, A1): the whole finished picture of the
 * categories and their themes, checked once here. New rows have temporary ids starting `new-`.
 */
export interface PictureTheme {
  id: string;
  name: string;
  highlighted: boolean;
}
export interface PictureCategory {
  id: string;
  name: string;
  themes: PictureTheme[];
}

/** What the database holds now, as the save reads it. */
export interface CurrentThemes {
  categories: { id: string; name: string }[];
  themes: {
    id: string;
    name: string;
    category: string;
    highlighted: boolean;
  }[];
}

/** The difference to write, in the order the transaction writes it. */
export interface ThemeChanges {
  createCategories: { id: string; name: string }[];
  renameCategories: { id: string; name: string }[];
  createThemes: ThemeWrite[];
  updateThemes: ThemeWrite[];
  deleteThemes: string[];
  deleteCategories: string[];
}
interface ThemeWrite {
  id: string;
  name: string;
  category: string;
  highlighted: boolean;
}

export const OTHER = 'other';
const NAME_MAX = 40;
const NEW_ID = /^new-[A-Za-z0-9_-]{1,40}$/;
const ID = /^[0-9A-Za-z_]{1,40}$/;
const MAX_CATEGORIES = 100;
const MAX_THEMES = 500;

/**
 * A name as everyone sees it (themes plan v3): no spaces at the ends, single spaces inside, the
 * first character capitalised with the standard function (A4). The admin page does the same as
 * you type.
 */
export function tidyName(name: string): string {
  const spaced = name.trim().replace(/\s+/gu, ' ');
  const [first = '', ...rest] = spaced;
  return first.toUpperCase() + rest.join('');
}

/** Two names clash when they're the same ignoring case (lower-cased, NFC; A4). */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

const invalid = (errors: FieldError[]) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    errors,
  );

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The picture, with its names tidied, or `400` listing what's wrong (each error points at the
 * name or id, e.g. `/categories/1/themes/0/name`).
 */
export function parsePicture(body: unknown): PictureCategory[] {
  const errors: FieldError[] = [];
  const fail = (pointer: string, code: string, message: string) =>
    errors.push({ pointer, code, message });
  if (!isObject(body) || !Array.isArray(body['categories'])) {
    throw invalid([
      {
        pointer: '/categories',
        code: 'required',
        message: 'A list of categories.',
      },
    ]);
  }
  if (Object.keys(body).some((k) => k !== 'categories')) {
    fail('', 'unknown_field', 'Only `categories`.');
  }
  const raw = body['categories'] as unknown[];
  if (raw.length > MAX_CATEGORIES) {
    throw invalid([
      {
        pointer: '/categories',
        code: 'too_many',
        message: `At most ${MAX_CATEGORIES} categories.`,
      },
    ]);
  }
  const name = (v: unknown, pointer: string): string => {
    if (typeof v !== 'string') {
      fail(pointer, 'required', 'A name.');
      return '';
    }
    const tidy = tidyName(v);
    const length = [...tidy].length;
    if (length < 1 || length > NAME_MAX) {
      fail(pointer, 'length', `A name of 1 to ${NAME_MAX} characters.`);
    }
    return tidy;
  };
  const id = (v: unknown, pointer: string): string => {
    if (typeof v !== 'string' || !(NEW_ID.test(v) || ID.test(v))) {
      fail(pointer, 'invalid', 'An id, or `new-…` for a new one.');
      return '';
    }
    return v;
  };
  const exact = (
    o: Record<string, unknown>,
    keys: string[],
    pointer: string,
  ) => {
    if (Object.keys(o).some((k) => !keys.includes(k))) {
      fail(pointer, 'unknown_field', `Only ${keys.join(', ')}.`);
    }
  };

  let themeCount = 0;
  const picture = raw.map((c, ci): PictureCategory => {
    const at = `/categories/${ci}`;
    if (!isObject(c) || !Array.isArray(c['themes'])) {
      fail(at, 'invalid', 'A category: id, name and themes.');
      return { id: '', name: '', themes: [] };
    }
    exact(c, ['id', 'name', 'themes'], at);
    themeCount += (c['themes'] as unknown[]).length;
    return {
      id: id(c['id'], `${at}/id`),
      name: name(c['name'], `${at}/name`),
      themes: (c['themes'] as unknown[]).map((t, ti) => {
        const tat = `${at}/themes/${ti}`;
        if (!isObject(t)) {
          fail(tat, 'invalid', 'A theme: id, name and highlighted.');
          return { id: '', name: '', highlighted: false };
        }
        exact(t, ['id', 'name', 'highlighted'], tat);
        if (typeof t['highlighted'] !== 'boolean') {
          fail(`${tat}/highlighted`, 'required', 'true or false.');
        }
        return {
          id: id(t['id'], `${tat}/id`),
          name: name(t['name'], `${tat}/name`),
          highlighted: t['highlighted'] === true,
        };
      }),
    };
  });
  if (themeCount > MAX_THEMES) {
    fail('/categories', 'too_many', `At most ${MAX_THEMES} themes.`);
  }
  if (errors.length) throw invalid(errors);

  // Other: there, and still called Other.
  const other = picture.findIndex((c) => c.id === OTHER);
  if (other < 0) {
    fail(
      '/categories',
      'other_required',
      'The Other category can’t be deleted.',
    );
  } else if (picture[other].name !== 'Other') {
    fail(
      `/categories/${other}/name`,
      'other_fixed',
      'The Other category can’t be renamed.',
    );
  }
  // No id twice, and no name twice ignoring case: categories among categories, themes among
  // themes (A4).
  const seen = new Set<string>();
  const categoryNames = new Map<string, string>();
  const themeNames = new Map<string, string>();
  picture.forEach((c, ci) => {
    const at = `/categories/${ci}`;
    if (seen.has(`c:${c.id}`)) fail(`${at}/id`, 'duplicate', 'Listed twice.');
    seen.add(`c:${c.id}`);
    const clash = categoryNames.get(nameKey(c.name));
    if (clash !== undefined) {
      fail(
        `${at}/name`,
        'duplicate',
        `There is already a category called “${clash}”.`,
      );
    } else categoryNames.set(nameKey(c.name), c.name);
    c.themes.forEach((t, ti) => {
      const tat = `${at}/themes/${ti}`;
      if (seen.has(`t:${t.id}`))
        fail(`${tat}/id`, 'duplicate', 'Listed twice.');
      seen.add(`t:${t.id}`);
      const same = themeNames.get(nameKey(t.name));
      if (same !== undefined) {
        fail(
          `${tat}/name`,
          'duplicate',
          `There is already a theme called “${same}”.`,
        );
      } else themeNames.set(nameKey(t.name), t.name);
    });
  });
  if (errors.length) throw invalid(errors);
  return picture;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (time, then 80 random bits), as SurrealDB's rand::ulid() makes them. */
export function ulid(now = Date.now()): string {
  let time = '';
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) {
    time = CROCKFORD[t % 32] + time;
  }
  const bytes = randomBytes(10);
  let random = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += CROCKFORD[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return time + random;
}

/**
 * The difference between the picture and what the database holds: new rows get ULIDs, every
 * other id must exist (else `400`), and whatever is missing from the picture is deleted.
 */
export function changesFor(
  picture: PictureCategory[],
  current: CurrentThemes,
  newId: () => string = ulid,
): ThemeChanges {
  const errors: FieldError[] = [];
  const categories = new Map(current.categories.map((c) => [c.id, c]));
  const themes = new Map(current.themes.map((t) => [t.id, t]));
  const ids = new Map<string, string>();
  const real = (id: string) => {
    if (!id.startsWith('new-')) return id;
    if (!ids.has(id)) ids.set(id, newId());
    return ids.get(id) as string;
  };
  const changes: ThemeChanges = {
    createCategories: [],
    renameCategories: [],
    createThemes: [],
    updateThemes: [],
    deleteThemes: [],
    deleteCategories: [],
  };
  const kept = { categories: new Set<string>(), themes: new Set<string>() };
  picture.forEach((c, ci) => {
    const at = `/categories/${ci}`;
    const id = real(c.id);
    const was = categories.get(id);
    if (c.id.startsWith('new-')) {
      changes.createCategories.push({ id, name: c.name });
    } else if (!was) {
      errors.push({
        pointer: `${at}/id`,
        code: 'not_found',
        message: 'No such category.',
      });
    } else if (was.name !== c.name) {
      changes.renameCategories.push({ id, name: c.name });
    }
    kept.categories.add(id);
    c.themes.forEach((t, ti) => {
      const themeId = real(t.id);
      const before = themes.get(themeId);
      const write = {
        id: themeId,
        name: t.name,
        category: id,
        highlighted: t.highlighted,
      };
      if (t.id.startsWith('new-')) changes.createThemes.push(write);
      else if (!before) {
        errors.push({
          pointer: `${at}/themes/${ti}/id`,
          code: 'not_found',
          message: 'No such theme.',
        });
      } else if (
        before.name !== write.name ||
        before.category !== write.category ||
        before.highlighted !== write.highlighted
      ) {
        changes.updateThemes.push(write);
      }
      kept.themes.add(themeId);
    });
  });
  if (errors.length) throw invalid(errors);
  changes.deleteThemes = current.themes
    .map((t) => t.id)
    .filter((id) => !kept.themes.has(id));
  changes.deleteCategories = current.categories
    .map((c) => c.id)
    .filter((id) => !kept.categories.has(id));
  return changes;
}

// How a list of stories is filtered, defined once (revised OQ-2, Joel 2026-11-19: "same as main
// browser, however have this track filtering behaviour of the main browser if we change it
// there"). The public Stories browse page (api-public-read and web) and the moderators' list
// (api-admin and web) both filter through this file, so a change here changes both.
//
// The rule: one format at a time, and any number of themes stacked (up to THEMES_MAX), each
// optional (any), combined with each other and with the list's own search (a story must pass
// every one). Stacked themes mean "every chosen theme": a story shows only if it carries all of
// them (BS-6 B and BS-7, Joel 2026-11-21). Their order doesn't matter and a repeat counts once.
// An id that isn't a theme (deleted, or never was) filters nothing (themes plan v3, A8); the
// other chosen themes still do.
//
// No dependencies: the services and the browser both import it.

export const STORY_FORMATS = ['video', 'audio', 'written'] as const;
export type StoryFormat = (typeof STORY_FORMATS)[number];

/** What each format is called in a filter. */
export const FORMAT_LABELS: Record<StoryFormat, string> = {
  video: 'Video',
  audio: 'Audio',
  written: 'Written',
};
/** The format filter's "any" choice. */
export const ANY_FORMAT_LABEL = 'All formats';

/** A theme id, as the filters take it. */
export const THEME_ID = /^[0-9A-Za-z_]{1,40}$/;
/** At most this many themes stacked in one request (BS-6 B, Joel 2026-11-21). */
export const THEMES_MAX = 10;

export interface StoryFilters {
  /**
   * Theme ids, unique and sorted: only stories that carry every one. Empty = any theme.
   */
  themes: string[];
  /** One format: only stories of it. `null` = any. */
  format: StoryFormat | null;
}

export interface StoryFilterError {
  pointer: '/theme' | '/format';
  code: 'invalid';
  message: string;
}

const isFormat = (v: unknown): v is StoryFormat =>
  (STORY_FORMATS as readonly unknown[]).includes(v);

/** Unique and sorted: the same themes in any order, or repeated, are the same filter. */
const uniqueSorted = (ids: readonly string[]) => [...new Set(ids)].sort();

/**
 * An API's check of the filters: the themes as the list of values the query string gave (`theme`
 * repeated, or none), the format at most once (the service refuses a repeat in its own way).
 * Anything else is an error to answer with a `400`. Errors never echo the value.
 */
export function checkStoryFilters(given: {
  themes?: readonly string[];
  format?: string;
}): {
  filters: StoryFilters;
  errors: StoryFilterError[];
} {
  const errors: StoryFilterError[] = [];
  const themes = uniqueSorted(given.themes ?? []);
  if (!themes.every((id) => THEME_ID.test(id)))
    errors.push({
      pointer: '/theme',
      code: 'invalid',
      message: 'A theme id: letters, digits and underscores.',
    });
  else if (themes.length > THEMES_MAX)
    errors.push({
      pointer: '/theme',
      code: 'invalid',
      message: `At most ${THEMES_MAX} themes.`,
    });
  const format = given.format ?? null;
  if (format !== null && !isFormat(format))
    errors.push({
      pointer: '/format',
      code: 'invalid',
      message: `One of ${STORY_FORMATS.join(', ')}.`,
    });
  return {
    filters: { themes, format: format as StoryFormat | null },
    errors,
  };
}

/**
 * A page's filters from its address (`theme` once, repeated, or not at all): anything the API
 * would refuse is dropped, and themes past THEMES_MAX are left out.
 */
export function sanitizeStoryFilters(given: {
  theme?: unknown;
  format?: unknown;
}): StoryFilters {
  const one = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const list = Array.isArray(given.theme) ? given.theme : [given.theme];
  const format = one(given.format);
  return {
    themes: uniqueSorted(
      list.filter(
        (v): v is string => typeof v === 'string' && THEME_ID.test(v),
      ),
    ).slice(0, THEMES_MAX),
    format: isFormat(format) ? format : null,
  };
}

/**
 * Each theme turns on and off on its own (BS-6 B): a chosen one is taken off, another is added
 * (not past THEMES_MAX).
 */
export function toggleTheme<F extends { themes: string[] }>(
  filters: F,
  id: string,
): F {
  const themes = filters.themes.includes(id)
    ? filters.themes.filter((t) => t !== id)
    : filters.themes.length < THEMES_MAX
      ? uniqueSorted([...filters.themes, id])
      : filters.themes;
  return { ...filters, themes };
}

/**
 * SurrealQL, run before `storyFiltersWhere`: `$ths` is the chosen themes that are themes (an id
 * that isn't one filters nothing). Bind `$themes` (a list, empty for any) and `$format` (NONE for
 * any).
 */
export const STORY_FILTERS_LET = `LET $ths = ($themes ?? []).filter(|$t| record::exists(type::record('theme', $t)));`;

/**
 * SurrealQL: the condition a story passes. `s` is the path to the story's fields (`story.` from a
 * status entry, empty on the story or a row carrying its `primaryFormat` and `themeIds`).
 * `format: false` leaves the format out (counting stories by format). themeIds, not themeRefs:
 * 3.2.4's CONTAINS over an element index on record links finds nothing (docs/system/data-engine.md,
 * "SurrealDB 3.2.4 gotchas").
 */
export function storyFiltersWhere(
  s = '',
  { format = true }: { format?: boolean } = {},
): string {
  const theme = `(array::len($ths) = 0 OR ${s}themeIds CONTAINSALL $ths)`;
  return format
    ? `($format = NONE OR ${s}primaryFormat = $format) AND ${theme}`
    : theme;
}

// How a list of stories is filtered, defined once (revised OQ-2, Joel 2026-11-19: "same as main
// browser, however have this track filtering behaviour of the main browser if we change it
// there"). The public Stories browse page (api-public-read and web) and the moderators' list
// (api-admin and web) both filter through this file, so a change here changes both.
//
// The rule: one format and one theme at a time, each optional (any), combined with each other
// and with the list's own search (a story must pass every one). An id that isn't a theme
// (deleted, or never was) filters nothing (themes plan v3, A8).
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

export interface StoryFilters {
  /** One theme's id: only stories that carry it. `null` = any. */
  theme: string | null;
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

/**
 * An API's check of the filters, each given at most once (the service refuses a repeat in its
 * own way): anything else is an error to answer with a `400`. Errors never echo the value.
 */
export function checkStoryFilters(given: { theme?: string; format?: string }): {
  filters: StoryFilters;
  errors: StoryFilterError[];
} {
  const errors: StoryFilterError[] = [];
  const theme = given.theme ?? null;
  if (theme !== null && !THEME_ID.test(theme))
    errors.push({
      pointer: '/theme',
      code: 'invalid',
      message: 'A theme id: letters, digits and underscores.',
    });
  const format = given.format ?? null;
  if (format !== null && !isFormat(format))
    errors.push({
      pointer: '/format',
      code: 'invalid',
      message: `One of ${STORY_FORMATS.join(', ')}.`,
    });
  return {
    filters: { theme, format: format as StoryFormat | null },
    errors,
  };
}

/** A page's filters from its address: anything the API would refuse is dropped. */
export function sanitizeStoryFilters(given: {
  theme?: unknown;
  format?: unknown;
}): StoryFilters {
  const one = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const theme = one(given.theme);
  const format = one(given.format);
  return {
    theme: theme && THEME_ID.test(theme) ? theme : null,
    format: isFormat(format) ? format : null,
  };
}

/** Choosing the theme that's chosen clears it; another replaces it. */
export function toggleTheme<F extends { theme: string | null }>(
  filters: F,
  id: string,
): F {
  return { ...filters, theme: filters.theme === id ? null : id };
}

/**
 * SurrealQL, run before `storyFiltersWhere`: `$th` is the theme to filter by, or NONE when none
 * was asked or it isn't a theme. Bind `$theme` and `$format` (NONE for any).
 */
export const STORY_FILTERS_LET = `LET $th = IF $theme != NONE AND record::exists(type::record('theme', $theme)) { $theme };`;

/**
 * SurrealQL: the condition a story passes. `s` is the path to the story's fields (`story.` from a
 * status entry, empty on the story or a row carrying its `primaryFormat` and `themeIds`).
 * `format: false` leaves the format out (counting stories by format). themeIds, not themeRefs:
 * 3.2.4's CONTAINS over an element index on record links finds nothing (docs/db-permissions.md,
 * "SurrealDB 3.2.4 gotchas").
 */
export function storyFiltersWhere(
  s = '',
  { format = true }: { format?: boolean } = {},
): string {
  const theme = `($th = NONE OR ${s}themeIds CONTAINS $th)`;
  return format
    ? `($format = NONE OR ${s}primaryFormat = $format) AND ${theme}`
    : theme;
}

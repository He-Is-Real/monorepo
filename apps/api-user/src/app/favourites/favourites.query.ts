import { HttpStatus } from '@nestjs/common';
import { type FieldError, ProblemException } from '@heisreal/http';

/** What `GET /v1/account/favourites` was asked for (api-user.yaml). */
export type FavouritesQuery =
  | {
      kind: 'page';
      limit: number;
      /** The last heart of the previous page: its time as SurrealDB wrote it, and its id. */
      after: { at: string; id: string } | null;
    }
  /** "Which of these are my favourites?": the ids of a page of cards (D83). */
  | { kind: 'among'; storyIds: string[] };

export const LIMIT = { default: 20, max: 50 } as const;
/** At most this many ids in one "which of these" lookup (a page of cards). */
export const MAX_STORY_IDS = 50;
/** A record id as the APIs give them out (opaque to clients, but never anything else). */
export const RECORD_ID = /^[A-Za-z0-9_]{1,64}$/;
const KNOWN = new Set(['storyId', 'limit', 'cursor']);
const CURSOR_MAX_CHARS = 200;
// SurrealDB's own datetime text: UTC, up to nanoseconds.
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const invalid = (errors: FieldError[]) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    errors,
  );

const invalidCursor = () =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'invalid_cursor',
    'Invalid cursor',
    'Start again without a cursor: it is from another list, or it was changed.',
    [
      {
        pointer: '/cursor',
        code: 'invalid_cursor',
        message: 'Not a cursor for this list.',
      },
    ],
  );

/**
 * Parses the query string strictly: unknown parameters, malformed values and `storyId` mixed with
 * paging are `400`s (never echoing the value), so nothing unchecked reaches the database.
 */
export function parseFavouritesQuery(
  query: Record<string, unknown>,
): FavouritesQuery {
  const unknown = Object.keys(query).filter((k) => !KNOWN.has(k));
  if (unknown.length)
    throw invalid(
      unknown.map((name) => ({
        pointer: `/${name.slice(0, 40).replace(/~/g, '~0').replace(/\//g, '~1')}`,
        code: 'unknown_parameter',
        message: 'Not a parameter of this list.',
      })),
    );

  if (query['storyId'] !== undefined) {
    if (query['limit'] !== undefined || query['cursor'] !== undefined)
      throw invalid([
        {
          pointer: '/storyId',
          code: 'not_with_paging',
          message:
            'Ask about some stories, or page through the list: not both.',
        },
      ]);
    const raw = query['storyId'];
    const ids = Array.isArray(raw) ? raw : [raw];
    if (
      ids.length < 1 ||
      ids.length > MAX_STORY_IDS ||
      !ids.every((id) => typeof id === 'string' && RECORD_ID.test(id))
    )
      throw invalid([
        {
          pointer: '/storyId',
          code: 'invalid',
          message: `From 1 to ${MAX_STORY_IDS} story ids.`,
        },
      ]);
    return { kind: 'among', storyIds: [...new Set(ids as string[])] };
  }

  let limit: number = LIMIT.default;
  const rawLimit = query['limit'];
  if (rawLimit !== undefined) {
    limit =
      typeof rawLimit === 'string' && /^\d{1,3}$/.test(rawLimit)
        ? Number(rawLimit)
        : NaN;
    if (!(limit >= 1 && limit <= LIMIT.max))
      throw invalid([
        {
          pointer: '/limit',
          code: 'out_of_range',
          message: `A whole number from 1 to ${LIMIT.max}.`,
        },
      ]);
  }
  const cursor = query['cursor'];
  if (cursor === undefined) return { kind: 'page', limit, after: null };
  if (typeof cursor !== 'string') throw invalidCursor();
  return { kind: 'page', limit, after: decodeCursor(cursor) };
}

/**
 * The cursor for the page after the heart made at `at` (as SurrealDB wrote it) with id `id`.
 * Not signed: it holds only a position in the person's own list, which the database reads in
 * their own session, so a changed cursor can only start their own list somewhere else.
 */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: [at, id] })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { at: string; id: string } {
  if (cursor.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const c = decoded as { v?: unknown; k?: unknown } | null;
  if (
    !c ||
    typeof c !== 'object' ||
    Object.keys(c).length !== 2 ||
    c.v !== 1 ||
    !Array.isArray(c.k) ||
    c.k.length !== 2
  )
    throw invalidCursor();
  const [at, id] = c.k as unknown[];
  if (
    typeof at !== 'string' ||
    !isDateTime(at) ||
    typeof id !== 'string' ||
    !RECORD_ID.test(id)
  )
    throw invalidCursor();
  return { at, id };
}

/**
 * A real UTC date and time at SurrealDB's precision. The database casts it, so anything it would
 * refuse (31 February, 24:00) must be a `400` here, never a `500` there.
 */
function isDateTime(text: string): boolean {
  if (!DATETIME.test(text)) return false;
  const parsed = new Date(text);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() >= 1970 &&
    parsed.toISOString().slice(0, 19) === text.slice(0, 19)
  );
}

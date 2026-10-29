import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { type FieldError, ProblemException } from '@heisreal/http';
import { CborCodec } from 'surrealdb';

// `GET /v1/stories` parameters (api-public-read.yaml, browseStories). Every one is bounded, and
// unknown or repeated parameters are refused: fewer cache keys, no silent typos. Errors never
// echo what was sent. Values only ever reach SurrealQL as bound parameters.

export type Sort = 'latest' | 'oldest' | 'relevance';
export type StoryFormat = 'video' | 'audio' | 'written';

/** The position after the last card of a page: its sort key, then its id (a total order). */
export interface CursorKey {
  /** `publishedAt` as SurrealDB writes it (latest/oldest), or the BM25 score (relevance). */
  key: string | number;
  /** The story's id, without the table. */
  id: string;
}

export interface BrowseQuery {
  /** Full-text search, trimmed; `null` = no search. */
  q: string | null;
  /** Tag slugs, sorted and unique; a story must have all of them. */
  tags: string[];
  format: StoryFormat | null;
  sort: Sort;
  limit: number;
  after: CursorKey | null;
  /**
   * Only these stories (ids, unique), on their own: the cards for hearts kept on a device
   * (M2). `null` = the normal list.
   */
  ids: string[] | null;
}

export const LIMIT = { default: 20, max: 50 } as const;
export const Q_MAX_CHARS = 200;
export const TAGS_MAX = 5;
export const CURSOR_MAX_CHARS = 300;
/** At most this many ids in one `id` lookup. */
export const IDS_MAX = 50;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 60;
const SORTS: readonly Sort[] = ['latest', 'oldest', 'relevance'];
const FORMATS: readonly StoryFormat[] = ['video', 'audio', 'written'];
const KNOWN = new Set(['q', 'tag', 'format', 'sort', 'limit', 'cursor', 'id']);
const ID = /^[A-Za-z0-9_]{1,64}$/;
// SurrealDB's own datetime text: UTC, up to nanoseconds.
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

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

/** For routes that take no query parameters: any is a `400`. */
export function refuseQueryParameters(query: Record<string, unknown>): void {
  const names = Object.keys(query);
  if (names.length > 0)
    throw invalid(
      names.map((n) => ({
        pointer: `/${pointerName(n)}`,
        code: 'unknown_parameter',
        message: 'This route takes no query parameters.',
      })),
    );
}

/** Validates the query string Express parsed (strings, or arrays of strings when repeated). */
export function parseBrowseQuery(query: Record<string, unknown>): BrowseQuery {
  const errors: FieldError[] = [];
  const fail = (name: string, code: string, message: string) =>
    errors.push({ pointer: `/${name}`, code, message });
  for (const name of Object.keys(query))
    if (!KNOWN.has(name))
      errors.push({
        pointer: `/${pointerName(name)}`,
        code: 'unknown_parameter',
        message: 'Unknown parameter.',
      });

  /** One value: a repeat or a nested object is an error. */
  const single = (name: string): string | undefined => {
    const v = query[name];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') {
      fail(name, 'not_single', 'Give this parameter once.');
      return undefined;
    }
    return v;
  };

  let q: string | null = single('q')?.trim() || null;
  if (q !== null && [...q].length > Q_MAX_CHARS) {
    fail('q', 'too_long', `At most ${Q_MAX_CHARS} characters.`);
    q = null;
  }

  const rawTags = query['tag'];
  const tagList =
    rawTags === undefined
      ? []
      : typeof rawTags === 'string'
        ? [rawTags]
        : Array.isArray(rawTags) && rawTags.every((t) => typeof t === 'string')
          ? (rawTags as string[])
          : null;
  const tags = [...new Set(tagList ?? [])].sort();
  if (tagList === null) fail('tag', 'invalid', 'Tag slugs only.');
  else if (tags.some((t) => !SLUG.test(t) || t.length > SLUG_MAX))
    fail('tag', 'invalid', 'Tag slugs: lowercase letters, digits and hyphens.');
  else if (tags.length > TAGS_MAX)
    fail('tag', 'too_many', `At most ${TAGS_MAX} tags.`);

  const format = single('format') ?? null;
  if (format !== null && !FORMATS.includes(format as StoryFormat))
    fail('format', 'invalid', `One of ${FORMATS.join(', ')}.`);

  const sort = single('sort') ?? (q ? 'relevance' : 'latest');
  if (!SORTS.includes(sort as Sort))
    fail('sort', 'invalid', `One of ${SORTS.join(', ')}.`);
  else if (sort === 'relevance' && !q)
    fail('sort', 'needs_q', 'Sorting by relevance needs a search (q).');

  const rawLimit = single('limit');
  let limit: number = LIMIT.default;
  if (rawLimit !== undefined) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!(limit >= 1 && limit <= LIMIT.max))
      fail('limit', 'out_of_range', `A whole number from 1 to ${LIMIT.max}.`);
  }

  const cursor = single('cursor');
  if (cursor !== undefined && cursor.length > CURSOR_MAX_CHARS)
    fail('cursor', 'too_long', 'Not a cursor from this API.');

  // Cards by id, for hearts kept on a device: on their own, never with filters or paging.
  let ids: string[] | null = null;
  const rawIds = query['id'];
  if (rawIds !== undefined) {
    const list = typeof rawIds === 'string' ? [rawIds] : rawIds;
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > IDS_MAX ||
      !list.every((id) => typeof id === 'string' && ID.test(id))
    )
      fail('id', 'invalid', `From 1 to ${IDS_MAX} story ids.`);
    else if (Object.keys(query).some((name) => name !== 'id'))
      fail(
        'id',
        'alone',
        'Give story ids on their own, without other parameters.',
      );
    else ids = [...new Set(list as string[])];
  }

  if (errors.length > 0) throw invalid(errors);
  const parsed: BrowseQuery = {
    q,
    tags,
    format: format as StoryFormat | null,
    sort: sort as Sort,
    limit,
    after: null,
    ids,
  };
  if (cursor !== undefined) parsed.after = decodeCursor(parsed, cursor);
  return parsed;
}

/**
 * An opaque cursor for the page after `last`, valid only with the same filters and sort.
 *
 * Not signed, on purpose. A cursor holds only a position in the list (a sort key and an id). The
 * filters come from the query string every time; the fingerprint only refuses a mix-up, and the
 * database applies them. Every field is validated strictly, so a changed cursor is a `400`, and a
 * forged but valid one can only start the same public, published list at another point.
 */
export function encodeCursor(query: BrowseQuery, last: CursorKey): string {
  return Buffer.from(
    JSON.stringify({ v: 1, f: fingerprint(query), k: [last.key, last.id] }),
  ).toString('base64url');
}

function decodeCursor(query: BrowseQuery, cursor: string): CursorKey {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const c = decoded as { v?: unknown; f?: unknown; k?: unknown };
  if (
    !c ||
    c.v !== 1 ||
    c.f !== fingerprint(query) ||
    !Array.isArray(c.k) ||
    c.k.length !== 2
  )
    throw invalidCursor();
  const [key, id] = c.k as unknown[];
  // BM25 scores are small fractions. Above 2^53 every number is a whole one that surrealdb.js's
  // CBOR encoder refuses ("Number too big"), so a score is at most MAX_SAFE_INTEGER.
  const keyOk =
    query.sort === 'relevance'
      ? typeof key === 'number' && key >= 0 && key <= Number.MAX_SAFE_INTEGER
      : typeof key === 'string' && isDateTime(key);
  if (
    Object.keys(c).length !== 3 ||
    !keyOk ||
    typeof id !== 'string' ||
    !ID.test(id)
  )
    throw invalidCursor();
  const after = { key: key as string | number, id };
  // The position is bound as a query parameter. Anything the database driver can't send would be
  // a 500 there, so check it with the driver's own encoder here (defence in depth).
  try {
    CborCodec.DEFAULT.encode(after);
  } catch {
    throw invalidCursor();
  }
  return after;
}

/**
 * A real UTC date and time from 1970 to 9999, at SurrealDB's precision. The database casts it, so
 * anything it would refuse (31 February, 24:00) must be a `400` here, never a `500` there.
 */
function isDateTime(text: string): boolean {
  const m = DATETIME.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    year >= 1970 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/** What the cursor is bound to: the filters and the sort (not the page size). */
function fingerprint(query: BrowseQuery): string {
  return createHash('sha256')
    .update(JSON.stringify([query.q, query.tags, query.format, query.sort]))
    .digest('base64url')
    .slice(0, 16);
}

/** A parameter's name in a pointer, bounded and escaped (RFC 6901), never the value. */
function pointerName(name: string): string {
  return name.slice(0, 40).replace(/~/g, '~0').replace(/\//g, '~1');
}

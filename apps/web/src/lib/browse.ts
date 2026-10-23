import { apiPublicReadUrl } from './config';
import { type StoryImage, StoriesUnavailableError } from './public-stories';

// D32: web reads from api-public-read only, server-side, with nothing from the visitor's request
// (no cookies, no headers). Anything that holds stories is fetched fresh (D51: `no-store`): Next's
// `revalidate` keeps serving its last copy while a refresh fails, and a `404` never replaces it,
// so a hidden, withdrawn or erased story could stay on the site. Only tags are kept for a minute:
// they hold no story data.

export type StoryFormat = 'video' | 'audio' | 'written';
export type BrowseSort = 'latest' | 'oldest' | 'relevance';

/** `Tag` in libs/contracts/openapi/components.yaml. */
export interface StoryTag {
  slug: string;
  name: string;
  category: 'theme' | 'journey' | 'emotion';
  version: number;
}

/**
 * `StorySummary`: a card. The picture's size (`thumbnailWidth`/`thumbnailHeight` or `image`) and
 * the `excerpt` are what the masonry predicts its height from (D55).
 */
export interface StorySummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  bylineName: string | null;
  primaryFormat: StoryFormat;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  image: StoryImage | null;
  textLength: number;
  tags: StoryTag[];
  publishedAt: string;
}

export interface StoryPage {
  data: StorySummary[];
  /** The next page's cursor; `null` on the last page. */
  nextCursor: string | null;
}

export interface BrowseParams {
  /** A visitor's search; trimmed, and cut to the API's 200 characters. */
  q?: string;
  /** A story must have all of them (at most 5 are sent). */
  tags?: string[];
  format?: StoryFormat;
  sort?: BrowseSort;
  /** 1 to 50 (the API's default is 20). */
  limit?: number;
  cursor?: string;
}

export type RelatedResult =
  { kind: 'stories'; stories: StorySummary[] } | { kind: 'not_found' };

/** Tags only. */
const REVALIDATE_SECONDS = 60;
/** A cold api-public-read (scaled to zero, connecting to the database) can take a few seconds. */
const TIMEOUT_MS = 10_000;
const Q_MAX_CHARS = 200;
const TAGS_MAX = 5;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `GET /v1/stories`: a page of cards. `signal` lets a caller stop early (the sitemap's overall
 * budget, or the request it serves going away); the 10 s timeout applies either way.
 */
export async function browseStories(
  params: BrowseParams = {},
  opts: { signal?: AbortSignal } = {},
): Promise<StoryPage> {
  const query = new URLSearchParams();
  const q = [...(params.q?.trim() ?? '')].slice(0, Q_MAX_CHARS).join('');
  if (q) query.set('q', q);
  for (const tag of (params.tags ?? []).slice(0, TAGS_MAX))
    query.append('tag', tag);
  if (params.format) query.set('format', params.format);
  if (params.sort) query.set('sort', params.sort);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  const search = query.size ? `?${query}` : '';
  const res = await get(`/v1/stories${search}`, {
    cached: false,
    signal: opts.signal,
  });
  const body = await json(res);
  if (!isPage(body)) throw new StoriesUnavailableError('unexpected response');
  return body;
}

/** `GET /v1/stories/{slug}/related`: the story page's related cards. */
export async function getRelatedStories(slug: string): Promise<RelatedResult> {
  if (!SLUG.test(slug) || slug.length > 200) return { kind: 'not_found' };
  const res = await get(`/v1/stories/${slug}/related`, {
    cached: false,
    notFound: true,
  });
  if (res.status === 404) return { kind: 'not_found' };
  const body = (await json(res)) as { data?: unknown } | undefined;
  if (!Array.isArray(body?.data) || !body.data.every(isSummary))
    throw new StoriesUnavailableError('unexpected response');
  return { kind: 'stories', stories: body.data };
}

/**
 * `GET /v1/tags`: the tags published stories use (D63), by category (theme, journey, emotion)
 * then name. No counts (D62).
 */
export async function listTags(): Promise<StoryTag[]> {
  const body = (await json(await get('/v1/tags', { cached: true }))) as
    { data?: unknown } | undefined;
  if (!Array.isArray(body?.data) || !body.data.every(isTag))
    throw new StoriesUnavailableError('unexpected response');
  return body.data;
}

async function get(
  path: string,
  opts: { cached: boolean; notFound?: boolean; signal?: AbortSignal },
): Promise<Response> {
  let res: Response;
  try {
    const url = `${apiPublicReadUrl()}${path}`;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = opts.signal
      ? AbortSignal.any([timeout, opts.signal])
      : timeout;
    res = opts.cached
      ? await fetch(url, {
          headers: { accept: 'application/json' },
          next: { revalidate: REVALIDATE_SECONDS },
          signal,
        })
      : await fetch(url, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal,
        });
  } catch (err) {
    throw new StoriesUnavailableError(
      err instanceof Error ? err.name : 'network error',
    );
  }
  if (res.ok || (opts.notFound && res.status === 404)) return res;
  throw new StoriesUnavailableError(`status ${res.status}`);
}

const json = (res: Response): Promise<unknown> =>
  res.json().catch(() => undefined);

const nullableNumber = (v: unknown) => v === null || typeof v === 'number';

function isTag(value: unknown): value is StoryTag {
  const t = value as Partial<StoryTag> | null;
  return (
    !!t &&
    typeof t.slug === 'string' &&
    typeof t.name === 'string' &&
    typeof t.category === 'string'
  );
}

function isSummary(value: unknown): value is StorySummary {
  const s = value as Partial<StorySummary> | null;
  return (
    !!s &&
    typeof s.slug === 'string' &&
    typeof s.title === 'string' &&
    typeof s.excerpt === 'string' &&
    typeof s.primaryFormat === 'string' &&
    nullableNumber(s.durationSeconds) &&
    nullableNumber(s.thumbnailWidth) &&
    nullableNumber(s.thumbnailHeight) &&
    (s.image === null ||
      (typeof s.image?.width === 'number' &&
        typeof s.image?.height === 'number')) &&
    typeof s.textLength === 'number' &&
    Array.isArray(s.tags) &&
    s.tags.every(isTag) &&
    typeof s.publishedAt === 'string'
  );
}

function isPage(value: unknown): value is StoryPage {
  const p = value as Partial<StoryPage> | null;
  return (
    !!p &&
    Array.isArray(p.data) &&
    p.data.every(isSummary) &&
    (p.nextCursor === null || typeof p.nextCursor === 'string')
  );
}

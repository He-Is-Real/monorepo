import { apiPublicReadUrl, serverNow } from './config';
import { type StoryImage, StoriesUnavailableError } from './public-stories';

// D32: web reads from api-public-read only, server-side, with nothing from the visitor's request
// (no cookies, no headers). Anything that holds stories is fetched fresh (D51: `no-store`): Next's
// `revalidate` keeps serving its last copy while a refresh fails, and a `404` never replaces it,
// so a hidden, withdrawn or erased story could stay on the site. Only themes are kept for a
// minute: they hold no story data.

export type StoryFormat = 'video' | 'audio' | 'written';
export type BrowseSort = 'latest' | 'oldest' | 'relevance';

/** `ThemeRef` in libs/contracts/openapi/components.yaml: a story's theme. */
export interface ThemeRef {
  id: string;
  name: string;
}

/** `Theme`: one in the list people choose from. */
export interface Theme extends ThemeRef {
  highlighted: boolean;
}

/** `ThemeCategory`: themes A–Z; categories A–Z with Other last (themes plan v3). */
export interface ThemeCategory {
  id: string;
  name: string;
  themes: Theme[];
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
  themes: ThemeRef[];
  publishedAt: string;
  /**
   * web's own, not the API's: whether the card says NEW (`isNewStory`), judged by web's server
   * when it fetched the card.
   */
  isNew: boolean;
}

/** D72: a story is new for 7 days after it's published. */
export const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * D72: "NEW" on a card while its story was published less than 7 days ago. Nothing is stored
 * per person. Only web's server decides, against its own clock, when it fetches the cards (the
 * browser never re-computes it, so hydration can't disagree and a visitor's wrong clock changes
 * nothing). A page served from a cache shows the badge as it was when it was rendered.
 */
export function isNewStory(publishedAt: string, now: number): boolean {
  const published = Date.parse(publishedAt);
  return Number.isFinite(published) && now - published < NEW_FOR_MS;
}

/** A card as the API sends it. */
export type ApiSummary = Omit<StorySummary, 'isNew'>;

const withNew = (cards: ApiSummary[]): StorySummary[] => {
  const now = serverNow();
  return cards.map((c) => ({ ...c, isNew: isNewStory(c.publishedAt, now) }));
};

export interface StoryPage {
  data: StorySummary[];
  /** The next page's cursor; `null` on the last page. */
  nextCursor: string | null;
}

export interface BrowseParams {
  /** A visitor's search; trimmed, and cut to the API's 200 characters. */
  q?: string;
  /** A theme id: only stories with it. */
  theme?: string;
  format?: StoryFormat;
  sort?: BrowseSort;
  /** 1 to 50 (the API's default is 20). */
  limit?: number;
  cursor?: string;
}

export type RelatedResult =
  { kind: 'stories'; stories: StorySummary[] } | { kind: 'not_found' };

/** Themes only. */
const REVALIDATE_SECONDS = 60;
/** A cold api-public-read (scaled to zero, connecting to the database) can take a few seconds. */
const TIMEOUT_MS = 10_000;
const Q_MAX_CHARS = 200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A theme's id, as api-public-read.yaml's `theme` parameter. */
export const THEME_ID = /^[0-9A-Za-z_]{1,40}$/;

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
  if (params.theme && THEME_ID.test(params.theme))
    query.set('theme', params.theme);
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
  return { data: withNew(body.data), nextCursor: body.nextCursor };
}

/** A story id as the APIs give them out. */
export const STORY_ID = /^[A-Za-z0-9_]{1,64}$/;
/** At most this many ids in one `id=` lookup (api-public-read.yaml). */
export const MAX_IDS = 50;

/**
 * `GET /v1/stories?id=…`: the cards of the stories among `ids` that are public now, newest
 * first (hearts kept on a device, M2). Anonymous: api-public-read learns which stories, never
 * who asks. At most {@link MAX_IDS} valid ids. Never NEW: these are the person's favourites,
 * shown like the signed-in list, whose cards come from api-user in the browser (D72).
 */
export async function storyCardsByIds(
  ids: readonly string[],
): Promise<StorySummary[]> {
  if (ids.length === 0) return [];
  if (ids.length > MAX_IDS || !ids.every((id) => STORY_ID.test(id)))
    throw new Error('storyCardsByIds: 1 to 50 story ids');
  const query = new URLSearchParams();
  for (const id of ids) query.append('id', id);
  const res = await get(`/v1/stories?${query}`, { cached: false });
  const body = await json(res);
  if (!isPage(body)) throw new StoriesUnavailableError('unexpected response');
  return body.data.map((c) => ({ ...c, isNew: false }));
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
  return { kind: 'stories', stories: withNew(body.data) };
}

/**
 * `GET /v1/themes`: the themes to browse by, by category (themes plan v3). Highlighted themes
 * always; the others once a published story uses them. No counts (D62).
 */
export async function listThemes(): Promise<ThemeCategory[]> {
  const body = (await json(await get('/v1/themes', { cached: true }))) as
    { data?: unknown } | undefined;
  if (!Array.isArray(body?.data) || !body.data.every(isCategory))
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

function isThemeRef(value: unknown): value is ThemeRef {
  const t = value as Partial<ThemeRef> | null;
  return !!t && typeof t.id === 'string' && typeof t.name === 'string';
}

function isCategory(value: unknown): value is ThemeCategory {
  const c = value as Partial<ThemeCategory> | null;
  return (
    !!c &&
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    Array.isArray(c.themes) &&
    c.themes.every(
      (t) => isThemeRef(t) && typeof (t as Theme).highlighted === 'boolean',
    )
  );
}

function isSummary(value: unknown): value is ApiSummary {
  const s = value as Partial<ApiSummary> | null;
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
    Array.isArray(s.themes) &&
    s.themes.every(isThemeRef) &&
    typeof s.publishedAt === 'string'
  );
}

function isPage(
  value: unknown,
): value is { data: ApiSummary[]; nextCursor: string | null } {
  const p = value as Partial<StoryPage> | null;
  return (
    !!p &&
    Array.isArray(p.data) &&
    p.data.every(isSummary) &&
    (p.nextCursor === null || typeof p.nextCursor === 'string')
  );
}

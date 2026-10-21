import { apiPublicReadUrl } from './config';

// D32: web reads stories from api-public-read only, server-side, with nothing from the
// visitor's request (no cookies, no headers): every visitor gets the same page.

/** `StoryPublic` in libs/contracts/openapi/components.yaml. */
export interface PublicStory {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string | null;
  bylineName: string | null;
  primaryFormat: 'video' | 'audio' | 'written';
  tags: { slug: string; name: string }[];
  publishedAt: string;
  version: number;
}

export type StoryResult =
  { kind: 'story'; story: PublicStory } | { kind: 'not_found' };

/** api-public-read couldn't be reached or answered unexpectedly: show a friendly error. */
export class StoriesUnavailableError extends Error {
  constructor(reason: string) {
    super(`api-public-read is unavailable: ${reason}`);
    this.name = 'StoriesUnavailableError';
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A cold api-public-read (scaled to zero, connecting to the database) can take a few seconds. */
const TIMEOUT_MS = 10_000;

function isPublicStory(value: unknown): value is PublicStory {
  const s = value as Partial<PublicStory> | null;
  return (
    !!s &&
    typeof s.slug === 'string' &&
    typeof s.title === 'string' &&
    typeof s.description === 'string' &&
    Array.isArray(s.tags) &&
    typeof s.publishedAt === 'string'
  );
}

/**
 * `GET /v1/stories/{slug}`. An old slug's 301 is followed, so the story's `slug` may differ
 * from the one asked for: the page then redirects to the current one.
 */
export async function getPublicStory(slug: string): Promise<StoryResult> {
  if (!SLUG.test(slug) || slug.length > 200) return { kind: 'not_found' };
  let res: Response;
  try {
    res = await fetch(`${apiPublicReadUrl()}/v1/stories/${slug}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new StoriesUnavailableError(
      err instanceof Error ? err.name : 'network error',
    );
  }
  if (res.status === 404) return { kind: 'not_found' };
  if (!res.ok) throw new StoriesUnavailableError(`status ${res.status}`);
  const body: unknown = await res.json().catch(() => undefined);
  if (!isPublicStory(body))
    throw new StoriesUnavailableError('unexpected response');
  return { kind: 'story', story: body };
}

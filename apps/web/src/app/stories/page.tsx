import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { BrowseFilters } from '@/components/browse/browse-filters';
import { BrowseResults } from '@/components/browse/browse-results';
import { TagFilter } from '@/components/browse/tag-filter';
import {
  browseStories,
  listTags,
  type StorySummary,
  NO_TAGS,
  type StoryTag,
} from '@/lib/browse';
import {
  type BrowseFilters as Filters,
  parseBrowseSearch,
  toBrowseParams,
} from '@/lib/browse-query';
import { logStoriesUnavailable, whenUnavailable } from '@/lib/log';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { pageMetadata } from '@/lib/seo';

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TITLE = 'God Stories';
const INTRO =
  'Honest stories of transformation, healing, and unexpected kindness from everyday people.';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: TITLE, description: INTRO, path: '/stories' });
}

const KINDS = {
  video: 'video stories',
  audio: 'audio stories',
  written: 'written stories',
} as const;

const joinAnd = (names: string[]) =>
  names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** What the list shows, in words (never a count: api-conventions has no totals). */
function summaryOf(filters: Filters, tags: StoryTag[]): string | null {
  const names = filters.tags.map(
    (id) => tags.find((t) => t.id === id)?.name ?? id,
  );
  const kind = filters.format ? KINDS[filters.format] : 'stories';
  const tagged = names.length ? ` tagged ${joinAnd(names)}` : '';
  if (filters.q)
    return `Results for “${filters.q}”${
      filters.format || names.length ? ` in ${kind}${tagged}` : ''
    }`;
  if (filters.format || names.length)
    return `${kind[0].toUpperCase()}${kind.slice(1)}${tagged}`;
  return null;
}

async function loadPages(filters: Filters, pages: number) {
  const cards: StorySummary[] = [];
  let cursor: string | null = null;
  let loaded = 0;
  // Rebuilds what the reader had loaded (`?pages=`), one page after another.
  for (; loaded < pages; loaded++) {
    try {
      const page = await browseStories(
        toBrowseParams(filters, cursor ?? undefined),
      );
      cards.push(...page.data);
      cursor = page.nextCursor;
    } catch (err) {
      if (!(err instanceof StoriesUnavailableError)) throw err;
      logStoriesUnavailable('browse', err);
      if (loaded === 0) return null;
      break;
    }
    if (!cursor) {
      loaded++;
      break;
    }
  }
  return { cards, cursor, loaded };
}

/**
 * Browse (plan 1.2): every published story, newest first, with search, sort, format and tags,
 * in a balanced masonry (D55). Server-rendered from api-public-read (D32) for the URL's filters
 * and page count; BrowseResults loads more.
 */
export default async function BrowsePage({ searchParams }: Props) {
  await connection();
  const { filters, pages } = parseBrowseSearch(await searchParams);
  const [{ tags, main }, result] = await Promise.all([
    listTags().catch(whenUnavailable('browse', NO_TAGS)),
    loadPages(filters, pages),
  ]);
  const summary = summaryOf(filters, tags);
  const filtered = summary !== null;

  return (
    <main
      id="main"
      className="mx-auto w-full max-w-site flex-1 px-4 py-10 sm:px-10 sm:py-14"
    >
      <header className="mb-8 max-w-measure">
        <p className="mb-3 text-sm font-semibold tracking-[0.2em] text-link uppercase">
          Explore
        </p>
        <h1 className="text-4xl leading-tight font-normal sm:text-5xl">
          {TITLE}
        </h1>
        <p className="mt-3 text-lg text-secondary-text">{INTRO}</p>
      </header>

      <div className="border-b border-border pb-6">
        <BrowseFilters filters={filters} />
        <TagFilter tags={tags} main={main} filters={filters} />
      </div>

      {summary && (
        <p className="mt-6 text-sm text-muted-foreground">
          <strong className="font-semibold text-foreground">{summary}</strong>
        </p>
      )}

      <div className="mt-8">
        {result === null ? (
          <p
            role="status"
            className="mx-auto max-w-measure rounded-xl bg-raised px-4 py-6 text-center text-secondary-text"
          >
            Stories can’t be loaded right now. Please try again in a moment.
          </p>
        ) : result.cards.length === 0 ? (
          <div className="mx-auto max-w-measure rounded-xl bg-raised px-4 py-10 text-center">
            <p className="text-lg">
              {filtered
                ? 'No stories match these filters yet.'
                : 'No stories yet.'}
            </p>
            {filtered && (
              <p className="mt-3">
                <Link
                  href="/stories"
                  className="inline-flex min-h-11 items-center font-medium"
                >
                  Clear filters
                </Link>
              </p>
            )}
          </div>
        ) : (
          <BrowseResults
            // New on every server render: the list restarts from these cards (BrowseResults).
            snapshot={randomUUID()}
            filters={filters}
            cards={result.cards}
            nextCursor={result.cursor}
            pagesLoaded={result.loaded}
          />
        )}
      </div>
    </main>
  );
}

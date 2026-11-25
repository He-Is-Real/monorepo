import { randomUUID } from 'node:crypto';
import { TryAgainLaterNotice } from '@/components/errors/try-again-later';
import type { Metadata } from 'next';
import { cacheLife } from 'next/cache';
import {
  BrowseChoices,
  BrowseSearch,
  BrowseSortFormat,
} from '@/components/browse/browse-filters';
import { BrowseResults } from '@/components/browse/browse-results';
import { BrowseView } from '@/components/browse/browse-view';
import { ThemeFilter } from '@/components/browse/theme-filter';
import { browseStories, listThemes, type StorySummary } from '@/lib/browse';
import {
  type BrowseFilters as Filters,
  parseBrowseSearch,
  toBrowseParams,
} from '@/lib/browse-query';
import { logStoriesUnavailable, whenUnavailable } from '@/lib/log';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { RestartingMessage } from '@/components/restarting/restarting-message';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
import { pageMetadata } from '@/lib/seo';
import { Heading, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

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

/** The chosen themes' names: "Hope", "Hope and Healing", "Faith, Hope and Healing". */
const AND = new Intl.ListFormat('en-GB', { type: 'conjunction' });

/** What the list shows, in words (never a count: docs/system/api.md has no totals). */
function summaryOf(filters: Filters, themeNames: string[]): string | null {
  const theme = themeNames.length ? AND.format(themeNames) : undefined;
  const kind = filters.format ? KINDS[filters.format] : 'stories';
  const about = theme ? ` about ${theme}` : '';
  if (filters.q)
    return `Results for “${filters.q}”${
      filters.format || theme ? ` in ${kind}${about}` : ''
    }`;
  if (filters.format) return `${kind[0].toUpperCase()}${kind.slice(1)}${about}`;
  if (theme) return `Showing stories about ${theme}`;
  return null;
}

async function loadPages(filters: Filters, pages: number, keep: boolean) {
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
      // A saved copy is never one missing its stories: the failure isn't kept.
      if (keep || !(err instanceof StoriesUnavailableError)) throw err;
      logStoriesUnavailable('browse', err);
      if (loaded === 0) return err;
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
 * Browse (plan 1.2): every published story, newest first, with search, sort, format and themes,
 * in a balanced masonry (D55). Server-rendered from api-public-read (D32) for the URL's filters
 * and page count; BrowseResults loads more. BrowseView adds "Favourites only".
 */
export default async function BrowsePage({ searchParams }: Props) {
  // Read here, outside the saved copy: each address's filters have their own copy.
  const { filters, pages } = parseBrowseSearch(await searchParams);
  return cachedPage(
    '/stories',
    (life) => savedPage(life, filters, pages),
    () => Browse({ filters, pages, keep: false }),
  );
}

/** A saved copy of one address's list (page-cache.config.ts), never one missing its stories. */
async function savedPage(life: PageCacheLife, filters: Filters, pages: number) {
  'use cache';
  cacheLife(life);
  return Browse({ filters, pages, keep: true });
}

async function Browse({
  filters,
  pages,
  keep,
}: {
  filters: Filters;
  pages: number;
  keep: boolean;
}) {
  const [themes, result] = await Promise.all([
    keep ? listThemes() : listThemes().catch(whenUnavailable('browse', null)),
    loadPages(filters, pages, keep),
  ]);
  const categories = themes ?? [];
  // A theme that's gone (or never was) filters nothing (A8), so it isn't named either.
  // In the address's order.
  const listed = categories.flatMap((c) => c.themes);
  const chosenThemes = filters.themes.flatMap((id) =>
    listed.filter((t) => t.id === id).map((t) => ({ id: t.id, name: t.name })),
  );
  const summary = summaryOf(
    filters,
    chosenThemes.map((t) => t.name),
  );
  const filtered = summary !== null;

  return (
    <main
      id="main"
      // The screen's full width (BS-8 B, Joel 2026-11-21): BrowseView caps and centres the
      // heading, filters and stories in it (browse-view.tsx). Uncapped here so its rem thresholds
      // are reached at any text size (at the browser's Large text, 20 px, a cap of the site's
      // width plus rem never reached them).
      className="w-full flex-1 px-4 py-10 sm:px-10 sm:py-14"
    >
      <BrowseChoices filters={filters}>
        <BrowseView
          heading={
            <header className="mb-8 max-w-measure">
              <Heading as="p" size="eyebrow" className="mb-3">
                Explore
              </Heading>
              <Heading level={1}>{TITLE}</Heading>
              <Text size="intro" tone="quiet" className="mt-3">
                {INTRO}
              </Text>
            </header>
          }
          query={filters}
          themeIds={themes && themes.flatMap((c) => c.themes.map((t) => t.id))}
          chosenThemes={chosenThemes}
          search={<BrowseSearch filters={filters} />}
          panel={
            <>
              <BrowseSortFormat filters={filters} />
              {categories.length > 0 && (
                <section aria-labelledby="browse-themes">
                  <Heading
                    level={2}
                    size="small"
                    id="browse-themes"
                    className="mb-2 block"
                  >
                    Themes
                  </Heading>
                  <ThemeFilter
                    categories={categories}
                    filters={filters}
                    className="mt-0"
                  />
                </section>
              )}
            </>
          }
          summary={
            summary && (
              <Text size="small" tone="normal" className="mt-6">
                <strong>{summary}</strong>
              </Text>
            )
          }
          results={
            result instanceof StoriesUnavailableError &&
            result.restartingSeconds !== undefined ? (
              <RestartingMessage
                seconds={result.restartingSeconds}
                variant="inline"
              />
            ) : result instanceof StoriesUnavailableError ? (
              <TryAgainLaterNotice
                role="status"
                className="mx-auto max-w-measure"
              />
            ) : result.cards.length === 0 ? (
              <div className="mx-auto max-w-measure rounded-xl bg-raised px-4 py-10 text-center">
                <Text size="intro">
                  {/* A highlighted theme no story uses yet says so plainly (A14); stacked
                      themes that no story carries together are filters that match nothing. */}
                  {filters.q || filters.format || chosenThemes.length > 1
                    ? 'No stories match these filters yet.'
                    : 'No stories yet.'}
                </Text>
                {filtered && (
                  <p className="mt-3">
                    <TextLink href="/stories" kind="standalone">
                      Clear filters
                    </TextLink>
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
            )
          }
        />
      </BrowseChoices>
    </main>
  );
}

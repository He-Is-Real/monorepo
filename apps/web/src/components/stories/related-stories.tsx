import Image from 'next/image';
import Link from 'next/link';
import type { StorySummary } from '@/lib/browse';
import { cardLabel, NewBadge, StoryCard } from './story-card';

/**
 * The story page's related stories (GET /v1/stories/{slug}/related: 3 cards), below the story,
 * never beside it (Joel, 2026-10-25). Below 1024 px a small list in the reading column, as it
 * always was on phones; from 1024 px a row of the site's story cards (home's: uniform 16:10
 * media, play in place), in the story's media band. Each layout is hidden at the other's
 * widths (display: none), so only one is ever read or focused.
 */
export function RelatedStories({ stories }: { stories: StorySummary[] }) {
  if (stories.length === 0) return null;
  return (
    <section
      aria-labelledby="related"
      className="mx-auto max-w-measure rounded-2xl border border-border bg-card p-5 lg:max-w-narrow lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
    >
      <h2
        id="related"
        className="mb-3 text-sm font-semibold text-secondary-text lg:mb-5"
      >
        Related stories
      </h2>
      <ul className="space-y-1 lg:hidden">
        {stories.map((s) => {
          const picture = s.thumbnailUrl ?? s.image?.url ?? null;
          return (
            <li key={s.id}>
              <Link
                href={`/stories/${s.slug}`}
                // No prefetch: a story's page signs its media links (D52) only when opened.
                prefetch={false}
                className="-mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 text-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                <span
                  aria-hidden="true"
                  className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface text-xs text-faint"
                >
                  {picture ? (
                    <Image
                      src={picture}
                      alt=""
                      width={112}
                      height={80}
                      unoptimized
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : s.primaryFormat === 'written' ? (
                    <span className="font-semibold text-link">Aa</span>
                  ) : (
                    '▶'
                  )}
                </span>
                <span className="min-w-0">
                  <span className="line-clamp-2 text-sm font-semibold">
                    {s.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {s.isNew && <NewBadge />}
                    {cardLabel(s)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <ul className="hidden grid-cols-3 gap-6 lg:grid">
        {stories.map((s) => (
          <li key={s.id}>
            <StoryCard story={s} uniform />
          </li>
        ))}
      </ul>
    </section>
  );
}

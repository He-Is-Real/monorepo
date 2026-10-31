import Image from 'next/image';
import Link from 'next/link';
import type { StorySummary } from '@/lib/browse';
import { cardLabel, cardMedia, NewBadge, StoryCard } from './story-card';

/** The small list's picture slot, in px: each picture fits inside it at its own shape. */
const THUMB = { width: 64, height: 80 } as const;

/**
 * The story page's related stories (GET /v1/stories/{slug}/related: 3 cards), below the story,
 * never beside it (Joel, 2026-10-25). Below 1024 px a small list in the reading column, as it
 * always was on phones; from 1024 px a row of the site's story cards (browse's: each picture at
 * its own clamped shape, D53, play in place), in the story's media band. Each layout is hidden
 * at the other's widths (display: none), so only one is ever read or focused.
 *
 * Every preview keeps its shape (Joel, 2026-10-31: all were cropped to one 16:10 strip, and a
 * 9:16 clip played in a wide black box). The row is one card per column, so it lines up the
 * cards at the top (with 3 cards that is all browse's masonry would do); a 9:16 clip plays in
 * its own tall box. The list fits each picture into the same 64 × 80 slot, so the titles still
 * line up.
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
          const media = cardMedia(s);
          const picture = media?.src ?? null;
          // Full width for shapes wider than the slot's 4:5, full height for taller ones.
          const wide = (media?.aspect ?? 1) >= THUMB.width / THUMB.height;
          return (
            <li key={s.id}>
              <Link
                href={`/stories/${s.slug}`}
                // No prefetch: a story's page signs its media links (D52) only when opened.
                prefetch={false}
                className="-mx-2 flex min-h-14 flex-wrap items-center gap-3 rounded-lg px-2 py-2 text-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                <span
                  aria-hidden="true"
                  className="flex shrink-0 items-center justify-center"
                  style={THUMB}
                >
                  {media && picture ? (
                    <span
                      data-related-picture=""
                      className={`block overflow-hidden rounded-md bg-surface ${wide ? 'w-full' : 'h-full'}`}
                      style={{ aspectRatio: String(media.aspect) }}
                    >
                      <Image
                        src={picture}
                        alt=""
                        width={media.width ?? 640}
                        height={media.height ?? 400}
                        unoptimized
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </span>
                  ) : (
                    <span className="flex h-10 w-full items-center justify-center rounded-md bg-surface text-xs text-faint">
                      {s.primaryFormat === 'written' ? (
                        <span className="font-semibold text-link">Aa</span>
                      ) : (
                        '▶'
                      )}
                    </span>
                  )}
                </span>
                {/* Beside the thumbnail; under it once the column would be under 8rem (large
                    text), so the title and badge always fit the box. */}
                <span className="min-w-0 flex-1 basis-32">
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
      <ul className="hidden grid-cols-3 items-start gap-6 lg:grid">
        {stories.map((s) => (
          <li key={s.id}>
            <StoryCard story={s} />
          </li>
        ))}
      </ul>
    </section>
  );
}

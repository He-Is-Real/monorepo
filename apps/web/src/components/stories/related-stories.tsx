import Image from 'next/image';
import Link from 'next/link';
import type { StorySummary } from '@/lib/browse';
import { cardLabel } from '@/lib/card-label';
import { cardMedia, NewBadge, StoryCard } from './story-card';
import { Card, Heading, Text } from '@heisreal/web-ui';

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
    <Card
      asChild
      className="mx-auto max-w-measure p-5 lg:max-w-narrow lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
    >
      <section aria-labelledby="related">
        <Heading level={2} size="small" id="related" className="mb-3 lg:mb-5">
          Related stories
        </Heading>
        <ul className="space-y-1 lg:hidden">
          {stories.map((s) => {
            const media = cardMedia(s);
            const picture = media?.src ?? null;
            // Full width for shapes wider than the slot's 4:5, full height for taller ones.
            const wide = (media?.aspect ?? 1) >= THUMB.width / THUMB.height;
            return (
              <li key={s.id}>
                <Text asChild size="inherit" tone="normal">
                  <Link
                    href={`/stories/${s.slug}`}
                    // No prefetch: a story's page signs its media links (D52) only when opened.
                    prefetch={false}
                    className="-mx-2 flex min-h-14 flex-wrap items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface"
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
                        // eslint-disable-next-line @heisreal/web-ui/no-text-look -- the stand-in for a missing picture, decoration no piece draws
                        <span className="flex h-10 w-full items-center justify-center rounded-md bg-surface text-xs text-faint">
                          {s.primaryFormat === 'written' ? (
                            // eslint-disable-next-line @heisreal/web-ui/no-text-look -- as above
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
                      <Text
                        as="span"
                        size="small"
                        weight="bold"
                        className="line-clamp-2"
                      >
                        {s.title}
                      </Text>
                      <Text
                        as="span"
                        size="small"
                        tone="quiet"
                        className="flex flex-wrap items-center gap-x-2 gap-y-1"
                      >
                        {s.isNew && <NewBadge />}
                        {cardLabel(s)}
                      </Text>
                    </span>
                  </Link>
                </Text>
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
    </Card>
  );
}

import Image from 'next/image';
import Link from 'next/link';
import type { StorySummary } from '@/lib/browse';
import { cardLabel } from './story-card';

/** The story page's sidebar list (GET /v1/stories/{slug}/related): 3 cards, small. */
export function RelatedStories({ stories }: { stories: StorySummary[] }) {
  if (stories.length === 0) return null;
  return (
    <section
      aria-labelledby="related"
      className="rounded-2xl border border-border bg-card p-5"
    >
      <h2
        id="related"
        className="mb-3 text-sm font-semibold text-secondary-text"
      >
        Related stories
      </h2>
      <ul className="space-y-1">
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
                  <span className="block text-xs text-muted-foreground">
                    {cardLabel(s)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

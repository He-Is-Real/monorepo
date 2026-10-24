import Link from 'next/link';
import { TAG_CHIP } from '@/components/browse/tag-filter';
import type { StorySummary } from '@/lib/browse';
import type { PublicStory } from '@/lib/public-stories';
import { RelatedStories } from './related-stories';
import { ShareMenu } from './share-menu';
import { StoryMedia } from './story-media';
import { StoryText } from './story-text';

const published = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeZone: 'Europe/London',
  }).format(new Date(iso));

function Meta({
  story,
  center = false,
}: {
  story: PublicStory;
  center?: boolean;
}) {
  return (
    <>
      <p className="mt-3 text-sm text-muted-foreground">
        Shared{' '}
        <time dateTime={story.publishedAt}>{published(story.publishedAt)}</time>{' '}
        by {story.bylineName ?? 'Anonymous'}
      </p>
      {story.tags.length > 0 && (
        <ul
          className={`mt-5 flex flex-wrap gap-2 ${center ? 'justify-center' : ''}`}
          aria-label="Tags"
        >
          {story.tags.map((t) => (
            <li key={t.slug}>
              <Link href={`/stories?tag=${t.slug}`} className={TAG_CHIP}>
                {t.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Sidebar({ related }: { related: StorySummary[] }) {
  return (
    <aside className="space-y-4" aria-label="Keep exploring">
      <RelatedStories stories={related} />
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-2 font-semibold">Does this resonate?</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          If this story has touched you, there are ways to keep exploring.
        </p>
        <Link
          href="/next-steps"
          className="flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        >
          Next steps
        </Link>
      </section>
    </aside>
  );
}

/**
 * A published story, server-rendered (D32), from the mockups' story pages. Video and audio:
 * the player first, then the title, then the person's own text. Written: a centred header, the
 * description as a pull quote, then the text. Both: share, tags that lead to browse, and a
 * sidebar with related stories (beside the text from 1024 px, under it below).
 * No breadcrumb (Joel, 2026-10-24; design principles): it could show only one of a story's
 * tags; the header's Stories link and the tag chips are the ways back.
 * Favourite, "This helped me" and "Concern" from the mockups need accounts (M2+).
 */
export function StoryView({
  story,
  related,
}: {
  story: PublicStory;
  related: StorySummary[];
}) {
  const paragraphs = (story.body ?? '').split(/\n{2,}/).filter((p) => p.trim());
  const written = story.primaryFormat === 'written';
  const initial = [
    ...(story.bylineName?.trim() || story.title),
  ][0]?.toUpperCase();
  const share = (
    <div className="flex items-center justify-end border-b border-border py-3">
      <ShareMenu title={story.title} />
    </div>
  );

  return (
    // The reading column (max-w-measure, Joel's R1) holds the text; from 1024 px the sidebar
    // sits beside it, one design gap (3rem) away, and the whole composition is centred. The
    // hero (header, media, share row) spans the composition, so it and its media
    // are centred on the page (Joel, 2026-10-24) and its edges line up with the text's left
    // and the sidebar's right. overflow-wrap: anywhere: long words and pasted links wrap
    // instead of widening the page.
    <article
      className="mx-auto grid w-full max-w-measure gap-x-12 [overflow-wrap:anywhere] lg:max-w-[calc(var(--container-measure)+3rem+17.5rem)] lg:grid-cols-[minmax(0,1fr)_17.5rem]"
      aria-labelledby={`story-${story.id}`}
    >
      <div data-story-hero="" className="min-w-0 lg:col-span-2">
        {written ? (
          <header className="pb-8 text-center">
            {!story.image?.url && (
              <span
                aria-hidden="true"
                className="mx-auto mb-6 flex size-20 items-center justify-center rounded-full bg-teal-dark text-3xl font-bold text-white shadow-lg"
              >
                {initial}
              </span>
            )}
            <h1
              id={`story-${story.id}`}
              className="mx-auto max-w-[24ch] text-[clamp(2rem,5vw,2.75rem)] leading-tight font-normal"
            >
              {story.title}
            </h1>
            <Meta story={story} center />
            <StoryMedia story={story} />
          </header>
        ) : (
          <>
            <StoryMedia story={story} />
            {share}
            <header className="mt-8">
              <h1
                id={`story-${story.id}`}
                className="text-[clamp(2rem,5vw,2.75rem)] leading-tight font-normal"
              >
                {story.title}
              </h1>
              <Meta story={story} />
            </header>
          </>
        )}
        {written && share}
      </div>

      <div data-story-text="" className="mt-10 min-w-0 lg:col-start-1">
        {written ? (
          <blockquote className="border-l-[3px] border-teal pl-6 text-[1.375rem] leading-relaxed text-foreground italic">
            {story.description}
          </blockquote>
        ) : (
          <p className="text-lg text-secondary-text">{story.description}</p>
        )}
        {paragraphs.length > 0 && (
          <>
            {!written && (
              <h2 className="mt-10 text-sm font-semibold text-link">
                In their words
              </h2>
            )}
            <StoryText id={`story-${story.id}-text`} paragraphs={paragraphs} />
          </>
        )}
      </div>
      <div className="mt-12 lg:col-start-2 lg:row-start-2 lg:mt-10">
        <Sidebar related={related} />
      </div>
    </article>
  );
}

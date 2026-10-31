import Link from 'next/link';
import { THEME_CHIP } from '@/components/themes/theme-chip';
import type { StorySummary } from '@/lib/browse';
import type { PublicStory } from '@/lib/public-stories';
import { RelatedStories } from './related-stories';
import { StoryHeart } from './heart-button';
import { ShareMenu } from './share-menu';
import { StoryMedia } from './story-media';
import { StoryText } from './story-text';

/** The reading column (Joel's R1): at most 80 characters a line, centred. */
const COLUMN = 'mx-auto w-full max-w-measure min-w-0';

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
      {story.themes.length > 0 && (
        <ul
          className={`mt-5 flex flex-wrap gap-2 ${center ? 'justify-center' : ''}`}
          aria-label="Themes"
        >
          {story.themes.map((t) => (
            <li key={t.id}>
              <Link href={`/stories?theme=${t.id}`} className={THEME_CHIP}>
                {t.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** After the story: related stories, then a calm call to action. */
function KeepExploring({ related }: { related: StorySummary[] }) {
  return (
    <aside
      className="mt-12 space-y-4 lg:mt-16 lg:space-y-12"
      aria-label="Keep exploring"
    >
      <RelatedStories stories={related} />
      <section
        aria-labelledby="resonate"
        className="mx-auto max-w-measure rounded-2xl border border-border bg-card p-5"
      >
        <h2 id="resonate" className="mb-2 font-semibold">
          Does this resonate?
        </h2>
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
 * description as a pull quote, then the text. Both: share, themes that lead to browse, and, after
 * the story ends, related stories and "Does this resonate?" (below it at every width, never
 * beside it: Joel, 2026-10-25, a sidebar felt like an ad and took space from the story).
 * No breadcrumb (Joel, 2026-10-24; design principles): it could show only one of a story's
 * themes; the header's Stories link and the theme chips are the ways back.
 * The person's own heart sits beside Share (M2; filled in by the browser, D83). "This helped
 * me" and "Concern" from the mockups come later (M6).
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
    <div
      className={`${COLUMN} flex flex-wrap items-center justify-between gap-2 border-b border-border py-3 ${written ? 'mt-8' : ''}`}
    >
      <StoryHeart storyId={story.id} />
      <ShareMenu title={story.title} />
    </div>
  );

  return (
    // One centred column at every width. The reading column (max-w-measure, Joel's R1) holds
    // the title block, the share row and the text, so their edges line up. From 1024 px the
    // media breaks out of it, centred, to the design's narrow container (50rem): wide enough
    // that a video or picture keeps about the size it had beside the sidebar, never so wide
    // that it dwarfs the text. Related stories use the same band. Below 1024 px everything
    // keeps the reading column, as before. overflow-wrap: anywhere: long words and pasted
    // links wrap instead of widening the page.
    <article
      className="mx-auto w-full max-w-measure [overflow-wrap:anywhere] lg:max-w-narrow"
      aria-labelledby={`story-${story.id}`}
    >
      <div data-story-hero="">
        {written ? (
          <>
            <header className={`${COLUMN} text-center`}>
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
            </header>
            <StoryMedia story={story} />
            {share}
          </>
        ) : (
          <>
            <StoryMedia story={story} />
            {share}
            <header className={`${COLUMN} mt-8`}>
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
      </div>

      <div data-story-text="" className={`${COLUMN} mt-10`}>
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
      <KeepExploring related={related} />
    </article>
  );
}

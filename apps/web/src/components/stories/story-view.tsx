import type { PublicStory } from '@/lib/public-stories';
import { StoryText } from './story-text';

const published = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeZone: 'Europe/London',
  }).format(new Date(iso));

/** A published story, server-rendered (D32). Reading width is capped for comfortable lines. */
export function StoryView({
  story,
  headingLevel = 1,
}: {
  story: PublicStory;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const paragraphs = (story.body ?? '').split(/\n{2,}/).filter((p) => p.trim());
  return (
    // overflow-wrap: anywhere: long words and pasted links wrap instead of widening the page.
    <article
      className="mx-auto w-full max-w-prose [overflow-wrap:anywhere]"
      aria-labelledby={`story-${story.id}`}
    >
      <Heading
        id={`story-${story.id}`}
        className="text-3xl leading-tight font-semibold sm:text-4xl"
      >
        {story.title}
      </Heading>
      <p className="mt-3 text-sm text-secondary-text">
        {story.bylineName ?? 'Anonymous'} ·{' '}
        <time dateTime={story.publishedAt}>{published(story.publishedAt)}</time>
      </p>
      <p className="mt-6 text-lg text-secondary-text">{story.description}</p>
      {paragraphs.length > 0 && (
        <StoryText id={`story-${story.id}-text`} paragraphs={paragraphs} />
      )}
      {story.tags.length > 0 && (
        <ul className="mt-8 flex flex-wrap gap-2" aria-label="Tags">
          {story.tags.map((t) => (
            <li
              key={t.slug}
              className="rounded-md bg-raised px-3 py-1 text-sm text-secondary-text"
            >
              {t.name}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

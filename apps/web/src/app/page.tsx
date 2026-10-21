import Link from 'next/link';
import { connection } from 'next/server';
import { Logo } from '@/components/logo';
import { StoryView } from '@/components/stories/story-view';
import { featuredStorySlug } from '@/lib/config';
import {
  getPublicStory,
  type StoryResult,
  StoriesUnavailableError,
} from '@/lib/public-stories';

/**
 * Home (M0 task 0.9, the walking skeleton): the featured story, server-rendered from
 * api-public-read (D32). In dev that's the seeded test story. Browse arrives in M1.
 */
export default async function Page() {
  await connection();
  const slug = featuredStorySlug();
  let result: StoryResult | 'unavailable' | undefined;
  if (slug) {
    try {
      result = await getPublicStory(slug);
    } catch (err) {
      if (!(err instanceof StoriesUnavailableError)) throw err;
      result = 'unavailable';
    }
  }

  return (
    <main
      id="main"
      className="mx-auto w-full max-w-site flex-1 px-4 py-10 sm:px-10 sm:py-16"
    >
      <section className="flex flex-col items-center gap-4 text-center">
        <Logo size={112} />
        <h1 className="text-3xl leading-tight font-normal sm:text-5xl">
          He Is Real Today
        </h1>
        <p className="max-w-prose text-lg text-secondary-text">
          Real stories of encounters with God.
        </p>
      </section>

      {result && result !== 'unavailable' && result.kind === 'story' && (
        <section
          className="mt-12 rounded-xl bg-raised px-4 py-8 sm:px-10"
          aria-label="Featured story"
        >
          <StoryView story={result.story} headingLevel={2} />
          <p className="mx-auto mt-8 max-w-prose">
            <Link
              href={`/stories/${result.story.slug}`}
              className="inline-flex min-h-11 items-center"
            >
              Open this story on its own page
            </Link>
          </p>
        </section>
      )}
      {result === 'unavailable' && (
        <p
          role="status"
          className="mx-auto mt-12 max-w-prose rounded-xl bg-raised px-4 py-6 text-center text-secondary-text"
        >
          Stories can’t be loaded right now. Please try again in a moment.
        </p>
      )}
    </main>
  );
}

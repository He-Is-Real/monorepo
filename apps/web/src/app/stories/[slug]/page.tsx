import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { StoryView } from '@/components/stories/story-view';
import { getRelatedStories, type StorySummary } from '@/lib/browse';
import {
  getPublicStory,
  type PublicStory,
  StoriesUnavailableError,
} from '@/lib/public-stories';
import { logStoriesUnavailable } from '@/lib/log';
import { jsonLdScript, pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ slug: string }> };

async function related(slug: string): Promise<StorySummary[]> {
  try {
    const result = await getRelatedStories(slug);
    return result.kind === 'stories' ? result.stories : [];
  } catch (err) {
    if (err instanceof StoriesUnavailableError) return []; // the story still shows
    throw err;
  }
}

/** schema.org Article for search engines (the text is the person's own, already public here). */
function articleJsonLd(story: PublicStory) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: story.title,
    description: story.description,
    datePublished: story.publishedAt,
    ...(story.bylineName
      ? { author: { '@type': 'Person', name: story.bylineName } }
      : {}),
    keywords: story.themes.map((t) => t.name).join(', ') || undefined,
    inLanguage: 'en-GB',
  };
}

/**
 * When api-public-read can't be reached: a calm message in the page the server sends, so
 * visitors without JavaScript get it too, like browse's (Joel, 2026-10-25). The page answers
 * 200, as browse does (Next.js can't send a page with a 5xx), and isn't indexed
 * (generateMetadata). "Try again" is a plain link to the same page.
 */
function StoryUnavailable({ slug }: { slug: string }) {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-measure flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <h1 className="text-3xl font-semibold">
        This story can’t be shown right now
      </h1>
      <p className="text-secondary-text">
        Stories are briefly unavailable. Please try again in a moment.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <a
          href={`/stories/${slug}`}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        >
          Try again
        </a>
        <Link
          href="/stories"
          className="inline-flex min-h-11 items-center px-2"
        >
          Browse stories
        </Link>
      </div>
    </main>
  );
}

/**
 * A published story, server-rendered from api-public-read (D32). Unknown slugs get the 404
 * page; an old slug redirects to the current one (D30); if api-public-read can't be reached,
 * StoryUnavailable says so. Related stories are optional: if they can't load, the story shows
 * without them.
 */
export default async function StoryPage({ params }: Props) {
  const { slug } = await params;
  let result;
  try {
    result = await getPublicStory(slug);
  } catch (err) {
    if (!(err instanceof StoriesUnavailableError)) throw err;
    logStoriesUnavailable('story', err);
    return <StoryUnavailable slug={slug} />;
  }
  if (result.kind === 'not_found') notFound();
  if (result.story.slug !== slug)
    permanentRedirect(`/stories/${result.story.slug}`);
  const story = result.story;
  return (
    <main id="main" className="w-full flex-1 px-4 py-8 sm:px-10 sm:py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(articleJsonLd(story)) }}
      />
      <StoryView story={story} related={await related(story.slug)} />
    </main>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const result = await getPublicStory(slug);
    if (result.kind === 'story') {
      const { story } = result;
      // The site's brand card, not the story's picture: media links are signed and expire in
      // hours (D52), while share previews are cached for much longer.
      return pageMetadata({
        title: story.title,
        description: story.description,
        path: `/stories/${story.slug}`,
        openGraph: {
          type: 'article',
          publishedTime: story.publishedAt,
          tags: story.themes.map((t) => t.name),
        },
      });
    }
  } catch (err) {
    // The page shows StoryUnavailable (and logs it); not for search engines.
    if (err instanceof StoriesUnavailableError)
      return { robots: { index: false, follow: true } };
    // Anything else: the page itself shows the error.
  }
  return {};
}

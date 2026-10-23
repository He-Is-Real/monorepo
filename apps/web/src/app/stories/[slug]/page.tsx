import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { StoryView } from '@/components/stories/story-view';
import { getRelatedStories, type StorySummary } from '@/lib/browse';
import {
  getPublicStory,
  type PublicStory,
  StoriesUnavailableError,
} from '@/lib/public-stories';
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
    keywords: story.tags.map((t) => t.name).join(', ') || undefined,
    inLanguage: 'en-GB',
  };
}

/**
 * A published story, server-rendered from api-public-read (D32). Unknown slugs get the 404
 * page; an old slug redirects to the current one (D30); if api-public-read is down,
 * StoriesUnavailableError reaches error.tsx, a friendly error page. Related stories are
 * optional: if they can't load, the story shows without them.
 */
export default async function StoryPage({ params }: Props) {
  const { slug } = await params;
  const result = await getPublicStory(slug);
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
          tags: story.tags.map((t) => t.name),
        },
      });
    }
  } catch {
    // The page itself shows the error.
  }
  return {};
}

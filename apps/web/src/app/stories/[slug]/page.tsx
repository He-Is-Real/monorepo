import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { StoryView } from '@/components/stories/story-view';
import { getPublicStory } from '@/lib/public-stories';

type Props = { params: Promise<{ slug: string }> };

/**
 * A published story, server-rendered from api-public-read (D32). Unknown slugs get the 404
 * page; an old slug redirects to the current one (D30); if api-public-read is down,
 * StoriesUnavailableError reaches error.tsx, a friendly error page.
 */
export default async function StoryPage({ params }: Props) {
  const { slug } = await params;
  const result = await getPublicStory(slug);
  if (result.kind === 'not_found') notFound();
  if (result.story.slug !== slug)
    permanentRedirect(`/stories/${result.story.slug}`);
  return (
    <main id="main" className="w-full flex-1 px-4 py-10 sm:px-10 sm:py-16">
      <StoryView story={result.story} />
    </main>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const result = await getPublicStory(slug);
    if (result.kind === 'story') {
      return {
        title: result.story.title,
        description: result.story.description,
      };
    }
  } catch {
    // The page itself shows the error.
  }
  return {};
}

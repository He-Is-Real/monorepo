import type { Metadata } from 'next';
import { connection } from 'next/server';
import { OwnStoryPreview } from '@/components/account/own-story-preview';
import { pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ id: string }> };

/** Never indexed: it's personal, and the same empty shell for every visitor. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    ...pageMetadata({
      title: 'Preview your story',
      description: 'Your story as others will see it. Only you can see this.',
      path: `/account/stories/${encodeURIComponent(id)}/preview`,
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /account/stories/{id}/preview (M3 plan PR 2, part 1b): the person's own story as the public
 * story page shows it. web's server sends the same shell to everyone (D32); the browser asks
 * api-user with the person's own token (D83), which answers only the story's owner.
 */
export default async function OwnStoryPreviewPage({ params }: Props) {
  await connection();
  const { id } = await params;
  return (
    // As the story page: the article sets its own widths inside the page's padding.
    <main id="main" className="w-full flex-1 px-4 py-8 sm:px-10 sm:py-12">
      <noscript>
        <p className="mx-auto mb-6 max-w-measure rounded-2xl border border-border bg-card p-6 text-center">
          Your preview needs JavaScript. Please turn it on, or use a browser
          that has it, to see it.
        </p>
      </noscript>
      <OwnStoryPreview id={id} />
    </main>
  );
}

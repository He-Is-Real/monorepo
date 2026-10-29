import type { Metadata } from 'next';
import { FavouritesList } from '@/components/favourites/favourites-list';
import { PageHeader } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's personal, and the same empty shell for every visitor. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'My favourites',
      description: 'The stories you’ve hearted. Only you can see them.',
      path: '/account/favourites',
    }),
    robots: { index: false, follow: true },
  };
}

/**
 * "My favourites" (M2): the stories the person has hearted, newest heart first. web's server
 * renders the same shell for everyone (D32); the browser fills it in from api-user with the
 * person's login (D83), so it needs JavaScript, and says so without it. Hearts are private:
 * no counts, and nobody else can see the list.
 */
export default function MyFavouritesPage() {
  return (
    <main id="main" className="flex-1 px-4 py-12 sm:px-10 sm:py-16">
      <div className="mx-auto w-full max-w-site">
        <PageHeader
          title="My favourites"
          lead="The stories you’ve hearted. Only you can see them."
        />
        <noscript>
          <p className="mx-auto mb-6 max-w-measure rounded-2xl border border-border bg-card p-6 text-center">
            Your favourites need JavaScript. Please turn it on, or use a browser
            that has it, to see them.
          </p>
        </noscript>
        <FavouritesList />
      </div>
    </main>
  );
}

import { DraftNotice } from '@/components/page/draft-notice';
import { NarrowColumn } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Terms of use',
    description: 'The terms for using He Is Real Today.',
    path: '/terms',
  });
}

export default function TermsPage() {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        <DraftNotice>
          This is a placeholder. The real terms come before the site goes live.
        </DraftNotice>
        <h1 className="mb-6 text-[2rem] leading-tight font-normal sm:text-[2.75rem]">
          Terms of use
        </h1>
        <div className="space-y-4 text-secondary-text">
          <p>
            This is the development version of He Is Real Today. Everything on
            it is test content: the stories are made up, and nobody shared them.
          </p>
          <p>
            The full terms, including how stories are shared, reviewed and
            removed, will be published here before the site goes live.
          </p>
        </div>
      </NarrowColumn>
    </main>
  );
}

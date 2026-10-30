import { connection } from 'next/server';
import { LegalBlocks } from '@/components/consent/legal-blocks';
import { DocumentVersions } from '@/components/page/document-versions';
import { DraftNotice } from '@/components/page/draft-notice';
import { NarrowColumn } from '@/components/page/page-header';
import { getLegalDocument, parseLegalText } from '@/lib/legal';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Terms of use',
    description: 'The terms for using He Is Real Today.',
    path: '/terms',
  });
}

/**
 * The terms of use (D121): the version in force, as the site renders its web text, with its PDF
 * of record and the previous versions, read per request from api-public-read (D32). The sign-up
 * form's "I agree to the terms of use" binds the version in force (D122). Until one is published
 * (or if it can't be read), the page's own placeholder words.
 */
export default async function TermsPage() {
  await connection();
  const terms = await getLegalDocument('terms');
  const current = terms?.current ?? null;
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        {!current && (
          <DraftNotice>
            This is a placeholder. The real terms come before the site goes
            live.
          </DraftNotice>
        )}
        <h1 className="mb-6 text-[2rem] leading-tight font-normal sm:text-[2.75rem]">
          Terms of use
        </h1>
        {current && terms ? (
          <section
            aria-label="The terms of use"
            data-legal-version={current.id}
            className="space-y-6"
          >
            <LegalBlocks blocks={parseLegalText(current.text)} />
            <DocumentVersions
              document="terms"
              version={current.id}
              pdf={current.pdf}
              previous={terms.versions.filter((v) => v.id !== current.id)}
            />
          </section>
        ) : (
          <div className="space-y-4 text-secondary-text">
            <p>
              This is the development version of He Is Real Today. Everything on
              it is test content: the stories are made up, and nobody shared
              them.
            </p>
            <p>
              The full terms, including how stories are shared, reviewed and
              removed, will be published here before the site goes live.
            </p>
          </div>
        )}
      </NarrowColumn>
    </main>
  );
}

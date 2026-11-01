import { AgreementPage } from '@/components/consent/agreement-page';
import { consentReturnPath } from '@/lib/return-path';
import { NarrowColumn } from '@/components/page/page-header';
import type { AgreementName } from '@/lib/legal-text';

/**
 * The frame of /consent/terms and /consent/testimony: the same for everyone (D32); the step itself
 * runs in the browser for the person signed in (agreement-page.tsx), so it needs JavaScript.
 */
export async function AgreementShell({
  document,
  searchParams,
}: {
  document: AgreementName;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returnTo = consentReturnPath((await searchParams)['redirect_url']);
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <NarrowColumn>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This step needs JavaScript. Please turn it on, or use a browser that
            has it, to continue.
          </p>
        </noscript>
        <AgreementPage document={document} returnTo={returnTo} />
      </NarrowColumn>
    </main>
  );
}

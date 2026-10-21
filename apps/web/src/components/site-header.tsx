import { connection } from 'next/server';
import { AccountControl } from '@/components/auth/account-control';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import { clerkPublishableKey } from '@/lib/config';

/**
 * The site header's account area. The publishable key is read at request time (Terraform sets
 * it on the Cloud Run service; images are built once for every environment), so this renders
 * per request. Without a key (e.g. local dev without one) there's no sign-in control.
 */
export async function SiteHeader() {
  await connection();
  const publishableKey = clerkPublishableKey();
  return (
    <header className="absolute inset-x-0 top-0 z-10 flex justify-end px-5 py-4 sm:px-10">
      {publishableKey ? (
        <ClerkBrowser publishableKey={publishableKey}>
          <AccountControl />
        </ClerkBrowser>
      ) : null}
    </header>
  );
}

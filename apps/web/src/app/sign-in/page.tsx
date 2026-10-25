import type { Metadata } from 'next';
import { connection } from 'next/server';
import {
  FixtureSignInPanel,
  SignInPanel,
} from '@/components/auth/sign-in-panel';
import { Logo } from '@/components/logo';
import { clerkPublishableKey, e2eFixtures } from '@/lib/config';
import { safeReturnPath } from '@/lib/return-path';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). Never indexed: it's only a sign-in form. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Sign in',
      description:
        'Sign in or create an account to share your story, save favourites and see what’s new.',
      path: '/sign-in',
    }),
    robots: { index: false, follow: true },
  };
}

/**
 * Sign in or sign up (task 2.1; mockup public/signin.html, without Apple): Clerk's own sign-in
 * in the browser (D32), returning the person to the page they came from (`redirect_url`, a
 * path on this site only). Per request, for the deployment's Clerk key. Signing in needs
 * JavaScript, so without it the page says so. Space is kept for Clerk's card while it loads,
 * so the footer doesn't jump.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const returnTo = safeReturnPath((await searchParams)['redirect_url']);
  const publishableKey = clerkPublishableKey();
  return (
    <main id="main" className="flex-1 px-4 py-10 sm:px-10 sm:py-16">
      <div className="mx-auto flex w-full max-w-[28rem] flex-col items-center">
        <Logo size={88} className="mb-6 opacity-90" />
        <h1 className="mb-2 text-center text-[2rem] leading-tight font-normal">
          Welcome
        </h1>
        <p className="mb-8 text-center text-[1.0625rem] text-secondary-text">
          Sign in to track your stories, save favourites, and see what’s new.
          New here? The same steps create your account.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6 text-center">
            Signing in needs JavaScript. Please turn it on, or use a browser
            that has it, to sign in.
          </p>
        </noscript>
        {/* Clerk's own step titles are hidden (the page's only h1 is "Welcome"), so the
            region names the form. */}
        <section
          aria-label="Sign in or create an account"
          data-sign-in-slot=""
          className="flex min-h-[28rem] w-full justify-center"
        >
          {e2eFixtures() ? (
            <FixtureSignInPanel returnTo={returnTo} />
          ) : publishableKey ? (
            <SignInPanel publishableKey={publishableKey} returnTo={returnTo} />
          ) : (
            <p className="text-center text-secondary-text">
              Signing in isn’t available on this site yet.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

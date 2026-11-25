'use client';

import { Button, Heading, Text } from '@heisreal/web-ui';
import { ErrorReference } from '@/components/errors/error-reference';
import { TextLink } from '@/components/page/text-link';
import { reportBrowserCrash } from '@/lib/error-reports';

/**
 * Anything a page couldn't render. Search engines are told not to index it (PC-3 A, Joel,
 * 2026-11-22), like the "not found" page: with page caching the answer is 200, so the tag is what
 * keeps a crash out of search results. Both cases end with a reference made here, in the browser
 * (LG-1, LG-1c).
 *
 * - **On the server** (the error comes with Next's `digest`; most likely api-public-read being
 *   unreachable, or a rate limit, which looks exactly like this, RL-5): only "Something went
 *   wrong. Please try again later." (Joel, 2026-11-09). No error details or backend state reach
 *   the visitor; the server logged it (onRequestError), so nothing is sent from here.
 * - **In the browser** (no digest): "This page stopped working. Reloading it usually fixes this."
 *   with *Reload page* (LG-13c, Joel 25 Nov 2026: a message fitting the error where it isn't
 *   sensitive; a crash in this browser's own copy of the page tells nobody anything about our
 *   side). It is reported with the reference (`browser_crash`, LG-1c), from this page's memory
 *   only.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const inBrowser = !error.digest;
  return (
    <main
      id="main"
      data-error-kind={inBrowser ? 'browser' : 'server'}
      className="mx-auto flex w-full max-w-measure flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <meta name="robots" content="noindex" />
      {inBrowser ? (
        <>
          <Heading level={1}>This page stopped working</Heading>
          <Text tone="quiet">Reloading it usually fixes this.</Text>
        </>
      ) : (
        <>
          <Heading level={1}>Something went wrong</Heading>
          <Text tone="quiet">Please try again later.</Text>
        </>
      )}
      <div className="flex flex-wrap justify-center gap-3">
        {inBrowser ? (
          <Button onClick={() => window.location.reload()}>Reload page</Button>
        ) : (
          <Button onClick={() => reset()}>Try again</Button>
        )}
        <TextLink href="/" kind="standalone" className="px-2">
          Go to the home page
        </TextLink>
      </div>
      <ErrorReference
        onReference={(reference) => {
          if (inBrowser) reportBrowserCrash(reference);
        }}
      />
    </main>
  );
}

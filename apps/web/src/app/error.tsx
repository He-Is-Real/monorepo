'use client';

import { Button, Heading, Text } from '@heisreal/web-ui';
import { ErrorReference } from '@/components/errors/error-reference';
import { TextLink } from '@/components/page/text-link';
import { reportBrowserCrash } from '@/lib/error-reports';

/**
 * Anything a page couldn't render, most likely api-public-read being unreachable. Only "Something
 * went wrong. Please try again later." (Joel, 2026-11-09): no error details or backend state reach
 * the visitor (they're in our logs), and a reference made here, in the browser, under it (LG-1,
 * LG-1c). Search engines are told not to index it (PC-3 A, Joel, 2026-11-22), like the "not
 * found" page: with page caching the answer is 200, so the tag is what keeps a crash out of search
 * results.
 *
 * A crash while the page was made on the server comes with Next's `digest`: the server logged it
 * (onRequestError), so nothing is sent from here. A crash in the browser (no digest) is reported
 * with the reference (`browser_crash`, LG-1c), from this page's memory only.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-measure flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <meta name="robots" content="noindex" />
      <Heading level={1}>Something went wrong</Heading>
      <Text tone="quiet">Please try again later.</Text>
      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={() => reset()}>Try again</Button>
        <TextLink href="/" kind="standalone" className="px-2">
          Go to the home page
        </TextLink>
      </div>
      <ErrorReference
        onReference={(reference) => {
          if (!error.digest) reportBrowserCrash(reference);
        }}
      />
    </main>
  );
}

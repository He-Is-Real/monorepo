'use client';

import { Button, Heading, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

/**
 * Anything a page couldn't render, most likely api-public-read being unreachable. Only "Something
 * went wrong. Please try again later." (Joel, 2026-11-09): no error details or backend state reach
 * the visitor (they're in Cloud Run's logs). Search engines are told not to index it (PC-3 A, Joel,
 * 2026-11-22), like the "not found" page: with page caching the answer is 200, so the tag is
 * what keeps a crash out of search results.
 */
export default function ErrorPage({
  reset,
}: {
  error: Error;
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
    </main>
  );
}

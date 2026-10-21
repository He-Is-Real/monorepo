'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Anything a page couldn't render, most likely api-public-read being unreachable. Friendly and
 * generic: no error details reach the visitor (they're in Cloud Run's logs).
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
      className="mx-auto flex w-full max-w-prose flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <h1 className="text-3xl font-semibold">
        Something went wrong on our side
      </h1>
      <p className="text-secondary-text">
        We couldn’t load this page just now. Please try again in a moment.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button className="h-11 px-4" onClick={() => reset()}>
          Try again
        </Button>
        <Link href="/" className="inline-flex min-h-11 items-center px-2">
          Go to the home page
        </Link>
      </div>
    </main>
  );
}

import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-measure flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <p className="text-sm font-semibold tracking-wide text-secondary-text">
        404
      </p>
      <h1 className="text-3xl font-semibold">We couldn’t find that page</h1>
      <p className="text-secondary-text">
        The story may have moved or is no longer published.
      </p>
      <Link href="/" className="inline-flex min-h-11 items-center">
        Go to the home page
      </Link>
    </main>
  );
}

import { connection } from 'next/server';

/**
 * What a rate-limited visitor gets (RL-5: exactly the answer of any other unexpected failure).
 * The proxy (proxy.ts) rewrites a limited request here, keeping its URL, and this page fails to
 * render, so Next's own error path answers it: status 500 and the site's error page
 * (app/error.tsx), with the same headers as a real crash. A direct visit gets the same error and
 * changes nothing.
 */
export default async function SomethingWentWrong(): Promise<never> {
  // Rendered per request, never at build time (a page that always fails can't be prerendered).
  await connection();
  throw new Error('Rate limited');
}

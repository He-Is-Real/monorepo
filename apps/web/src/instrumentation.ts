import type { Instrumentation } from 'next';

/**
 * The website server's start-up and server errors (writing-logs skill; LG-1c, LG-4 A; Joel
 * 22–24 Nov 2026). Node only: the proxy and pages run in Node (no Edge runtime here).
 *
 * - `register`: reads the two log keys (`log-hmac`, `log-search-hmac`) through libs/secrets, the
 *   same way the APIs do. Deployed (Cloud Run sets `K_SERVICE`) without both, the server doesn't
 *   start; locally the fixed development keys are used, with a warning.
 * - `onRequestError`: a server error while making a page, a server action or a route. It goes on
 *   the request's wide event (started in `proxy.ts`): `outcome: "error"`, the error's type and
 *   Next's `digest`, the route file and what was being made; and the immediate error line with
 *   its stack (Error Reporting groups errors from it), with the request's `ref`. The browser is
 *   never told anything but the generic message and a reference of its own (LG-1c).
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { loadWebLogKeys } = await import('./lib/log-keys');
  await loadWebLogKeys();
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { recordRequestError } = await import('./lib/request-error');
  recordRequestError(err, request, context);
};

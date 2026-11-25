import type { Instrumentation } from 'next';

/**
 * The website server's start-up and server errors (writing-logs skill; LG-1c, LG-4 A; Joel
 * 22–24 Nov 2026). Node only: the proxy and pages run in Node (no Edge runtime here).
 *
 * - `register`: reads the two log keys (`log-hmac`, `log-search-hmac`) through libs/secrets, the
 *   same way the APIs do. Deployed (Cloud Run sets `K_SERVICE`) without both, the server doesn't
 *   start; locally the fixed development keys are used, with a warning. Then it starts the Axiom
 *   sink (LG-3, `@heisreal/logging/axiom`) in the background, so a slow token read never delays
 *   the first request: where OpenTofu set `AXIOM_DATASET`,
 *   `AXIOM_DOMAIN` and `AXIOM_TOKEN_SECRET`, every log entry also goes to Axiom; a token that
 *   can't be read is one warning, never a failed start. Unlike the APIs there is no flush at
 *   shutdown: Next has no shutdown hook for App Router apps (its own SIGTERM handler closes the
 *   server and exits; `NEXT_MANUAL_SIG_HANDLE` would replace that handler, a workaround). The
 *   sink sends each entry as soon as the event loop's current turn ends; a send Cloud Run's CPU
 *   throttling pauses after a response goes out with the instance's next request. Lines still
 *   waiting when an idle instance is shut down are missing in Axiom only (Google's copy from
 *   stdout is complete).
 * - Spans (LG-15 D, Joel 25 Nov 2026): `register` first starts OpenTelemetry
 *   (`@heisreal/logging/tracing`, the same set-up as the APIs; no `@vercel/otel`, no verbose mode),
 *   so Next's built-in spans (each request, its render and its fetches) and the proxy's event span
 *   go to Axiom's traces dataset where OpenTofu set `AXIOM_TRACES_DATASET` with the Axiom settings
 *   above. Every span leaves through the same attribute allowlist as the APIs' spans: Next's
 *   `http.target` and `http.url` (the address with its query) are dropped, and a fetch span's name
 *   keeps only the host it called. Locally nothing is sent. Not flushed at shutdown, like the logs.
 * - `onRequestError`: a server error while making a page, a server action or a route. It goes on
 *   the request's wide event (started in `proxy.ts`): `outcome: "error"`, the error's type and
 *   Next's `digest`, the route file and what was being made; and the immediate error line with
 *   its stack (Error Reporting groups errors from it), with the request's `ref`. The browser is
 *   never told anything but the generic message and a reference of its own (LG-1c).
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { startWebTracing } = await import('./lib/tracing');
  startWebTracing();
  const { loadWebLogKeys, startWebAxiomLogs } = await import('./lib/log-keys');
  await loadWebLogKeys();
  // Not awaited: Next waits for `register` before serving, and Axiom is optional. Entries written
  // before the token is read go to stdout only. startAxiomLogs never throws; the catch is a guard.
  void startWebAxiomLogs().catch(() => undefined);
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

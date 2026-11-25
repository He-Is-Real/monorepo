import type { Instrumentation } from 'next';
import { traceFromHeader, writeErrorLine } from '@heisreal/logging/event';
import { WEB_SERVICE } from './request-event';
import { erroredRequestTraceparent } from './visitor-address';

type Args = Parameters<Instrumentation.onRequestError>;

/** The page a rate-limited request is rewritten to, which fails on purpose (RL-5, proxy.ts). */
const CRASH_ROUTE = /^\/something-went-wrong(\/|$)/;

/**
 * A server error Next caught (`onRequestError`, instrumentation.ts): the immediate error line,
 * with its stack (Error Reporting groups errors from it), the request's `ref` (the trace Google's
 * front end gave it, as on the request's event from proxy.ts), Next's `digest`, the route file
 * and what was being made. The proxy has written the request's event by then (Next runs the proxy
 * before the page), so this line is where the error is. The rate-limit crash page fails on
 * purpose: nothing is written for it (the request's event says `rate_limited`). Never throws.
 */
export function recordRequestError(
  err: Args[0],
  request: Args[1],
  context: Args[2],
): void {
  try {
    if (CRASH_ROUTE.test(context.routePath)) return;
    const trace = traceFromHeader(erroredRequestTraceparent(request));
    const digest =
      typeof err === 'object' && err !== null && 'digest' in err
        ? String((err as { digest: unknown }).digest)
        : undefined;
    writeErrorLine(err, {
      ref: trace?.ref,
      traceId: trace?.traceId,
      fields: {
        service: WEB_SERVICE,
        http: { method: request.method, route: context.routePath },
        render: {
          route_type: context.routeType,
          render_source: context.renderSource,
        },
        outcome: 'error',
        error: {
          type: err instanceof Error ? err.name : 'Error',
          digest,
        },
      },
    });
  } catch {
    // Logging never throws into the server.
  }
}

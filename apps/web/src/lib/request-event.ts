import {
  clientKind,
  newTrace,
  serviceFields,
  startEvent,
  traceFromHeader,
  type WideEvent,
} from '@heisreal/logging/event';
import { PAGE_CACHE, type PageCachePath } from '@/page-cache.config';

/**
 * The website's wide event (writing-logs skill; LG-2 C, LG-4 A; Joel 22–24 Nov 2026): one per
 * request, made and written by `proxy.ts`. Its `ref` is the trace Google's front end gives the
 * request (`traceparent`), so it matches Cloud Run's own request line (status, latency) and the
 * error line `onRequestError` writes for the same request (instrumentation.ts); a new UUID v7 when
 * there is none (local runs).
 */

/** The website's service fields: `web`, Cloud Run's revision and the environment. */
export const WEB_SERVICE = serviceFields('web');

/** Starts the request's event. */
export function startRequestEvent(traceparent: string | undefined): WideEvent {
  return startEvent(
    'request',
    WEB_SERVICE,
    traceFromHeader(traceparent) ?? newTrace(),
  );
}

/** The `client` group: the address and the browser, plain (LG-2). */
export function clientFields(
  ip: string | undefined,
  userAgent: string | undefined,
) {
  const kind = clientKind(userAgent);
  return {
    ip,
    user_agent: userAgent,
    browser: kind.browser,
    os: kind.os,
    device: kind.device,
  };
}

/**
 * The `cache` group: how long this page's saved copy is kept here (page-cache.config.ts), for the
 * pages listed there. Whether this request was answered from the copy isn't known to the proxy.
 */
export function cacheFields(
  pathname: string,
): { policy: string; ttl_seconds?: number } | undefined {
  const env = process.env['SITE_ENVIRONMENT']?.trim();
  if (env !== 'dev' && env !== 'prod') return undefined;
  const path = (pathname.replace(/\/+$/, '') || '/') as PageCachePath;
  if (!Object.hasOwn(PAGE_CACHE, path)) return undefined;
  const time = PAGE_CACHE[path][env];
  return typeof time === 'number'
    ? { policy: 'timed', ttl_seconds: time }
    : { policy: time };
}

import {
  clientKind,
  currentEvent,
  type EventKind,
  type Outcome,
  runWithEvent,
  type Searcher,
  type SearchEventInput,
  serviceFields,
  startEvent,
  traceFromHeader,
  type WideEvent,
  withoutSecrets,
  writeSearchEvent,
} from '@heisreal/logging/event';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { canonicalIp } from './ip';

/**
 * The request's wide event for every API (writing-logs skill; LG-2 C, LG-4 A; Joel 22–24 Nov
 * 2026). Express middleware, added first in each service's `main.ts` with
 * `app.use(wideEvents('api-user'))`, so it runs before CORS, the rate limiters, guards,
 * interceptors and the exception filter: a refusal at any of them still ends in the event.
 *
 * - The trace id comes from the browser's `traceparent` (CORS allows it), or a new UUID v7;
 *   `ref` is that id with dashes, and `logging.googleapis.com/trace` groups our line with Cloud
 *   Run's own request line.
 * - Code the request runs adds to it through `currentEvent()` (`@heisreal/logging/event`); the
 *   exception filter records errors; `timeDb` / `timeExternal` add timings.
 * - It is written once, when the response is closed (also when the caller hangs up), after the
 *   answer has gone; writing never throws into the request.
 * - It is also the request's OpenTelemetry server span (LG-15 D, `@heisreal/logging/tracing`),
 *   named by the route pattern (`GET /v1/stories/:id`), never the address, with the database and
 *   outside calls as child spans. Its trace id is the `ref`.
 *
 * Why the request span is made here by hand (Joel, 25 Nov 2026: "make a note to revert
 * workarounds when a version is released that is compatible with NestJS 12"):
 * `@opentelemetry/instrumentation-nestjs-core` supports `@nestjs/core` < 12 only, and Express's
 * automatic spans need the ESM loader hook (about +1 s per cold start). When a release supports
 * NestJS 12 without that hook, switch to it and delete this hand-made span (`openSpan` and
 * `endSpan` in libs/logging's wide-event.ts, `spanName` below). `tools/scripts/otel-nest-check.mjs`
 * (weekly, tofu-drift.yml) fails once a release does.
 */
export function wideEvents(
  service: string,
  /** `job`: each request is one step of a job (the media result writer's calls from the worker). */
  kind: EventKind = 'request',
  {
    bodyNeverLogged = [],
  }: {
    /**
     * Paths whose request body is never logged, not hashed and not in full, whatever the
     * outcome: an exception to LG-9b's "refusals log the body", for anonymous routes anyone could
     * use to write their own text into our logs (api-user's `/v1/error-reports`). Their
     * refusals still log the failed field names and checks (fixed metadata, never the values).
     */
    bodyNeverLogged?: readonly string[];
  } = {},
): RequestHandler {
  const quiet = new Set(bodyNeverLogged.map((p) => p.toLowerCase()));
  const bodyIsQuiet = (req: Request) => {
    if (!quiet.size) return false;
    const path = pathOf(req);
    return path === undefined || quiet.has(path);
  };
  const fields = serviceFields(service);
  return (req: Request, res: Response, next: NextFunction) => {
    let event: WideEvent;
    try {
      // The caller's trace (the browser's, the media worker's) or a new UUID v7.
      event = startEvent(
        kind,
        fields,
        traceFromHeader(req.headers['traceparent']),
      );
      const userAgent = req.headers['user-agent'];
      const client = clientKind(userAgent);
      const requestBytes = Number(req.headers['content-length']);
      event.set({
        http: {
          method: req.method,
          request_bytes: Number.isFinite(requestBytes)
            ? requestBytes
            : undefined,
        },
        client: {
          user_agent: userAgent,
          browser: client.browser,
          os: client.os,
          device: client.device,
        },
      });
      res.once('close', () => finishRequest(event, req, res, bodyIsQuiet(req)));
    } catch {
      return next();
    }
    runWithEvent(event, next);
  };
}

/** What a status means when nothing more specific was recorded. */
export function outcomeForStatus(status: number): Outcome {
  if (status < 400) return 'ok';
  if (status === 404) return 'not_found';
  if ([400, 413, 415, 422].includes(status)) return 'input_refused';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'error';
  return 'refused';
}

/** The route template Express matched (`/v1/stories/:id`), never the address itself. */
function routeOf(req: Request): string | undefined {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : undefined;
}

/**
 * The request's path as Express routes it (its `parseurl` pathname: the absolute form
 * `POST http://host/v1/…` routes like `/v1/…`), without its query, lower case and without a
 * trailing slash. From `originalUrl`: routers may rewrite `req.url`. `undefined` if it can't
 * be read: such a request counts as one whose body is never logged (fail closed).
 */
function pathOf(req: Request): string | undefined {
  let url = req.originalUrl ?? req.url ?? '';
  if (!url.startsWith('/')) {
    try {
      url = new URL(url).pathname;
    } catch {
      return undefined;
    }
  }
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  return (path.length > 1 ? path.replace(/\/+$/, '') : path).toLowerCase();
}

function finishRequest(
  event: WideEvent,
  req: Request,
  res: Response,
  bodyNeverLogged: boolean,
): void {
  try {
    const status = res.statusCode;
    const route = routeOf(req);
    const responseBytes = Number(res.getHeader('content-length'));
    const ms = event.elapsedMs();
    event.set({
      http: {
        route,
        status_code: status,
        duration_ms: ms,
        response_bytes: Number.isFinite(responseBytes)
          ? responseBytes
          : undefined,
      },
      // req.ip is only right once the rate limiter has told Express to trust Google's front end.
      client: { ip: canonicalIp(req.ip) ?? req.ip },
    });
    event.setOutcome(outcomeForStatus(status));
    const body = req.body as unknown;
    if (
      !bodyNeverLogged &&
      body &&
      typeof body === 'object' &&
      !Buffer.isBuffer(body) &&
      Object.keys(body).length
    ) {
      event.longText('request.body', JSON.stringify(withoutSecrets(body)));
    }
    event.message(
      `${req.method} ${route ?? '(no route)'} ${status} in ${ms} ms`,
    );
    event.spanName(`${req.method} ${route ?? '(no route)'}`);
    event.write();
  } catch {
    // never throws into the request
  }
}

/** The current request's event, if any (inside a request handled by {@link wideEvents}). */
export const requestEvent = currentEvent;

/**
 * Writes the separate search event for a search on this request (LG-2g A): who searched is
 * taken from the request (its address, user agent, and the signed-in person if any) and written
 * only as search-key hashes; the terms go only here, never on the request's own event.
 */
export function searchEvent(
  req: Request,
  input: Omit<SearchEventInput, 'service' | 'who' | 'durationMs' | 'db'> & {
    durationMs?: number;
  },
): void {
  const event = currentEvent();
  const who: Searcher = {
    ip: canonicalIp(req.ip) ?? req.ip,
    userAgent: req.headers['user-agent'],
    userId: event?.get('user.id') as string | undefined,
    email: event?.get('user.email') as string | undefined,
    role: event?.get('user.role') as string | undefined,
  };
  writeSearchEvent({
    ...input,
    service: event?.service ?? serviceFields('unknown'),
    route: input.route ?? routeOf(req),
    durationMs: input.durationMs ?? event?.elapsedMs() ?? 0,
    db: event?.dbTimings(),
    who,
  });
}

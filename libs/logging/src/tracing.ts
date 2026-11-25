/**
 * OpenTelemetry spans (LG-15 D, Joel 25 Nov 2026: "use open telemetry"): each request's and job's
 * timeline, sent to Axiom's traces dataset (`heisreal-traces`) beside the logs. The wide event
 * stays the record of what happened; spans show where the time went.
 *
 * - **Core only, no automatic instrumentation.** A tracer provider, the W3C trace-context
 *   propagator, a batch span processor and the OTLP/HTTP exporter. Our own spans are made by the
 *   wide event (`@heisreal/logging/event`): one server span per request (libs/http `wideEvents`),
 *   one per job, and child spans in `timeDb` and `timeExternal`. The website adds Next's own spans
 *   (its built-in OpenTelemetry support uses the provider registered here).
 *   `@opentelemetry/instrumentation-nestjs-core` supports `@nestjs/core` < 12 only, and Express
 *   spans need the ESM loader hook (~+1 s cold start): when a release supports NestJS 12 without
 *   that hook, switch to it and delete the hand-made request span (libs/http wide-events.ts).
 *   `tools/scripts/otel-nest-check.mjs` (weekly, tofu-drift.yml) fails once it does.
 * - **The Reference is the trace id.** New traces get a UUID v7 trace id ({@link uuidv7TraceIds}),
 *   as `ref` always was; an incoming `traceparent` (the browser's, the media worker's) is
 *   continued. Everything is recorded and sent with the sampled flag `01` (no sampling, LG-6 A).
 * - **Same data classes as the logs.** Every span leaves through {@link cleanSpan}: only the
 *   attributes in {@link SPAN_ATTRIBUTES} (routes, methods, statuses, outcomes, query names,
 *   outside services and operations, job names), span names without addresses, query strings or
 *   any path but the span's own route pattern,
 *   and exceptions reduced to their type. Never an IP, email, user agent, URL query, search term,
 *   story text, token, cookie, or the id of a person or story.
 * - **No trace state.** An incoming `tracestate` header is ignored ({@link TraceparentOnly}), and
 *   every span leaves without one ({@link cleanSpan}): it is free text a caller chooses, so it could
 *   carry anything (an email, a token) past the attribute allowlist.
 * - **Only request and job timelines.** Next's start-up spans (an instance loading its route
 *   modules, outside any request) are not sent ({@link RequestsAndJobsOnly}).
 * - **Never in the way.** Off unless `AXIOM_TRACES_DATASET`, `AXIOM_DOMAIN` and
 *   `AXIOM_TOKEN_SECRET` (`axiom-ingest-token`, the same token as the logs) are set: locally and in
 *   tests nothing is sent. Partly set: one start-up warning, never a failed start. The token is
 *   read when the first batch is sent (a few seconds after the first request), not at start-up,
 *   so reading it never adds to a cold start; if it can't be read, one warning then, and spans
 *   are dropped. Sending is the batch processor's, off the request path; a failed send is dropped with
 *   one warning a minute. {@link flushTracing} sends what is left at shutdown, within a time cap.
 */
import {
  context,
  propagation,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type SpanContext,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  type ExportResult,
  ExportResultCode,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  type IdGenerator,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { randomBytes } from 'node:crypto';
import {
  formatLogEntry,
  serviceFields,
  severityEnabled,
  writeLog,
} from './index';
import { uuidv7 } from './event/trace';

/** The span context without its trace state: trace id, span id, flags (and whether remote). */
export const withoutTraceState = ({
  traceId,
  spanId,
  traceFlags,
  isRemote,
}: SpanContext): SpanContext => ({
  traceId,
  spanId,
  traceFlags,
  ...(isRemote !== undefined ? { isRemote } : {}),
});

/**
 * The W3C trace-context propagator, without `tracestate`: an incoming `traceparent` is continued,
 * its `tracestate` dropped (it is a caller's free text), and none is sent on.
 */
export class TraceparentOnly implements TextMapPropagator {
  private readonly w3c = new W3CTraceContextPropagator();

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const span = trace.getSpanContext(ctx);
    if (!span) return;
    this.w3c.inject(
      trace.setSpanContext(ctx, withoutTraceState(span)),
      carrier,
      setter,
    );
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const out = this.w3c.extract(ctx, carrier, getter);
    // No traceparent read: the context as it was (its active span untouched).
    if (out === ctx) return out;
    const span = trace.getSpanContext(out);
    return span ? trace.setSpanContext(out, withoutTraceState(span)) : out;
  }

  fields(): string[] {
    return ['traceparent'];
  }
}

/** Trace ids are UUID v7s (the Reference, LG-1b A); span ids are random. */
export const uuidv7TraceIds: IdGenerator = {
  generateTraceId: () => uuidv7().replace(/-/g, ''),
  generateSpanId: () => randomBytes(8).toString('hex'),
};

/**
 * The only span attributes that leave the process (the logs' data classes, LG-2; LG-15). Ours:
 * `http.*` (method, route pattern, status), `outcome`, `error.type / code`, `db.*` (SurrealDB and
 * the query's name: a function or a statement and table, never the variables), `external.*` (the
 * service and the HTTP method), `job.name`, `process.cold_start / uptime_ms` (LG-12). Next's own (the website): its route patterns, span
 * kinds, fetch cache state and the API host it called. A new attribute needs Joel's decision
 * first (AGENTS.md, logging).
 */
export const SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.method',
  'http.route',
  'http.status_code',
  'outcome',
  'error.type',
  'error.code',
  'db.system.name',
  'db.operation.name',
  'external.service',
  'external.operation',
  'job.name',
  'process.cold_start',
  'process.uptime_ms',
  'next.route',
  'next.span_name',
  'next.span_type',
  'next.rsc',
  'next.segment',
  'next.fetch.cache_status',
  'next.fetch.cache_reason',
  'next.fetch.idx',
  'net.peer.name',
  'net.peer.port',
]);

/**
 * A span name that may leave the process: an address becomes its host, anything after a `?` or
 * `#` goes, and a path stays only if it is the span's own route pattern (`routes`: its
 * `http.route` / `next.route`, which are templates such as `/stories/[slug]`). Any other path
 * (a real address a future Next version might put there, or a page file's path) is dropped, so a
 * story's slug or anything a visitor typed can't reach a span name.
 */
export function cleanSpanName(
  name: string,
  routes: readonly unknown[] = [],
): string {
  return name
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s?#]+)\S*/gi, '$1')
    .replace(/[?#]\S*/g, '')
    .split(/\s+/)
    .filter((word) => !word.includes('/') || routes.includes(word))
    .join(' ')
    .trim();
}

/** The span's own route patterns (allowlisted attributes, set by us or by Next). */
const routesOf = (attributes: Attributes) =>
  [attributes['http.route'], attributes['next.route']].filter(
    (r): r is string => typeof r === 'string',
  );

function cleanValue(
  key: string,
  value: AttributeValue | undefined,
  routes: readonly string[],
) {
  if (value === undefined) return undefined;
  if (key === 'next.span_name' && typeof value === 'string') {
    return cleanSpanName(value, routes);
  }
  // A string that still looks like an address or carries a query never leaves.
  if (typeof value === 'string' && /[?#]|:\/\//.test(value)) return undefined;
  return value;
}

function cleanAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  const routes = routesOf(attributes);
  for (const [key, value] of Object.entries(attributes)) {
    if (!SPAN_ATTRIBUTES.has(key)) continue;
    const clean = cleanValue(key, value, routes);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/**
 * The span as it may leave the process: allowed attributes only, a clean name, exceptions
 * reduced to their type (an exception's message or stack can quote a request), no attributes on
 * links, no trace state (its own, its parent's or a link's), and `resource` (this process's
 * {@link spanResource} at the time of sending) if given. Everything else (ids, flags, times,
 * status code, kind) as it was.
 */
export function cleanSpan(
  span: ReadableSpan,
  resource: Resource = span.resource,
): ReadableSpan {
  const own = withoutTraceState(span.spanContext());
  const parent = span.parentSpanContext;
  const events = span.events.map((e) => {
    const type = e.attributes?.['exception.type'];
    return {
      name: e.name,
      time: e.time,
      attributes: typeof type === 'string' ? { 'exception.type': type } : {},
      droppedAttributesCount: 0,
    };
  });
  return Object.create(span, {
    name: {
      value: cleanSpanName(span.name, routesOf(span.attributes)),
      enumerable: true,
    },
    attributes: { value: cleanAttributes(span.attributes), enumerable: true },
    events: { value: events, enumerable: true },
    links: {
      value: span.links.map((l) => ({ context: withoutTraceState(l.context) })),
      enumerable: true,
    },
    spanContext: { value: () => own, enumerable: true },
    parentSpanContext: {
      value: parent && withoutTraceState(parent),
      enumerable: true,
    },
    resource: { value: resource, enumerable: true },
    status: {
      // A status message is free text (Next puts the error's message there).
      value: { code: span.status.code },
      enumerable: true,
    },
  }) as ReadableSpan;
}

const WARN_EVERY_MS = 60_000;

/**
 * Next's spans that load code (an instance loading its route modules at start-up). Inside a
 * request they are part of its timeline; as the first span of a trace they are start-up work.
 */
const STARTUP_SPAN_TYPES =
  /^(Instrumentation|LoadComponents|RouteModule|AppRouteRouteModule)\.|^NextNodeServer\.(findPageComponents|getLayoutOrPageModule|createComponentTree|clientComponentLoading)$/;

/**
 * Hands only request and job timelines to `next`: a trace that starts with one of Next's
 * code-loading spans (no request around it, {@link STARTUP_SPAN_TYPES}) is dropped whole.
 */
export class RequestsAndJobsOnly implements SpanProcessor {
  /** Start-up traces still open: trace id → their first span's id. */
  private readonly startup = new Map<string, string>();

  constructor(private readonly next: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const { traceId, spanId } = span.spanContext();
    const type = span.attributes['next.span_type'];
    if (
      !span.parentSpanContext &&
      typeof type === 'string' &&
      STARTUP_SPAN_TYPES.test(type)
    ) {
      this.startup.set(traceId, spanId);
      return;
    }
    if (this.startup.has(traceId)) return;
    this.next.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const { traceId, spanId } = span.spanContext();
    const first = this.startup.get(traceId);
    if (first === undefined) return this.next.onEnd(span);
    if (first === spanId) this.startup.delete(traceId);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/**
 * The process's resource (LG-10, the wide event's `service` group): `service.name / version /
 * revision`, `service.region` and `service.instance` (Cloud Run, once Google's metadata server has
 * answered) and `deployment.environment.name`. Read again for each batch, so the region and
 * instance found after start-up are on every span sent after that.
 */
export function spanResource(service: string): Resource {
  const fields = serviceFields(service);
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries({
    'service.name': fields.name,
    'service.version': fields.version,
    'service.revision': fields.revision,
    'service.region': fields.region,
    'service.instance': fields.instance,
    'deployment.environment.name': fields.env,
  })) {
    if (value !== undefined) attributes[key] = value;
  }
  return resourceFromAttributes(attributes);
}

/**
 * Cleans every span ({@link cleanSpan}, with `resource()` as its resource) and hands it to the exporter `exporter()` gives: the OTLP
 * exporter is made the first time it is asked for, once the token has been read (dropped, with a
 * failure, if the token never comes). A failed send is dropped, with one stdout warning a minute.
 * Never throws.
 */
export class CleanExporter implements SpanExporter {
  private lastWarning = -Infinity;
  private dropped = 0;

  constructor(
    private readonly exporter: () => Promise<SpanExporter | undefined>,
    private readonly resource?: () => Resource,
    private readonly now: () => number = Date.now,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    const fail = () => {
      this.drop(spans.length);
      done({ code: ExportResultCode.FAILED });
    };
    this.exporter().then((exporter) => {
      if (!exporter) return fail();
      try {
        // One resource object per batch: the OTLP exporter groups spans by it.
        const resource = this.resource?.();
        exporter.export(
          spans.map((span) => cleanSpan(span, resource)),
          (result) => {
            if (result.code !== ExportResultCode.SUCCESS) {
              this.drop(spans.length);
            }
            done(result);
          },
        );
      } catch {
        fail();
      }
    }, fail);
  }

  async shutdown(): Promise<void> {
    const exporter = await this.exporter().catch(() => undefined);
    await exporter?.shutdown().catch(() => undefined);
  }

  async forceFlush(): Promise<void> {
    const exporter = await this.exporter().catch(() => undefined);
    await exporter?.forceFlush?.().catch(() => undefined);
  }

  /** Spans that couldn't be sent. */
  failed(): number {
    return this.dropped;
  }

  private drop(count: number) {
    this.dropped += count;
    if (this.now() - this.lastWarning < WARN_EVERY_MS) return;
    this.lastWarning = this.now();
    // stdout only, like the Axiom log sink's own warning.
    if (severityEnabled('WARNING')) {
      console.log(
        formatLogEntry('WARNING', "Couldn't send spans to Axiom", {
          event: 'logging',
          dropped_count: this.dropped,
        }),
      );
    }
  }
}

const DOMAIN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DATASET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEND_TIMEOUT_MS = 10_000;

const STARTED = Symbol.for('heisreal.logging.tracing');
type Started = { provider: TracerProvider; exporter: CleanExporter };
const started = globalThis as { [STARTED]?: Started };

export interface TracingOptions {
  /** The service or job (`api-user`): `service.name` on every span, like the logs (LG-10). */
  service: string;
  /** Reads a Secret Manager secret by name (libs/secrets). */
  read?: (secretName: string) => Promise<string>;
  env?: Record<string, string | undefined>;
  /** Tests: spans go here instead (no settings needed, nothing cleaned away from the test's view
   * except what {@link cleanSpan} removes). */
  exporter?: SpanExporter;
  /** Tests: the processor's delay before sending a batch. */
  scheduledDelayMillis?: number;
}

/**
 * Starts tracing if this process is configured for it, before anything else in `main.ts` (or the
 * website's `register`). Synchronous: the tracer is registered at once; the token is read with
 * the first batch. Returns whether spans are recorded. Never throws; a second call does nothing.
 */
export function startTracing({
  service,
  read,
  env = globalThis.process?.env ?? {},
  exporter: testExporter,
  scheduledDelayMillis,
}: TracingOptions): boolean {
  if (started[STARTED]) return true;
  try {
    let target: () => Promise<SpanExporter | undefined>;
    if (testExporter) {
      target = () => Promise.resolve(testExporter);
    } else {
      const dataset = env['AXIOM_TRACES_DATASET']?.trim();
      const domain = env['AXIOM_DOMAIN']?.trim();
      const secret = env['AXIOM_TOKEN_SECRET']?.trim();
      if (!dataset && !domain && !secret) return false;
      const warn = (reason: string) => {
        writeLog('WARNING', `Spans are not sent to Axiom: ${reason}`, {
          event: 'startup',
        });
        return false;
      };
      if (!dataset || !domain || !secret || !read) {
        return warn(
          'AXIOM_TRACES_DATASET, AXIOM_DOMAIN and AXIOM_TOKEN_SECRET must all be set',
        );
      }
      if (!DOMAIN.test(domain)) return warn('AXIOM_DOMAIN is malformed');
      if (!DATASET.test(dataset)) {
        return warn('AXIOM_TRACES_DATASET is malformed');
      }
      let made: Promise<SpanExporter | undefined> | undefined;
      const make = (): Promise<SpanExporter | undefined> =>
        read(secret).then(
          (value) => {
            const token = value.trim();
            if (!token) {
              warn(`the token (${secret}) is empty`);
              return undefined;
            }
            return new OTLPTraceExporter({
              url: `https://${domain}/v1/traces`,
              headers: {
                Authorization: `Bearer ${token}`,
                'X-Axiom-Dataset': dataset,
              },
              timeoutMillis: SEND_TIMEOUT_MS,
            });
          },
          () => {
            warn(`the token (${secret}) couldn't be read`);
            return undefined;
          },
        );
      target = () => (made ??= make());
    }
    const exporter = new CleanExporter(target, () => spanResource(service));
    const provider = new TracerProvider({
      sampler: new AlwaysOnSampler(),
      idGenerator: uuidv7TraceIds,
      resource: spanResource(service),
      spanProcessors: [
        new RequestsAndJobsOnly(
          new BatchSpanProcessor({
            exporter,
            exportTimeoutMillis: SEND_TIMEOUT_MS,
            ...(scheduledDelayMillis !== undefined
              ? { scheduledDelayMillis }
              : {}),
          }),
        ),
      ],
    });
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    propagation.setGlobalPropagator(new TraceparentOnly());
    trace.setGlobalTracerProvider(provider);
    started[STARTED] = { provider, exporter };
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends the spans still waiting, within `timeoutMs` (shutdown, beside `flushLogSinks`). Resolves,
 * never rejects; does nothing when tracing is off.
 */
export async function flushTracing(timeoutMs = 3000): Promise<void> {
  const provider = started[STARTED]?.provider;
  if (!provider) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    provider.forceFlush().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/** Spans that couldn't be sent. */
export function failedSpanExports(): number {
  return started[STARTED]?.exporter.failed() ?? 0;
}

/** Stops tracing and forgets the provider (tests). */
export async function resetTracing(): Promise<void> {
  const current = started[STARTED];
  delete started[STARTED];
  trace.disable();
  context.disable();
  propagation.disable();
  await current?.provider.shutdown().catch(() => undefined);
}

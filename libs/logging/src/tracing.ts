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
 *   outside services and operations, job names), span names without addresses or query strings,
 *   and exceptions reduced to their type. Never an IP, email, user agent, URL query, search term,
 *   story text, token, cookie, or the id of a person or story.
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
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  type ExportResult,
  ExportResultCode,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  type IdGenerator,
  type ReadableSpan,
  type SpanExporter,
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

/** Trace ids are UUID v7s (the Reference, LG-1b A); span ids are random. */
export const uuidv7TraceIds: IdGenerator = {
  generateTraceId: () => uuidv7().replace(/-/g, ''),
  generateSpanId: () => randomBytes(8).toString('hex'),
};

/**
 * The only span attributes that leave the process (the logs' data classes, LG-2; LG-15). Ours:
 * `http.*` (method, route pattern, status), `outcome`, `error.type / code`, `db.*` (SurrealDB and
 * the query's name: a function or a statement and table, never the variables), `external.*` (the
 * service and the HTTP method), `job.name`. Next's own (the website): its route patterns, span
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

/** An address in a span name becomes its host; anything after a `?` goes. */
export function cleanSpanName(name: string): string {
  return name
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s?#]+)\S*/gi, '$1')
    .replace(/[?#]\S*/g, '');
}

function cleanValue(key: string, value: AttributeValue | undefined) {
  if (value === undefined) return undefined;
  if (key === 'next.span_name' && typeof value === 'string') {
    return cleanSpanName(value);
  }
  // A string that still looks like an address or carries a query never leaves.
  if (typeof value === 'string' && /[?#]|:\/\//.test(value)) return undefined;
  return value;
}

function cleanAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!SPAN_ATTRIBUTES.has(key)) continue;
    const clean = cleanValue(key, value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/**
 * The span as it may leave the process: allowed attributes only, a clean name, exceptions
 * reduced to their type (an exception's message or stack can quote a request), no attributes on
 * links. Everything else (ids, times, status code, kind) as it was.
 */
export function cleanSpan(span: ReadableSpan): ReadableSpan {
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
    name: { value: cleanSpanName(span.name), enumerable: true },
    attributes: { value: cleanAttributes(span.attributes), enumerable: true },
    events: { value: events, enumerable: true },
    links: {
      value: span.links.map((l) => ({ context: l.context })),
      enumerable: true,
    },
    status: {
      // A status message is free text (Next puts the error's message there).
      value: { code: span.status.code },
      enumerable: true,
    },
  }) as ReadableSpan;
}

const WARN_EVERY_MS = 60_000;

/**
 * Cleans every span ({@link cleanSpan}) and hands it to the exporter `exporter()` gives: the OTLP
 * exporter is made the first time it is asked for, once the token has been read (dropped, with a
 * failure, if the token never comes). A failed send is dropped, with one stdout warning a minute.
 * Never throws.
 */
export class CleanExporter implements SpanExporter {
  private lastWarning = -Infinity;
  private dropped = 0;

  constructor(
    private readonly exporter: () => Promise<SpanExporter | undefined>,
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
        exporter.export(spans.map(cleanSpan), (result) => {
          if (result.code !== ExportResultCode.SUCCESS) this.drop(spans.length);
          done(result);
        });
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
    const exporter = new CleanExporter(target);
    const fields = serviceFields(service);
    const provider = new TracerProvider({
      sampler: new AlwaysOnSampler(),
      idGenerator: uuidv7TraceIds,
      resource: resourceFromAttributes({
        'service.name': fields.name,
        'service.version': fields.version,
        'service.revision': fields.revision,
        'deployment.environment': fields.env,
      }),
      spanProcessors: [
        new BatchSpanProcessor({
          exporter,
          exportTimeoutMillis: SEND_TIMEOUT_MS,
          ...(scheduledDelayMillis !== undefined
            ? { scheduledDelayMillis }
            : {}),
        }),
      ],
    });
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
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

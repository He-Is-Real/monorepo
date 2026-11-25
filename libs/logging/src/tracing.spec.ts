import { ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setInstanceLookup } from './index';
import {
  LOG_SINKS,
  type LogSink,
  runWithEvent,
  serviceFields,
  startEvent,
  timeDb,
} from './event';
import {
  failedSpanExports,
  flushTracing,
  resetTracing,
  startTracing,
} from './tracing';

type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Tracing off or failing never changes the work (LG-15: "never in the way"). */
describe('tracing set-up (LG-15)', () => {
  const entries: Entry[] = [];
  const sink: LogSink = { write: (_s, entry) => entries.push(entry) };
  const log = console.log;

  beforeEach(() => {
    LOG_SINKS.splice(0, LOG_SINKS.length, sink);
    entries.length = 0;
    console.log = () => undefined;
  });

  afterEach(async () => {
    console.log = log;
    await resetTracing();
  });

  it('records and sends nothing when not configured (locally, tests)', async () => {
    const read = vi.fn(async () => 'token');
    expect(startTracing({ service: 'api-user', env: {}, read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const event = startEvent('request', 'api-user');
    expect(event.span).toBeUndefined();
    // The reference is still a UUID v7.
    expect(event.ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('partly configured, or a token that can’t be read: a start-up warning, never a failed start', async () => {
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    expect(
      startTracing({
        service: 'api-user',
        env: { AXIOM_TRACES_DATASET: 'heisreal-traces' },
        read: async () => 'token',
      }),
    ).toBe(false);
    expect(lines.join()).toContain('Spans are not sent to Axiom');

    lines.length = 0;
    expect(
      startTracing({
        service: 'api-user',
        env: {
          AXIOM_TRACES_DATASET: 'heisreal-traces',
          AXIOM_DOMAIN: 'eu-central-1.aws.edge.axiom.co',
          AXIOM_TOKEN_SECRET: 'axiom-ingest-token',
        },
        read: async () => {
          throw new Error('NOT_FOUND');
        },
      }),
    ).toBe(true);
    const event = startEvent('request', 'api-user');
    await runWithEvent(event, () => timeDb('SELECT story', async () => 1));
    event.write();
    await flushTracing(1000);
    expect(lines.join()).toContain(
      "the token (axiom-ingest-token) couldn't be read",
    );
    expect(failedSpanExports()).toBe(2);
  });

  describe('a token that can’t be read at first (25 Nov 2026: the website’s read starved between requests)', () => {
    const ENV = {
      AXIOM_TRACES_DATASET: 'heisreal-traces',
      AXIOM_DOMAIN: 'eu-central-1.aws.edge.axiom.co',
      AXIOM_TOKEN_SECRET: 'axiom-ingest-token',
    };

    /** Reads that fail `failures` times (a gRPC UNAVAILABLE), then return the token. */
    const flakyRead = (failures: number) =>
      vi.fn(async () => {
        if (failures-- > 0) {
          throw Object.assign(
            new Error('14 UNAVAILABLE: projects/p/secrets/s quoted'),
            { code: 14 },
          );
        }
        return 'xaat-test-token';
      });

    const oneRequest = async () => {
      const event = startEvent('request', 'api-user');
      await runWithEvent(event, () => timeDb('SELECT story', async () => 1));
      event.write();
      await flushTracing(1000);
    };

    it('reads again with a later batch, then sends: one warning, with the error’s type and code only', async () => {
      const sent: ReadableSpan[] = [];
      const configs: { url: string; headers: Record<string, string> }[] = [];
      const lines: string[] = [];
      console.log = (line: string) => lines.push(line);
      // The start-up read and the first batch's read fail; the second batch's read works.
      const read = flakyRead(2);
      startTracing({
        service: 'api-user',
        env: ENV,
        read,
        tokenRetryMs: 0,
        otlp: (config) => {
          configs.push(config);
          return {
            export: (spans, done) => {
              sent.push(...spans);
              done({ code: ExportResultCode.SUCCESS });
            },
            shutdown: async () => undefined,
          };
        },
      });
      // Read at start-up, before any span (and failed).
      expect(read).toHaveBeenCalledTimes(1);
      await new Promise(setImmediate);

      await oneRequest();
      expect(sent).toHaveLength(0);
      expect(failedSpanExports()).toBe(2);

      await oneRequest();
      expect(read).toHaveBeenCalledTimes(3);
      expect(sent.map((s) => s.name)).toEqual(['db SELECT story', 'request']);
      expect(configs).toEqual([
        {
          url: 'https://eu-central-1.aws.edge.axiom.co/v1/traces',
          headers: {
            Authorization: 'Bearer xaat-test-token',
            'X-Axiom-Dataset': 'heisreal-traces',
          },
          timeoutMillis: 10_000,
        },
      ]);

      const warnings = lines
        .map((l) => JSON.parse(l) as Entry)
        .filter((e) => String(e['message']).startsWith('Spans are not sent'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.['error']).toEqual({ type: 'Error', code: 14 });
      expect(lines.join()).not.toContain('quoted');
    });

    it('reads at most once a minute: batches in between are dropped without a read', async () => {
      const read = flakyRead(Infinity);
      startTracing({
        service: 'api-user',
        env: ENV,
        read,
        otlp: () => {
          throw new Error('never made without a token');
        },
      });
      await oneRequest();
      await oneRequest();
      expect(read).toHaveBeenCalledTimes(1);
      expect(failedSpanExports()).toBe(4);
    });
  });

  it('a failing exporter never throws into the work', async () => {
    const throwing: SpanExporter = {
      export: () => {
        throw new Error('network down');
      },
      shutdown: async () => undefined,
    };
    expect(startTracing({ service: 'api-user', exporter: throwing })).toBe(
      true,
    );
    const event = startEvent('request', 'api-user');
    expect(event.span).toBeDefined();
    const result = await runWithEvent(event, () =>
      timeDb('SELECT story', async () => 'answer'),
    );
    expect(result).toBe('answer');
    event.write();
    await flushTracing(1000);
    expect(entries.filter((e) => e['event'] === 'request')).toHaveLength(1);
    expect(failedSpanExports()).toBe(2);
  });

  it('drops attributes outside the data classes and addresses in span names', async () => {
    const sent: ReadableSpan[] = [];
    const memory: SpanExporter = {
      export: (spans, done) => {
        sent.push(...spans);
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => undefined,
    };
    startTracing({ service: 'web', exporter: memory });
    const { trace } = await import('@opentelemetry/api');
    // What Next's own spans record (its request and fetch spans).
    const span = trace
      .getTracer('next.js')
      .startSpan(
        'fetch GET https://api-public-read.example/v1/stories?q=healing',
        {
          attributes: {
            'http.url': 'https://api-public-read.example/v1/stories?q=healing',
            'http.target': '/stories?q=healing',
            'http.method': 'GET',
            'net.peer.name': 'api-public-read.example',
            'next.span_name':
              'fetch GET https://api-public-read.example/v1/stories?q=healing',
            'next.route': '/stories',
          },
        },
      );
    span.recordException(new Error('no story for sam@example.com'));
    span.setStatus({ code: 2, message: 'no story for sam@example.com' });
    span.end();
    await flushTracing(1000);
    expect(sent).toHaveLength(1);
    const [clean] = sent;
    expect(clean.name).toBe('fetch GET api-public-read.example');
    expect(clean.attributes).toEqual({
      'http.method': 'GET',
      'net.peer.name': 'api-public-read.example',
      'next.span_name': 'fetch GET api-public-read.example',
      'next.route': '/stories',
    });
    expect(clean.events.map((e) => e.attributes)).toEqual([
      { 'exception.type': 'Error' },
    ]);
    expect(JSON.stringify([clean.status, clean.events])).not.toContain('sam@');
  });

  it('keeps a path in a span name only when it is the span’s own route pattern', async () => {
    const sent: ReadableSpan[] = [];
    startTracing({
      service: 'web',
      exporter: {
        export: (spans, done) => {
          sent.push(...spans);
          done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: async () => undefined,
      },
    });
    const { trace } = await import('@opentelemetry/api');
    const tracer = trace.getTracer('next.js');
    const end = (name: string, attributes = {}) =>
      tracer.startSpan(name, { attributes }).end();
    end('GET /stories/[slug]', { 'next.route': '/stories/[slug]' });
    end('GET /stories/my-healing-story', { 'next.route': '/stories/[slug]' });
    end('generateMetadata /stories/page');
    end('db fn::submit_story');
    await flushTracing(1000);
    expect(sent.map((s) => s.name)).toEqual([
      'GET /stories/[slug]',
      'GET',
      'generateMetadata',
      'db fn::submit_story',
    ]);
  });

  it('sends no trace state: an incoming tracestate never reaches the exported payload', async () => {
    // A real OTLP/HTTP exporter, sending to a local server: what Axiom would receive.
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      startTracing({
        service: 'web',
        exporter: new OTLPTraceExporter({
          url: `http://127.0.0.1:${port}/v1/traces`,
        }),
      });
      const { context, propagation, trace, createTraceState } =
        await import('@opentelemetry/api');
      const tracer = trace.getTracer('next.js');
      // Next continues an incoming request's headers through the global propagator.
      const caller = '01a204cc3df67f13903075f14addacc4';
      const incoming = propagation.extract(context.active(), {
        traceparent: `00-${caller}-00f067aa0ba902b7-01`,
        tracestate: 'vendor=sam@example.com',
      });
      expect(trace.getSpanContext(incoming)?.traceState).toBeUndefined();
      const span = tracer.startSpan('BaseServer.handleRequest', {}, incoming);
      // Nothing is sent on either.
      const out: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), out);
      expect(Object.keys(out)).toEqual(['traceparent']);
      span.end();
      // A span whose parent carries a trace state some other way, linked to one too.
      const stated = trace.setSpanContext(context.active(), {
        traceId: caller,
        spanId: '00f067aa0ba902b8',
        traceFlags: 1,
        isRemote: true,
        traceState: createTraceState('vendor=sam@example.com'),
      });
      tracer
        .startSpan(
          'child',
          {
            links: [
              { context: trace.getSpanContext(stated)! }, // eslint-disable-line @typescript-eslint/no-non-null-assertion
            ],
          },
          stated,
        )
        .end();
      await flushTracing(2000);
      const payload = bodies.join();
      expect(payload).toContain(caller);
      expect(payload).not.toContain('sam@');
      expect(payload).not.toContain('vendor');
      expect(payload).not.toMatch(/"traceState":"[^"]/);
    } finally {
      server.close();
    }
  });

  it('sends only request and job timelines, not Next’s start-up module loading', async () => {
    const sent: ReadableSpan[] = [];
    startTracing({
      service: 'web',
      exporter: {
        export: (spans, done) => {
          sent.push(...spans);
          done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: async () => undefined,
      },
    });
    const { context, trace } = await import('@opentelemetry/api');
    const tracer = trace.getTracer('next.js');
    const nextSpan = (type: string, parent = context.active()) =>
      tracer.startSpan(
        type,
        { attributes: { 'next.span_type': type } },
        parent,
      );
    // Start-up: an instance loading a route module, with a span inside it.
    const load = nextSpan('LoadComponents.loadRouteModule');
    nextSpan(
      'AppRouteRouteModule.loadUserland',
      trace.setSpan(context.active(), load),
    ).end();
    load.end();
    nextSpan('Instrumentation.register').end();
    // A request that loads a module while it runs: all of it is kept.
    const request = nextSpan('BaseServer.handleRequest');
    nextSpan(
      'LoadComponents.loadRouteModule',
      trace.setSpan(context.active(), request),
    ).end();
    request.end();
    // Our own job span.
    const event = startEvent('job', 'housekeeping');
    event.write();
    await flushTracing(1000);
    expect(sent.map((s) => s.name)).toEqual([
      'LoadComponents.loadRouteModule',
      'BaseServer.handleRequest',
      'job',
    ]);
    expect(sent[0].parentSpanContext?.spanId).toBe(
      sent[1].spanContext().spanId,
    );
    expect(sent[2].attributes).toMatchObject({
      'process.cold_start': expect.any(Boolean),
      'process.uptime_ms': expect.any(Number),
    });
  });

  it('every span carries the service, its environment, and the Cloud Run region and instance once known', async () => {
    const sent: ReadableSpan[] = [];
    startTracing({
      service: 'api-user',
      exporter: {
        export: (spans, done) => {
          sent.push(...spans);
          done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: async () => undefined,
      },
    });
    let found:
      ((f: { region?: string; instance?: string }) => void) | undefined;
    setInstanceLookup((_env, done) => (found = done));
    const { trace } = await import('@opentelemetry/api');
    // Started before the metadata server answers, sent after.
    const span = trace.getTracer('t').startSpan('request');
    serviceFields(undefined, { K_SERVICE: 'api-user' });
    found?.({ region: 'europe-west2', instance: '0069c7a2b1f00d' });
    span.end();
    await flushTracing(1000);
    expect(sent[0].resource.attributes).toMatchObject({
      'service.name': 'api-user',
      'service.version': 'dev',
      'deployment.environment.name': 'local',
      'service.region': 'europe-west2',
      'service.instance': '0069c7a2b1f00d',
    });
    expect(sent[0].resource.attributes).not.toHaveProperty(
      'deployment.environment',
    );
  });
});

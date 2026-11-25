import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import {
  LOG_SINKS,
  type LogSink,
  runWithEvent,
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
});

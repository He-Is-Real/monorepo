import {
  Body,
  Controller,
  type INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SpanKind } from '@opentelemetry/api';
import {
  LOG_SINKS,
  type LogSink,
  timeDb,
  timedFetch,
} from '@heisreal/logging/event';
import {
  flushTracing,
  resetTracing,
  startTracing,
} from '@heisreal/logging/tracing';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { ProblemFilter } from './problem.filter';
import { wideEvents } from './wide-events';

/**
 * OpenTelemetry spans (LG-15 D): each request is one server span named by its route pattern, with
 * its database and outside calls as child spans, all in the trace whose id is the request's `ref`.
 */

@Controller('v1/stories')
class Probe {
  @Post(':id/submit')
  async submit(@Body() body: { title: string }) {
    await timeDb('fn::submit_story', async () => undefined);
    await timedFetch('bunny', async () => new Response(null, { status: 201 }))(
      'https://storage.bunnycdn.com/zone/story:k3j9/photo.jpg?token=secret',
      { method: 'PUT' },
    );
    return { ok: body.title.length };
  }
}

@Module({ controllers: [Probe] })
class ProbeModule {}

type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('request spans (LG-15)', () => {
  let app: INestApplication;
  let url: string;
  const exporter = new InMemorySpanExporter();
  const entries: Entry[] = [];
  const sink: LogSink = { write: (_s, entry) => entries.push(entry) };

  beforeAll(async () => {
    LOG_SINKS.splice(0, LOG_SINKS.length, sink);
    expect(startTracing({ service: 'api-user', exporter })).toBe(true);
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(wideEvents('api-user'));
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    await resetTracing();
  });

  beforeEach(() => {
    exporter.reset();
    entries.length = 0;
  });

  /** Sends one request and returns its event and every span of its trace. */
  async function request(headers: Record<string, string> = {}) {
    const res = await fetch(`${url}/v1/stories/k3j9/submit?q=healing`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
        ...headers,
      },
      body: JSON.stringify({ title: 'The night' }),
    });
    expect(res.status).toBe(201);
    await res.arrayBuffer();
    // The event is written when the response closes; then the span is ended and batched.
    await vi.waitFor(() =>
      expect(entries.some((e) => e['event'] === 'request')).toBe(true),
    );
    await flushTracing(1000);
    const event = entries.find((e) => e['event'] === 'request') as Entry;
    const traceId = event['ref'].replace(/-/g, '');
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.spanContext().traceId === traceId);
    return { event, traceId, spans };
  }

  it('makes one server span by route pattern, with the database and outside calls as its children', async () => {
    const { event, spans } = await request();
    const server = spans.filter((s) => s.kind === SpanKind.SERVER);
    expect(server).toHaveLength(1);
    const [span] = server;
    expect(span.name).toBe('POST /v1/stories/:id/submit');
    // A new trace: its id is a UUID v7 (the Reference), and the event's ref.
    expect(event['ref']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).toEqual({
      'http.method': 'POST',
      'http.route': '/v1/stories/:id/submit',
      'http.status_code': 201,
      outcome: 'ok',
    });

    const children = spans.filter((s) => s !== span);
    expect(
      children.map((s) => ({
        name: s.name,
        kind: s.kind,
        parent: s.parentSpanContext?.spanId,
        attributes: s.attributes,
      })),
    ).toEqual([
      {
        name: 'db fn::submit_story',
        kind: SpanKind.CLIENT,
        parent: span.spanContext().spanId,
        attributes: {
          'db.system.name': 'surrealdb',
          'db.operation.name': 'fn::submit_story',
        },
      },
      {
        name: 'bunny PUT',
        kind: SpanKind.CLIENT,
        parent: span.spanContext().spanId,
        attributes: {
          'external.service': 'bunny',
          'external.operation': 'PUT',
          'http.status_code': 201,
        },
      },
    ]);
    // Nothing about the person, the story or the address leaves in a span.
    const text = JSON.stringify(
      spans.map((s) => [s.name, s.attributes, s.events]),
    );
    for (const never of ['k3j9', 'healing', 'Mozilla', '127.0.0.1', 'secret']) {
      expect(text).not.toContain(never);
    }
  });

  it('continues the caller’s traceparent: the same trace id, as the event’s ref', async () => {
    const caller = '01a204cc3df67f13903075f14addacc4';
    const { event, spans } = await request({
      // An unsampled flag is still recorded and sent (no sampling, LG-6 A).
      traceparent: `00-${caller}-00f067aa0ba902b7-00`,
    });
    expect(event['ref']).toBe('01a204cc-3df6-7f13-9030-75f14addacc4');
    const server = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(server?.spanContext().traceId).toBe(caller);
    expect(server?.spanContext().traceFlags).toBe(1);
    expect(server?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(spans).toHaveLength(3);
  });
});

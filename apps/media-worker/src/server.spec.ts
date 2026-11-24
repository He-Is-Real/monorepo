import type { AddressInfo } from 'node:net';
import { LOG_SINKS, type LogSink } from '@heisreal/logging/event';
import { BunnyStreamReader, checkAnswer } from './bunny';
import { SUBSCRIPTIONS, workerServer } from './server';
import { RenderSlot } from './worker';
import { httpWriter } from './writer';

/**
 * The worker as Dapr sees it: a raw `media-jobs` message delivered over Dapr's HTTP contract goes
 * to Bunny (a fake) and on to the result writer (a fake), signed in with the ID token, and the
 * reply tells Dapr whether to mark it taken. No real GCP or Bunny.
 */
const JOB = '01JC00000000000000000000AB';
const VIDEO = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STORY = '01JC0000000000000000000000';
const TOKEN = 'dapr-app-api-token-for-tests-0123456789';
const DAPR = { 'dapr-api-token': TOKEN };

async function start(writerStatus: number, writerBody: unknown) {
  const writerCalls: { url: string; init: RequestInit }[] = [];
  const bunny = new BunnyStreamReader(
    '789855',
    async () => 'readonly-key-for-tests',
    async () =>
      new Response(
        JSON.stringify({
          status: 4,
          title: STORY,
          width: 720,
          height: 1280,
          length: 41,
          thumbnailFileName: 'thumbnail.jpg',
        }),
      ),
  );
  const writer = httpWriter(
    'https://workflow.example.run.app/',
    async () => 'id-token-for-tests',
    async (url, init) => {
      writerCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(writerBody), { status: writerStatus });
    },
  );
  // The job events the worker writes (every sink gets the same lines).
  const logs: Record<string, unknown>[] = [];
  const capture: LogSink = { write: (_severity, entry) => logs.push(entry) };
  LOG_SINKS.push(capture);
  const server = workerServer(
    {
      check: (video) => checkAnswer(bunny, video),
      renderer: {
        render: async () => {
          throw new Error('no render here');
        },
      },
      renderSlot: new RenderSlot(),
      writer,
    },
    TOKEN,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((r) =>
      server.close(() => {
        LOG_SINKS.splice(LOG_SINKS.indexOf(capture), 1);
        r();
      }),
    );
  return { base, server, writerCalls, logs, close };
}

/** How Dapr delivers a raw message: a CloudEvent with the bytes in data_base64. */
const delivery = (job: unknown) => ({
  id: 'dapr-1',
  source: 'media-worker',
  type: 'com.dapr.event.sent',
  specversion: '1.0',
  datacontenttype: 'application/octet-stream',
  data_base64: Buffer.from(JSON.stringify(job)).toString('base64'),
  topic: 'media-jobs',
  pubsubname: 'media-jobs',
});

describe('the worker under Dapr', () => {
  let stop: () => Promise<void> = async () => undefined;
  afterEach(() => stop());

  it('asks Dapr for media-jobs as raw messages', async () => {
    const s = await start(200, {});
    stop = s.close;
    const res = await fetch(`${s.base}/dapr/subscribe`, { headers: DAPR });
    expect(await res.json()).toEqual(SUBSCRIPTIONS);
    expect(SUBSCRIPTIONS).toEqual([
      expect.objectContaining({
        pubsubname: 'media-jobs',
        topic: 'media-jobs',
        metadata: { rawPayload: 'true' },
      }),
    ]);
  });

  it('answers a check job at the writer, signed in, and marks it taken', async () => {
    const s = await start(200, { outcome: 'applied' });
    stop = s.close;
    const res = await fetch(`${s.base}/media-jobs`, {
      method: 'POST',
      headers: { ...DAPR, 'Content-Type': 'application/cloudevents+json' },
      body: JSON.stringify(
        delivery({ jobId: JOB, kind: 'check', videoId: VIDEO, eventId: 'e1' }),
      ),
    });
    expect(await res.json()).toEqual({ status: 'SUCCESS' });
    expect(s.writerCalls).toHaveLength(1);
    const [call] = s.writerCalls;
    expect(call.url).toBe(
      `https://workflow.example.run.app/v1/media-jobs/${JOB}/answer`,
    );
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer id-token-for-tests',
    );
    expect(JSON.parse(String(call.init.body))).toEqual({
      videoId: VIDEO,
      outcome: 'ready',
      title: STORY,
      width: 720,
      height: 1280,
      lengthSeconds: 41,
      thumbnailFileName: 'thumbnail.jpg',
    });
    // One job event: ids, steps and short codes only; its trace id went on to the writer.
    const events = s.logs.filter((l) => l['event'] === 'job');
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      severity: 'INFO',
      event: 'job',
      service: { name: 'media-worker' },
      outcome: 'ok',
      job: {
        id: JOB,
        name: 'media.check',
        video_id: VIDEO,
        event_id: 'e1',
        step: 'answered',
        code: 'ready:applied',
        delivery: 'SUCCESS',
        steps: [
          { name: 'check', outcome: 'ok', code: 'ready' },
          { name: 'answer', outcome: 'ok', status: 200 },
        ],
      },
    });
    const traceparent = (call.init.headers as Record<string, string>)[
      'traceparent'
    ];
    expect(traceparent.split('-')[1]).toBe(
      String(event['ref']).replace(/-/g, ''),
    );
  });

  it('leaves the job in the queue when the writer fails', async () => {
    const s = await start(503, { code: 'unavailable' });
    stop = s.close;
    const res = await fetch(`${s.base}/media-jobs`, {
      method: 'POST',
      headers: DAPR,
      body: JSON.stringify(
        delivery({ jobId: JOB, kind: 'check', videoId: VIDEO }),
      ),
    });
    expect(await res.json()).toEqual({ status: 'RETRY' });
    expect(s.logs.filter((l) => l['event'] === 'job')).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        outcome: 'error',
        error: { type: 'media_job', code: '503', retriable: true },
      }),
    ]);
  });

  it('drops a message it cannot read, calling nobody', async () => {
    const s = await start(200, {});
    stop = s.close;
    const res = await fetch(`${s.base}/media-jobs`, {
      method: 'POST',
      headers: DAPR,
      body: JSON.stringify({ data_base64: 'bm90IGpzb24=' }),
    });
    expect(await res.json()).toEqual({ status: 'DROP' });
    expect(s.writerCalls).toEqual([]);
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { 'dapr-api-token': 'x'.repeat(40) }],
  ])(
    'refuses a call with %s (another program, or a web page posting to 127.0.0.1)',
    async (_, headers) => {
      const s = await start(200, { outcome: 'applied' });
      stop = s.close;
      const res = await fetch(`${s.base}/media-jobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          delivery({ jobId: JOB, kind: 'check', videoId: VIDEO }),
        ),
      });
      expect(res.status).toBe(401);
      expect(s.writerCalls).toEqual([]);
    },
  );
});

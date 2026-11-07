import type { AddressInfo } from 'node:net';
import { BunnyStreamReader, checkAnswer } from './bunny';
import { SUBSCRIPTIONS, workerServer } from './server';
import { httpWriter } from './writer';

/**
 * The worker as Dapr sees it: a raw `media-jobs` message delivered over Dapr's HTTP contract goes
 * to Bunny (a fake) and on to the result writer (a fake), signed in with the ID token, and the
 * reply tells Dapr whether to mark it taken. No real GCP or Bunny.
 */
const JOB = '01JC00000000000000000000AB';
const VIDEO = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STORY = '01JC0000000000000000000000';

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
  const logs: unknown[] = [];
  const server = workerServer({
    check: (video) => checkAnswer(bunny, video),
    writer,
    log: (entry) => logs.push(entry),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, writerCalls, logs };
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
    stop = () => new Promise((r) => s.server.close(() => r()));
    const res = await fetch(`${s.base}/dapr/subscribe`);
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
    stop = () => new Promise((r) => s.server.close(() => r()));
    const res = await fetch(`${s.base}/media-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/cloudevents+json' },
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
      outcome: 'ready',
      title: STORY,
      width: 720,
      height: 1280,
      lengthSeconds: 41,
      thumbnailFileName: 'thumbnail.jpg',
    });
    // Ids and short codes only.
    expect(s.logs).toEqual([
      {
        job: JOB,
        kind: 'check',
        video: VIDEO,
        event: 'e1',
        step: 'answered',
        code: 'ready:applied',
        delivery: 'SUCCESS',
      },
    ]);
  });

  it('leaves the job in the queue when the writer fails', async () => {
    const s = await start(503, { code: 'unavailable' });
    stop = () => new Promise((r) => s.server.close(() => r()));
    const res = await fetch(`${s.base}/media-jobs`, {
      method: 'POST',
      body: JSON.stringify(
        delivery({ jobId: JOB, kind: 'check', videoId: VIDEO }),
      ),
    });
    expect(await res.json()).toEqual({ status: 'RETRY' });
  });

  it('drops a message it cannot read, calling nobody', async () => {
    const s = await start(200, {});
    stop = () => new Promise((r) => s.server.close(() => r()));
    const res = await fetch(`${s.base}/media-jobs`, {
      method: 'POST',
      body: JSON.stringify({ data_base64: 'bm90IGpzb24=' }),
    });
    expect(await res.json()).toEqual({ status: 'DROP' });
    expect(s.writerCalls).toEqual([]);
  });
});

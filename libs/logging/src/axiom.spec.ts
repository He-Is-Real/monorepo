import { Logger } from '@nestjs/common';
import { resetAxiomLogs, startAxiomLogs } from './axiom';
import { startEvent } from './event';
import { failedLogWrites, flushLogSinks, writeLog } from './index';
import { JsonLogger } from './nest';

const ENV = {
  AXIOM_DATASET: 'heisreal-dev',
  AXIOM_DOMAIN: 'eu-central-1.aws.edge.axiom.co',
  AXIOM_TOKEN_SECRET: 'axiom-ingest-token',
};
const TOKEN = 'xaat-test-not-a-real-token';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>[];
}

/** A stand-in for Axiom's ingest API: records each request, answers with `answer`. */
function fakeAxiom(
  answer: (sent: Sent) => Promise<Response> = (sent) =>
    Promise.resolve(
      Response.json({ ingested: sent.body.length, failed: 0, failures: [] }),
    ),
) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const request: Sent = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>[],
    };
    sent.push(request);
    return answer(request);
  });
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch };
}

/** Every line written to stdout and stderr, parsed. */
let lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines = [];
  const capture = (chunk: unknown) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  Logger.overrideLogger(new JsonLogger());
});

afterEach(() => {
  resetAxiomLogs();
  vi.restoreAllMocks();
});

const start = (fetch: typeof globalThis.fetch, env = ENV) =>
  startAxiomLogs({ env, read: async () => TOKEN, fetch });

describe('the Axiom sink', () => {
  it('sends every entry stdout gets, unchanged and in one batch, to the edge ingest API', async () => {
    const axiom = fakeAxiom();
    await start(axiom.fetch);

    writeLog('INFO', 'api-user listening', { event: 'startup' });
    writeLog('DEBUG', 'below LOG_LEVEL: written nowhere');
    const event = startEvent('request', 'api-user');
    event.set({ http: { route: '/v1/me', status: 200 } }).write();
    new Logger('Secrets').warn('a Nest line');
    await flushLogSinks();

    expect(axiom.sent).toHaveLength(1);
    const [request] = axiom.sent;
    expect(request?.url).toBe(
      'https://eu-central-1.aws.edge.axiom.co/v1/ingest/heisreal-dev?timestamp-field=timestamp',
    );
    expect(request?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(request?.body).toEqual(lines);
    expect(request?.body.map((e) => e['message'])).toEqual([
      'api-user listening',
      expect.stringContaining('request ok'),
      'a Nest line',
    ]);
  });

  it('never throws into the work when Axiom fails, and counts what it dropped', async () => {
    const before = failedLogWrites();
    const refusing = fakeAxiom(async () => new Response('no', { status: 403 }));
    await start(refusing.fetch);

    expect(() => {
      writeLog('INFO', 'one');
      startEvent('job', 'workflow').write();
    }).not.toThrow();
    await flushLogSinks();
    expect(failedLogWrites() - before).toBe(2);

    resetAxiomLogs();
    let reachable = false;
    const flaky = fakeAxiom((sent) =>
      reachable
        ? Promise.resolve(
            Response.json({ ingested: sent.body.length, failed: 0 }),
          )
        : Promise.reject(new TypeError('fetch failed')),
    );
    await start(flaky.fetch);
    // Sent on its own after this turn (no flush); the fake answers within microtasks, so one
    // timer turn later the failure has been handled.
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    writeLog('INFO', 'three');
    await vi.waitFor(() => expect(flaky.sent).toHaveLength(1));
    await settled();
    // No answer: kept for one more try with the next send (Cloud Run's CPU may be throttled).
    expect(failedLogWrites() - before).toBe(2);
    writeLog('INFO', 'four');
    await vi.waitFor(() => expect(flaky.sent).toHaveLength(2));
    await settled();
    expect(failedLogWrites() - before).toBe(3); // "three" failed twice: dropped
    reachable = true;
    await flushLogSinks();
    expect(failedLogWrites() - before).toBe(3);
    expect(flaky.sent.map((s) => s.body.map((e) => e['message']))).toEqual([
      ['three'],
      ['three', 'four'],
      ['four'],
    ]);
    // Said once on stdout per sink (at most once a minute), never sent to Axiom itself.
    expect(
      lines.filter((l) => l['message'] === "Couldn't send log lines to Axiom"),
    ).toHaveLength(2);
  });

  it('sends nothing where it is not configured, and only warns when the token is missing', async () => {
    const axiom = fakeAxiom();
    expect(await start(axiom.fetch, {} as typeof ENV)).toBeUndefined();
    writeLog('INFO', 'local');
    await flushLogSinks();
    expect(axiom.sent).toHaveLength(0);
    expect(lines.map((l) => l['message'])).toEqual(['local']);

    lines = [];
    const noVersion = await startAxiomLogs({
      env: ENV,
      read: () => Promise.reject(new Error('NOT_FOUND: no versions')),
      fetch: axiom.fetch,
    });
    expect(noVersion).toBeUndefined();
    writeLog('INFO', 'still on stdout');
    await flushLogSinks();
    expect(axiom.sent).toHaveLength(0);
    expect(lines.map((l) => [l['severity'], l['message']])).toEqual([
      [
        'WARNING',
        "Logs go to stdout only, not to Axiom: the token (axiom-ingest-token) couldn't be read",
      ],
      ['INFO', 'still on stdout'],
    ]);
  });

  it('sends what is waiting on shutdown, and gives up on a hung Axiom within the cap', async () => {
    const axiom = fakeAxiom();
    await start(axiom.fetch);
    writeLog('INFO', 'last words');
    // Flushed at once, before the queued send would have started.
    await flushLogSinks(1000);
    expect(axiom.sent.flatMap((s) => s.body.map((e) => e['message']))).toEqual([
      'last words',
    ]);

    resetAxiomLogs();
    const hung = fakeAxiom(() => new Promise<Response>(() => undefined));
    await start(hung.fetch);
    writeLog('INFO', 'nobody answers');
    const started = performance.now();
    await flushLogSinks(50);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('on shutdown, retries a failed send and sends newer entries within the cap, and counts what it gave up on', async () => {
    const before = failedLogWrites();
    let calls = 0;
    const blip = fakeAxiom((sent) =>
      ++calls === 1
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(
            Response.json({ ingested: sent.body.length, failed: 0 }),
          ),
    );
    await start(blip.fetch);
    writeLog('INFO', 'first');
    // The first send is under way and will fail; a newer entry waits behind it.
    await vi.waitFor(() => expect(blip.sent).toHaveLength(1));
    writeLog('INFO', 'second');
    await flushLogSinks(1000);
    expect(blip.sent.map((s) => s.body.map((e) => e['message']))).toEqual([
      ['first'],
      ['first', 'second'],
    ]);
    expect(failedLogWrites() - before).toBe(0);

    resetAxiomLogs();
    const hung = fakeAxiom(() => new Promise<Response>(() => undefined));
    await start(hung.fetch);
    writeLog('INFO', 'unanswered');
    await vi.waitFor(() => expect(hung.sent).toHaveLength(1));
    writeLog('INFO', 'still waiting');
    await flushLogSinks(50);
    // Both lost when the process exits: counted.
    expect(failedLogWrites() - before).toBe(2);
  });
});

import type { CheckResult } from './bunny';
import { handleJob, type JobDeps } from './worker';
import type { WriterCall, WriterReply } from './writer';

/**
 * When the worker marks a job taken (Dapr SUCCESS or DROP: Pub/Sub acks it) and when it leaves it
 * in the queue (RETRY: Pub/Sub redelivers it later), media-worker-final.html section 1 and
 * worker.yaml: ack after a 2xx unless `/failed` says retry; redeliver after anything else.
 */
const JOB = '01JC00000000000000000000AB';
const VIDEO = '0f8fad5b-d9cb-469f-a165-70867728950e';
const READY: CheckResult = {
  answer: {
    outcome: 'ready',
    title: '01JC0000000000000000000000',
    width: 1920,
    height: 1080,
    lengthSeconds: 73,
    thumbnailFileName: 'thumbnail.jpg',
  },
};
const ok = (body: unknown): WriterReply => ({ status: 200, body });

function deps(
  check: CheckResult,
  replies: { answer?: WriterReply; failed?: WriterReply },
) {
  const calls: WriterCall[] = [];
  const d: JobDeps = {
    check: async () => check,
    writer: async (call) => {
      calls.push(call);
      const reply = call.route === 'answer' ? replies.answer : replies.failed;
      if (!reply) throw new Error(`unexpected ${call.route} call`);
      return reply;
    },
    log: () => undefined,
  };
  return { d, calls };
}
const check = { jobId: JOB, kind: 'check', videoId: VIDEO };

describe('a check job', () => {
  it.each([
    ['the writer saved it', ok({ outcome: 'applied' }), 'SUCCESS'],
    [
      'the writer says a newer answer was in',
      ok({ outcome: 'stale' }),
      'SUCCESS',
    ],
    ['the job went with its file (404)', { status: 404, body: {} }, 'DROP'],
    ['the writer failed (5xx)', { status: 503, body: {} }, 'RETRY'],
    ['Cloud Run refused the sign-in (403)', { status: 403, body: {} }, 'RETRY'],
    ['the writer could not be reached', 'unreachable' as const, 'RETRY'],
    ['no ID token could be minted', 'no_token' as const, 'RETRY'],
  ])('when %s: %s', async (_, reply, delivery) => {
    const { d, calls } = deps(READY, { answer: reply });
    await expect(handleJob(check, d)).resolves.toBe(delivery);
    expect(calls).toEqual([
      {
        route: 'answer',
        jobId: JOB,
        body: (READY as { answer: unknown }).answer,
      },
    ]);
  });

  it('reports a refused answer (400) as a failure, and follows the writer', async () => {
    const { d, calls } = deps(READY, {
      answer: { status: 400, body: {} },
      failed: ok({ retry: true }),
    });
    await expect(handleJob(check, d)).resolves.toBe('RETRY');
    expect(calls[1]).toEqual({
      route: 'failed',
      jobId: JOB,
      body: { code: 'answer_refused' },
    });
  });

  it.each([
    ['under 5 failures', ok({ retry: true }), 'RETRY'],
    [
      'at the fifth (gave up)',
      ok({ retry: false, outcome: 'gave_up' }),
      'SUCCESS',
    ],
    [
      'the job had already ended',
      ok({ retry: false, outcome: 'applied' }),
      'SUCCESS',
    ],
    ['the job is gone (404)', { status: 404, body: {} }, 'DROP'],
    ['the writer failed (5xx)', { status: 500, body: {} }, 'RETRY'],
    ['the writer could not be reached', 'unreachable' as const, 'RETRY'],
  ])(
    'when Bunny is unreachable, it reports the failure; %s: %s',
    async (_, reply, delivery) => {
      const { d, calls } = deps(
        { failure: 'bunny_unreachable' },
        { failed: reply },
      );
      await expect(handleJob(check, d)).resolves.toBe(delivery);
      expect(calls).toEqual([
        { route: 'failed', jobId: JOB, body: { code: 'bunny_unreachable' } },
      ]);
    },
  );

  it('reports a malformed video id as bad_message', async () => {
    const { d, calls } = deps(READY, { failed: ok({ retry: true }) });
    await expect(handleJob({ ...check, videoId: '../../x' }, d)).resolves.toBe(
      'RETRY',
    );
    expect(calls).toEqual([
      { route: 'failed', jobId: JOB, body: { code: 'bad_message' } },
    ]);
  });
});

describe('other messages', () => {
  it('reports a render job as not_supported (not built yet), and follows the writer', async () => {
    const { d, calls } = deps(READY, {
      failed: ok({ retry: false, outcome: 'gave_up' }),
    });
    await expect(
      handleJob({ jobId: JOB, kind: 'render', videoId: VIDEO }, d),
    ).resolves.toBe('SUCCESS');
    expect(calls).toEqual([
      { route: 'failed', jobId: JOB, body: { code: 'not_supported' } },
    ]);
  });

  it.each([
    ['not an object', 'hello'],
    ['no job id', { kind: 'check', videoId: VIDEO }],
    ['a job id that is not a ULID', { ...check, jobId: 'mediaJob:1' }],
    ['an unknown kind', { ...check, kind: 'transcribe' }],
  ])('drops a message with %s, calling nobody', async (_, message) => {
    const { d, calls } = deps(READY, {});
    await expect(handleJob(message, d)).resolves.toBe('DROP');
    expect(calls).toEqual([]);
  });
});

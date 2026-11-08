import type { CheckResult } from './bunny';
import type { RenderPass, RenderResult } from './render';
import { handleJob, type JobDeps, RenderSlot } from './worker';
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
  check: CheckResult | (() => Promise<CheckResult>),
  replies: Partial<Record<WriterCall['route'], WriterReply>>,
  rendered: RenderResult | (() => Promise<RenderResult>) = {
    sizeBytes: 207_000,
  },
) {
  const calls: WriterCall[] = [];
  const renders: [string, RenderPass][] = [];
  const d: JobDeps = {
    check: typeof check === 'function' ? check : async () => check,
    renderer: {
      render: async (source, pass) => {
        renders.push([source, pass]);
        return typeof rendered === 'function' ? rendered() : rendered;
      },
    },
    renderSlot: new RenderSlot(),
    writer: async (call) => {
      calls.push(call);
      const reply = replies[call.route];
      if (!reply) throw new Error(`unexpected ${call.route} call`);
      return reply;
    },
    log: () => undefined,
  };
  return { d, calls, renders };
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
        body: { videoId: VIDEO, ...(READY as { answer: object }).answer },
      },
    ]);
  });

  it('reports a refused answer (400) as answer_rejected, and follows the writer', async () => {
    const { d, calls } = deps(READY, {
      answer: { status: 400, body: { code: 'video_mismatch' } },
      failed: ok({ retry: true }),
    });
    await expect(handleJob(check, d)).resolves.toBe('RETRY');
    expect(calls[1]).toEqual({
      route: 'failed',
      jobId: JOB,
      body: { videoId: VIDEO, code: 'answer_rejected' },
    });
  });

  it('reports its own unexpected error as worker_error, and follows the writer', async () => {
    const { d, calls } = deps(
      async () => {
        throw new TypeError('a bug');
      },
      { failed: ok({ retry: false, outcome: 'gave_up' }) },
    );
    await expect(handleJob(check, d)).resolves.toBe('SUCCESS');
    expect(calls).toEqual([
      {
        route: 'failed',
        jobId: JOB,
        body: { videoId: VIDEO, code: 'worker_error' },
      },
    ]);
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
    ['the writer refused the failure (400)', { status: 400, body: {} }, 'DROP'],
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
        {
          route: 'failed',
          jobId: JOB,
          body: { videoId: VIDEO, code: 'bunny_unreachable' },
        },
      ]);
    },
  );
});

describe('other messages', () => {
  it.each([
    ['not an object', 'hello'],
    ['no job id', { kind: 'check', videoId: VIDEO }],
    ['a job id that is not a ULID', { ...check, jobId: 'mediaJob:1' }],
    ['an unknown kind', { ...check, kind: 'transcribe' }],
    ['no video id', { jobId: JOB, kind: 'check' }],
    ['a video id that is not a GUID', { ...check, videoId: '../../x' }],
  ])('drops a message with %s, calling nobody', async (_, message) => {
    const { d, calls } = deps(READY, {});
    await expect(handleJob(message, d)).resolves.toBe('DROP');
    expect(calls).toEqual([]);
  });
});

describe('a render job (audio-picture-video 1B, K1)', () => {
  const RENDER = '6c84fb90-12c4-41f5-9e4c-1b2a3c4d5e6f';
  const render = { jobId: JOB, kind: 'render', videoId: VIDEO };
  const PASS = {
    outcome: 'render',
    renderVideoId: RENDER,
    title: '01JC0000000000000000000000',
    upload: {
      uploadUrl: 'https://video.bunnycdn.com/tusupload',
      headers: {
        AuthorizationSignature: 'abc',
        AuthorizationExpire: '1762600000',
        VideoId: RENDER,
        LibraryId: '424242',
      },
      expiresAt: '2025-11-08T11:06:40.000Z',
    },
    picture:
      'stories/01JC0000000000000000000000/0123456789abcdef0123456789abcdef.webp',
    pictureUrl:
      'https://images.example.b-cdn.net/stories/x.webp?token=t&expires=1',
  };

  it('gets the pass, makes and uploads the picture video, then tells the writer: taken', async () => {
    const { d, calls, renders } = deps(READY, {
      'upload-pass': ok(PASS),
      rendered: ok({ outcome: 'applied' }),
    });
    await expect(handleJob(render, d)).resolves.toBe('SUCCESS');
    expect(renders).toEqual([
      [VIDEO, expect.objectContaining({ renderVideoId: RENDER })],
    ]);
    expect(calls).toEqual([
      { route: 'upload-pass', jobId: JOB, body: { videoId: VIDEO } },
      {
        route: 'rendered',
        jobId: JOB,
        body: {
          videoId: VIDEO,
          renderVideoId: RENDER,
          picture: PASS.picture,
          sizeBytes: 207_000,
        },
      },
    ]);
  });

  it.each([
    ['no picture video is needed (stale)', ok({ outcome: 'stale' }), 'SUCCESS'],
    ['the story moved on (gone)', ok({ outcome: 'gone' }), 'SUCCESS'],
    [
      'Bunny refused the new video; the writer counted it',
      ok({ retry: true }),
      'RETRY',
    ],
    ['the job is gone (404)', { status: 404, body: {} }, 'DROP'],
    ['the writer is off (503)', { status: 503, body: {} }, 'RETRY'],
    ['the writer could not be reached', 'unreachable' as const, 'RETRY'],
  ])(
    'when the pass answers that %s: %s, and nothing is made',
    async (_, reply, delivery) => {
      const { d, renders } = deps(READY, { 'upload-pass': reply });
      await expect(handleJob(render, d)).resolves.toBe(delivery);
      expect(renders).toEqual([]);
    },
  );

  it.each([
    [
      'for another upload address',
      { upload: { ...PASS.upload, uploadUrl: 'https://evil.example/tus' } },
    ],
    [
      'for another video than its own',
      {
        upload: {
          ...PASS.upload,
          headers: { ...PASS.upload.headers, VideoId: VIDEO },
        },
      },
    ],
    ['with a picture link but no picture', { picture: null }],
  ])(
    'refuses a pass %s as pass_malformed, making nothing',
    async (_, change) => {
      const { d, calls, renders } = deps(READY, {
        'upload-pass': ok({ ...PASS, ...change }),
        failed: ok({ retry: true }),
      });
      await expect(handleJob(render, d)).resolves.toBe('RETRY');
      expect(renders).toEqual([]);
      expect(calls.at(-1)).toEqual({
        route: 'failed',
        jobId: JOB,
        body: { videoId: VIDEO, code: 'pass_malformed' },
      });
    },
  );

  it('reports a failed render with its code, and never says done', async () => {
    const { d, calls } = deps(
      READY,
      { 'upload-pass': ok(PASS), failed: ok({ retry: true }) },
      { failure: 'source_not_ready' },
    );
    await expect(handleJob(render, d)).resolves.toBe('RETRY');
    expect(calls.map((c) => c.route)).toEqual(['upload-pass', 'failed']);
    expect(calls[1].body).toEqual({ videoId: VIDEO, code: 'source_not_ready' });
  });

  it('one render at a time: another render job goes back to the queue before asking for its pass; check jobs carry on', async () => {
    let finish: ((r: RenderResult) => void) | undefined;
    const { d, calls } = deps(
      READY,
      {
        'upload-pass': ok(PASS),
        rendered: ok({ outcome: 'applied' }),
        answer: ok({ outcome: 'applied' }),
      },
      // The first render runs until the test finishes it; later ones end at once.
      () =>
        finish
          ? Promise.resolve({ sizeBytes: 207_000 })
          : new Promise<RenderResult>((r) => (finish = r)),
    );
    const first = handleJob(render, d);
    await vi.waitFor(() => expect(finish).toBeDefined());

    // While it renders: no pass is asked for the second (it would age while it waited).
    await expect(handleJob(render, d)).resolves.toBe('RETRY');
    expect(calls.map((c) => c.route)).toEqual(['upload-pass']);
    await expect(handleJob(check, d)).resolves.toBe('SUCCESS');

    finish?.({ sizeBytes: 207_000 });
    await expect(first).resolves.toBe('SUCCESS');
    // Redelivered once the first is done: its pass is asked for now.
    await expect(handleJob(render, d)).resolves.toBe('SUCCESS');
    expect(calls.map((c) => c.route)).toEqual([
      'upload-pass',
      'answer',
      'rendered',
      'upload-pass',
      'rendered',
    ]);
  });

  it('leaves the job in the queue if "done" can’t be saved; the retry gets the same video', async () => {
    const { d } = deps(READY, {
      'upload-pass': ok(PASS),
      rendered: { status: 500, body: {} },
    });
    await expect(handleJob(render, d)).resolves.toBe('RETRY');
  });
});

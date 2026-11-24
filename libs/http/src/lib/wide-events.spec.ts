import {
  Body,
  Controller,
  Get,
  HttpStatus,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Post,
  Req,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  currentEvent,
  LOG_SINKS,
  type LogSink,
  resetLogKeys,
  setLogKeys,
  timeDb,
  timeExternal,
} from '@heisreal/logging/event';
import type { Request } from 'express';
import { ProblemException, ProblemFilter } from './problem.filter';
import { RATE_LIMITS } from './rate-limit/limits';
import {
  RATE_LIMIT_CLOCK,
  RATE_LIMITS_ACTIVE,
  RateLimitModule,
  RateLimits,
} from './rate-limit/rate-limit.module';
import { searchEvent, wideEvents } from './wide-events';

const STORY = 'I was twenty-three and I had stopped believing anything.';

@Controller('v1/stories')
class Probe {
  @Post(':id/submit')
  async submit(@Body() body: { title: string; body: string }) {
    const event = currentEvent();
    event?.set({
      action: 'story.submit',
      story: { id: 'story:k3j9', title: body.title },
    });
    event?.longText('story.body', body.body);
    await timeDb('fn::submit_story', async () => undefined);
    await timeExternal('bunny', async () => ({ status: 201 }));
    if (body.title === 'too long') {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Validation failed',
        undefined,
        [{ pointer: '/title', code: 'too_long', message: 'Too long.' }],
      );
    }
    if (body.title === 'boom') throw new Error('the database said no');
    return { ok: true };
  }

  @Get()
  browse(@Req() req: Request) {
    currentEvent()?.set({
      user: { id: 'user_2NfX', email: 'sam@example.com', role: 'member' },
    });
    searchEvent(req, {
      outcome: 'ok',
      search: { q: 'healing', tags: ['healing'], result_count: 0 },
    });
    return { data: [] };
  }
}

@Module({ imports: [RateLimitModule.forRoot()], controllers: [Probe] })
class ProbeModule implements NestModule {
  constructor(private readonly rateLimits: RateLimits) {}
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(this.rateLimits.byMethod({ write: 'accountWrites' }))
      .forRoutes(Probe);
  }
}

type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('the request’s wide event (writing-logs skill; LG-2, LG-4, LG-9)', () => {
  let app: INestApplication;
  let url: string;
  const entries: Entry[] = [];
  const waiting: (() => void)[] = [];
  const sink: LogSink = {
    write: (_severity, entry) => {
      entries.push(entry);
      waiting.splice(0).forEach((wake) => wake());
    },
  };

  /** The entries matching `pick`, once `count` of them have been written. */
  async function written(pick: (e: Entry) => boolean, count = 1) {
    while (entries.filter(pick).length < count) {
      await new Promise<void>((wake) => waiting.push(wake));
    }
    return entries.filter(pick);
  }

  const events = (ref: string) =>
    written((e) => e['ref'] === ref && e['event'] === 'request');

  beforeAll(async () => {
    process.env['GCP_PROJECT'] = 'heisreal-test';
    process.env['SERVICE_VERSION'] = '1fb357f4c0de';
    process.env['K_REVISION'] = 'api-user-00042-xyz';
    LOG_SINKS.splice(0, LOG_SINKS.length, sink);
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    })
      .overrideProvider(RATE_LIMITS_ACTIVE)
      .useValue(true)
      .overrideProvider(RATE_LIMIT_CLOCK)
      .useValue(() => Date.UTC(2026, 10, 24, 12))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(wideEvents('api-user'));
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    delete process.env['GCP_PROJECT'];
    delete process.env['SERVICE_VERSION'];
    delete process.env['K_REVISION'];
    resetLogKeys();
  });

  beforeEach(() => {
    entries.length = 0;
  });

  const traceId = (n: number) =>
    `01a204cc3df67f139030${String(n).padStart(12, '0')}`;
  const ref = (n: number) =>
    traceId(n).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

  function submit(
    n: number,
    body: object,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${url}/v1/stories/k3j9/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent: `00-${traceId(n)}-00f067aa0ba902b7-01`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it('writes one event per request: the browser’s reference, the trace field, route, timings, long text hashed', async () => {
    const res = await submit(1, {
      title: 'The night',
      body: STORY,
      password: 'hunter2',
    });
    expect(res.status).toBe(201);
    const [event, ...more] = await events(ref(1));
    expect(more).toEqual([]);
    expect(Object.keys(event).slice(0, 5)).toEqual([
      'severity',
      'message',
      'timestamp',
      'event',
      'ref',
    ]);
    expect(event).toMatchObject({
      severity: 'INFO',
      message: expect.stringMatching(
        /^POST \/v1\/stories\/:id\/submit 201 in \d+ ms$/,
      ),
      'logging.googleapis.com/trace': `projects/heisreal-test/traces/${traceId(1)}`,
      // Deployment details (LG-10): which build, revision and environment answered.
      service: {
        name: 'api-user',
        version: '1fb357f4c0de',
        revision: 'api-user-00042-xyz',
        env: 'test',
      },
      http: {
        method: 'POST',
        route: '/v1/stories/:id/submit',
        status_code: 201,
      },
      action: 'story.submit',
      outcome: 'ok',
      story: {
        id: 'story:k3j9',
        title: 'The night',
        body_length: STORY.length,
      },
      db: { calls: 1, slowest: { name: 'fn::submit_story' } },
      external: { bunny: { calls: 1, status: 201 } },
      rate_limit: { group: 'accountWrites', decision: 'allowed' },
      debug: { plain_content: false },
    });
    expect(event['story'].body_hash).toMatch(/^hk1:[0-9a-f]{64}$/);
    expect(event['story'].body).toBeUndefined();
    expect(event['request'].body_hash).toMatch(/^hk1:/);
    expect(JSON.stringify(event)).not.toContain(STORY);
  });

  it('writes long text in full on an input refusal, with the failed fields, and never a secret', async () => {
    const secrets = {
      password: 'hunter2',
      sid: 'sess_2NfXsid',
      key: 'plain-key-value',
      accessKey: 'access-key-value',
      nested: {
        API_KEY: 'api-key-value',
        'X-Session-Id': 'session-id-value',
        clerkSid: 'clerk-sid-value',
        Authorization: 'Bearer auth-value',
        list: [{ refresh_token: 'refresh-value', Cookie: 'cookie-value' }],
        uploadSignature: 'signature-value',
        client_secret: 'client-secret-value',
      },
    };
    const res = await submit(2, {
      title: 'too long',
      body: STORY,
      ...secrets,
    });
    expect(res.status).toBe(400);
    const [event] = await events(ref(2));
    expect(event).toMatchObject({
      outcome: 'input_refused',
      input: { failed_fields: ['title'], failed_checks: ['too_long'] },
      story: { body: STORY },
      debug: { plain_content: true },
    });
    expect(event['request'].body).toContain(STORY);
    const text = JSON.stringify(event);
    for (const value of [
      'hunter2',
      'sess_2NfXsid',
      'plain-key-value',
      'access-key-value',
      'api-key-value',
      'session-id-value',
      'clerk-sid-value',
      'auth-value',
      'refresh-value',
      'cookie-value',
      'signature-value',
      'client-secret-value',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(JSON.parse(event['request'].body)).toEqual({
      title: 'too long',
      body: STORY,
      nested: { list: [{}] },
    });
  });

  it('writes the immediate error line with the same reference, then the event as an error', async () => {
    const res = await submit(3, { title: 'boom', body: STORY });
    expect(res.status).toBe(500);
    const [line] = await written((e) => e['event'] === 'error');
    expect(line).toMatchObject({
      severity: 'ERROR',
      ref: ref(3),
      stack_trace: expect.stringContaining('Error: the database said no'),
    });
    const [event] = await events(ref(3));
    expect(event).toMatchObject({
      severity: 'ERROR',
      outcome: 'error',
      error: { type: 'Error' },
      story: { body: STORY },
      debug: { plain_content: true },
    });
    expect(event['error'].message).toBeUndefined();
  });

  it('starts its own UUID v7 reference when no browser sent one', async () => {
    const res = await fetch(`${url}/v1/stories/k3j9/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent: 'nonsense' },
      body: JSON.stringify({ title: 'The night', body: STORY }),
    });
    expect(res.status).toBe(201);
    const [event] = await written((e) => e['event'] === 'request');
    expect(event['ref']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('gives a rate-limit refusal its reference and logs what the person was attempting', async () => {
    const limit = RATE_LIMITS.accountWrites.limit;
    for (let i = 0; i < limit; i++) {
      await submit(100 + i, { title: 'The night', body: STORY });
    }
    const res = await submit(4, { title: 'The night', body: STORY });
    expect(res.status).toBe(500);
    const [event] = await events(ref(4));
    expect(event).toMatchObject({
      severity: 'WARNING',
      outcome: 'rate_limited',
      rate_limit: { group: 'accountWrites', decision: 'refused' },
      request: { body: expect.stringContaining(STORY) },
      debug: { plain_content: true },
    });
  });

  it('writes a search as its own event: terms plain, who searched only as hs1: hashes, nothing joining it to the request', async () => {
    setLogKeys({ general: 'general-test-key', search: 'search-test-key' });
    const res = await fetch(`${url}/v1/stories?q=healing`, {
      headers: {
        traceparent: `00-${traceId(5)}-00f067aa0ba902b7-01`,
        'user-agent':
          'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/142.0 Mobile',
      },
    });
    expect(res.status).toBe(200);
    const [search] = await written((e) => e['event'] === 'search');
    const [request] = await events(ref(5));
    expect(search).toMatchObject({
      message: 'search 0 results in ' + search['http'].duration_ms + ' ms',
      service: { name: 'api-user', version: '1fb357f4c0de', env: 'test' },
      search: { q: 'healing', tags: ['healing'], result_count: 0 },
      http: { route: '/v1/stories' },
      client: {
        ip_hash: expect.stringMatching(/^hs1:[0-9a-f]{64}$/),
        user_agent: expect.stringContaining('Pixel 9'),
        browser: 'Chrome 142',
        os: 'Android 15',
        device: 'mobile',
      },
      user: {
        id_hash: expect.stringMatching(/^hs1:/),
        email_hash: expect.stringMatching(/^hs1:/),
        role: 'member',
      },
    });
    const text = JSON.stringify(search);
    for (const absent of [
      '"ref"',
      'logging.googleapis.com/trace',
      'session_hash',
      'token_hash',
      'sam@example.com',
      'user_2NfX',
      '127.0.0.1',
      'hk1:',
    ]) {
      expect(text).not.toContain(absent);
    }
    expect(JSON.stringify(request)).not.toContain('healing');
    expect(request['client'].ip).toBe('127.0.0.1');
  });
});

import {
  Controller,
  Delete,
  Get,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProblemFilter } from '../problem.filter';
import { RATE_LIMITS } from './limits';
import {
  RATE_LIMIT_CLOCK,
  RATE_LIMITS_ACTIVE,
  RateLimitModule,
  RateLimits,
} from './rate-limit.module';
import { SlidingWindowCounter } from './sliding-window';

@Controller('probe')
class Probe {
  @Get()
  read() {
    return { ok: true };
  }
  @Delete()
  remove() {
    return { ok: true };
  }
  @Get('boom')
  boom() {
    throw new Error('an unexpected failure');
  }
}

@Module({ imports: [RateLimitModule.forRoot()], controllers: [Probe] })
class ProbeModule implements NestModule {
  constructor(private readonly rateLimits: RateLimits) {}
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        this.rateLimits.byMethod({ read: 'accountWrites', delete: 'deletion' }),
      )
      .forRoutes(Probe);
  }
}

const MINUTE = 60_000;
const READ_LIMIT = RATE_LIMITS.accountWrites.limit;

describe('rate limits (RL-1..RL-9, Joel 2026-11-21)', () => {
  let app: INestApplication;
  let url: string;
  let clock: number;

  async function start(active: boolean) {
    // The start of a window, so a test can say exactly how far into it a request is.
    clock = Date.UTC(2026, 10, 21, 12);
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] })
      .overrideProvider(RATE_LIMITS_ACTIVE)
      .useValue(active)
      .overrideProvider(RATE_LIMIT_CLOCK)
      .useValue(() => clock)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new ProblemFilter());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }
  afterEach(() => app?.close());

  /** A request from `ip`, as Google's front end forwards it (it appends the address it saw). */
  const from = (ip: string, path = '/probe', method = 'GET') =>
    fetch(`${url}${path}`, {
      method,
      headers: { 'x-forwarded-for': `198.51.100.9, ${ip}` },
    });

  async function use(ip: string, times: number, method = 'GET') {
    for (let i = 0; i < times; i++) {
      expect((await from(ip, '/probe', method)).status).toBe(200);
    }
  }

  it('answers a caller over the limit exactly as any unexpected failure', async () => {
    await start(true);
    await use('203.0.113.1', READ_LIMIT);
    const limited = await from('203.0.113.1');
    const failure = await from('203.0.113.2', '/probe/boom');

    const headers = (res: Response) =>
      Object.fromEntries(
        [...res.headers].filter(([name]) => !['date'].includes(name)),
      );
    expect(limited.status).toBe(500);
    expect(failure.status).toBe(500);
    expect(headers(limited)).toEqual(headers(failure));
    expect(await limited.text()).toBe(await failure.text());
    // Nothing that says it was a limit, or when to come back.
    for (const name of limited.headers.keys()) {
      expect(name).not.toMatch(/ratelimit|retry-after/i);
    }
  });

  it('counts the last full window, and lets the caller back in as it slides', async () => {
    await start(true);
    const ip = '203.0.113.3';
    await use(ip, READ_LIMIT);
    expect((await from(ip)).status).toBe(500);

    // A new clock minute doesn't reset it: everything was moments ago.
    clock += MINUTE;
    expect((await from(ip)).status).toBe(500);

    // Half a window on, about half of those have slid out.
    clock += MINUTE / 2;
    expect((await from(ip)).status).toBe(200);

    // Two windows after the last request, the caller has the whole allowance again.
    clock += 2 * MINUTE;
    await use(ip, READ_LIMIT);
    expect((await from(ip)).status).toBe(500);
  });

  it('counts each address on its own, an IPv6 network as one, and groups separately', async () => {
    await start(true);
    await use('2001:db8:1:100::1', READ_LIMIT);
    // Another address in the same /56: the same caller.
    expect((await from('2001:db8:1:1ff::2')).status).toBe(500);
    // Another network, and another IPv4 address, aren't affected.
    expect((await from('2001:db8:2::1')).status).toBe(200);
    expect((await from('203.0.113.4')).status).toBe(200);
    // Deleting has its own count: a caller out of reads can still delete.
    expect((await from('2001:db8:1:100::1', '/probe', 'DELETE')).status).toBe(
      200,
    );
  });

  it('trusts exactly one proxy hop: what the caller adds before it changes nothing', async () => {
    await start(true);
    for (let i = 0; i < READ_LIMIT; i++) {
      const res = await fetch(`${url}/probe`, {
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.5` },
      });
      expect(res.status).toBe(200);
    }
    expect((await from('203.0.113.5')).status).toBe(500);
  });

  it('is off unless the service runs on Cloud Run, so local runs and other tests never trip it', async () => {
    await start(false);
    await use('203.0.113.6', READ_LIMIT * 3);
  });
});

describe('SlidingWindowCounter', () => {
  it('weights the previous window by how much of it is still inside the last window', () => {
    let now = 600_000; // a window start
    const counter = new SlidingWindowCounter({
      windowMs: MINUTE,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) counter.hit('a');
    now += MINUTE + MINUTE / 4; // a quarter into the next window
    expect(counter.peek('a')).toBeCloseTo(7.5);
    expect(counter.hit('a')).toBeCloseTo(8.5);
    now += 2 * MINUTE;
    expect(counter.peek('a')).toBe(0);
    expect(counter.size).toBe(0);
  });

  it('keeps at most maxKeys callers, forgetting the least recently seen', () => {
    const counter = new SlidingWindowCounter({
      windowMs: MINUTE,
      maxKeys: 3,
      now: () => 0,
    });
    for (const key of ['a', 'b', 'c']) counter.hit(key);
    counter.hit('a');
    counter.hit('d');
    expect(counter.size).toBe(3);
    expect(counter.peek('b')).toBe(0);
    expect(counter.peek('a')).toBe(2);
  });
});

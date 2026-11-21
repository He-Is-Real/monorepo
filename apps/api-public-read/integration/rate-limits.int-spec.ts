import type { INestApplication } from '@nestjs/common';
import { RATE_LIMITS, WEBSITE_KEY_HEADER } from '@heisreal/http';
import { TestDatabase } from '@heisreal/database/integration-testing';
import { startPublicRead } from './app';

const MINUTE = 60_000;
const PER_ADDRESS = RATE_LIMITS.publicReads.limit;
const WEBSITE = RATE_LIMITS.website.limit;
const KEY = 'test-website-key-0123456789abcdef';

/** Our generic server error (D30), the only thing a limited caller sees (RL-5). */
const GENERIC = {
  type: 'about:blank',
  title: 'Internal server error',
  status: 500,
};

/**
 * Rate limits on api-public-read (Joel 2026-11-21, RL-1..RL-9) through its real AppModule: each
 * address has `publicReads`; web's own server, with the website key, shares the large `website`
 * allowance (RL-8 A). The clock is the test's: nothing waits on real time. Every answer, the
 * limited one included, is checked against the contract (app.ts).
 */
describe('api-public-read rate limits', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let url: string;
  let clock: number;

  beforeAll(async () => {
    t = await TestDatabase.create();
    clock = Date.UTC(2026, 10, 21, 12);
    ({ app, url } = await startPublicRead(t, undefined, undefined, {
      rateLimits: { now: () => clock, websiteKey: KEY },
    }));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  const read = (ip: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/themes`, {
      headers: { 'x-forwarded-for': ip, ...headers },
    });

  async function readTimes(
    ip: string,
    times: number,
    headers: Record<string, string> = {},
  ) {
    for (let i = 0; i < times; i++) {
      const res = await read(ip, headers);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
  }

  it('gives a caller over the limit only the generic error, until the window slides on', async () => {
    const ip = '203.0.113.10';
    await readTimes(ip, PER_ADDRESS);
    const limited = await read(ip);
    expect(limited.status).toBe(500);
    expect(limited.headers.get('content-type')).toMatch(
      /^application\/problem\+json/,
    );
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(limited.headers.get('retry-after')).toBeNull();
    expect(await limited.json()).toEqual(GENERIC);
    // Other addresses read as usual.
    expect((await read('203.0.113.11')).status).toBe(200);

    clock += 3 * MINUTE;
    expect((await read(ip)).status).toBe(200);
  });

  it('counts a request once, on routes two controllers share a path with', async () => {
    const ip = '203.0.113.12';
    for (let i = 0; i < PER_ADDRESS; i++) {
      const path = i % 2 ? '/v1/stories' : '/v1/stories/no-such-story';
      const res = await fetch(`${url}${path}`, {
        headers: { 'x-forwarded-for': ip },
      });
      expect(res.status).not.toBe(500);
      await res.arrayBuffer();
    }
    expect((await read(ip)).status).toBe(500);
    clock += 3 * MINUTE;
  });

  it("gives web's server, with the website key, one large shared allowance", async () => {
    // Many visitors' reads arrive from web's one address.
    await readTimes('198.51.100.20', PER_ADDRESS * 2, {
      [WEBSITE_KEY_HEADER]: KEY,
    });
    // The website's allowance doesn't depend on the address.
    expect(
      (await read('198.51.100.21', { [WEBSITE_KEY_HEADER]: KEY })).status,
    ).toBe(200);
    expect(WEBSITE).toBeGreaterThan(PER_ADDRESS * 2 + 1);
    clock += 3 * MINUTE;
  });

  it('counts a caller with a wrong key per address, like anyone else', async () => {
    const ip = '198.51.100.30';
    await readTimes(ip, PER_ADDRESS, { [WEBSITE_KEY_HEADER]: 'not-the-key' });
    const limited = await read(ip, { [WEBSITE_KEY_HEADER]: 'not-the-key' });
    expect(limited.status).toBe(500);
    expect(await limited.json()).toEqual(GENERIC);
    clock += 3 * MINUTE;
  });
});

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { DatabaseAvailability } from '@heisreal/database';
import { firstValueFrom, Subject } from 'rxjs';
import { PublicAnswerCache, PublicCacheInterceptor } from './public-cache';

/**
 * R13's 60 seconds count from when the database was asked, not from when it answered: a slow
 * read or a late answer from an overlapping request must never stretch them. The clock and the
 * handlers are the test's, so the reads finish exactly when the test says.
 */
describe('PublicCacheInterceptor (R13) with slow and overlapping reads', () => {
  const saved = process.env['PUBLIC_RESPONSE_CACHING'];
  afterEach(() => {
    if (saved === undefined) delete process.env['PUBLIC_RESPONSE_CACHING'];
    else process.env['PUBLIC_RESPONSE_CACHING'] = saved;
  });

  let clock: number;
  let interceptor: PublicCacheInterceptor;
  beforeEach(() => {
    process.env['PUBLIC_RESPONSE_CACHING'] = 'on';
    clock = 0;
    interceptor = new PublicCacheInterceptor(
      new PublicAnswerCache(() => clock),
      { noticeFailure: () => false } as unknown as DatabaseAvailability,
    );
  });

  /** A GET of `/v1/stories` whose read finishes when the test calls `finish(body)`. */
  const request = () => {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return res;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      status(code: number) {
        res.statusCode = code;
        return res;
      },
    };
    const req = { method: 'GET', path: '/v1/stories', query: {}, headers: {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    const read = new Subject<unknown>();
    let asked = false;
    const handler: CallHandler = {
      handle: () => {
        asked = true;
        return read;
      },
    };
    const answer = firstValueFrom(interceptor.intercept(context, handler));
    return {
      answer,
      headers,
      asked: () => asked,
      finish: (body: string) => {
        headers['etag'] = `"${body}"`;
        read.next(body);
        read.complete();
      },
    };
  };
  const served = async () => {
    const r = request();
    if (r.asked()) r.finish('fresh');
    return r.answer;
  };

  it('counts a slow read’s 60 seconds from when it started', async () => {
    const slow = request();
    clock = 30_000;
    slow.finish('slow');
    expect(await slow.answer).toBe('slow');
    expect(slow.headers['cache-control']).toBe('public, max-age=30');
    clock = 59_999;
    expect(await served()).toBe('slow');
    clock = 60_000;
    expect(await served()).toBe('fresh');
  });

  it('answers with a read that took longer than 60 seconds but does not keep it', async () => {
    const slow = request();
    clock = 61_000;
    slow.finish('slow');
    expect(await slow.answer).toBe('slow');
    expect(slow.headers['cache-control']).toBe('no-store');
    expect(await served()).toBe('fresh');
  });

  it('never lets a read that started earlier replace one that started later', async () => {
    const older = request();
    clock = 10_000;
    const newer = request();
    newer.finish('newer');
    await newer.answer;
    clock = 20_000;
    older.finish('older');
    expect(await older.answer).toBe('older');
    expect(older.headers['cache-control']).toBe('public, max-age=40');
    expect(await served()).toBe('newer');
    clock = 69_999;
    expect(await served()).toBe('newer');
  });
});

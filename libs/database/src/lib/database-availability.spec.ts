import {
  CallTerminatedError,
  ConnectionUnavailableError,
  ReconnectExhaustionError,
  ServerError,
} from 'surrealdb';
import {
  DatabaseUnavailableError,
  isDatabaseUnavailable,
  restartEstimateSecondsFromEnv,
  retryAfterSeconds,
} from './database-availability';
import { DatabaseQueryError } from './query';

const networkError = (code: string) =>
  Object.assign(new Error(`connect ${code} 10.0.0.1:8000`), { code });

describe('isDatabaseUnavailable', () => {
  it.each([
    ['no connection (reconnecting)', new ConnectionUnavailableError()],
    ['socket closed mid-request', new CallTerminatedError()],
    ['reconnects given up', new ReconnectExhaustionError()],
    ['connection refused', networkError('ECONNREFUSED')],
    ['connection reset', networkError('ECONNRESET')],
    ['DNS failure', networkError('ENOTFOUND')],
    ['DNS not ready', networkError('EAI_AGAIN')],
    ['connect timeout', networkError('ETIMEDOUT')],
    [
      "connectDatabase's timeout",
      new Error('Connecting to ws://surrealdb:8000 timed out after 15000ms'),
    ],
    [
      'a network error as the cause',
      new Error('fetch failed', { cause: networkError('ECONNREFUSED') }),
    ],
    ['our own', new DatabaseUnavailableError()],
  ])('counts %s as unavailable', (_, err) => {
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it.each([
    ['a failed statement', new DatabaseQueryError('Found a duplicate', 0)],
    [
      "the server's refusal",
      new ServerError({ kind: 'NotAllowed', message: 'Not allowed' } as never),
    ],
    ['an ordinary error', new Error('Something else timed out after 2000ms')],
    ['a string', 'ECONNREFUSED'],
    ['nothing', undefined],
  ])('keeps %s as an ordinary error', (_, err) => {
    expect(isDatabaseUnavailable(err)).toBe(false);
  });
});

describe('retryAfterSeconds', () => {
  const since = new Date('2026-11-07T12:00:00Z');
  const after = (s: number) => new Date(since.getTime() + s * 1000);

  it('counts down from the estimate as the restart goes on', () => {
    expect(retryAfterSeconds(since, after(0))).toBe(120);
    expect(retryAfterSeconds(since, after(30))).toBe(90);
    expect(retryAfterSeconds(since, after(59.5))).toBe(61);
  });

  it('never suggests less than a minute, however long it takes', () => {
    expect(retryAfterSeconds(since, after(60))).toBe(60);
    expect(retryAfterSeconds(since, after(110))).toBe(60);
    expect(retryAfterSeconds(since, after(3600))).toBe(60);
  });

  it('uses the configured estimate', () => {
    expect(retryAfterSeconds(since, after(30), 300)).toBe(270);
    expect(restartEstimateSecondsFromEnv({})).toBe(120);
    expect(
      restartEstimateSecondsFromEnv({
        DATABASE_RESTART_ESTIMATE_SECONDS: '300',
      }),
    ).toBe(300);
    expect(
      restartEstimateSecondsFromEnv({ DATABASE_RESTART_ESTIMATE_SECONDS: 'x' }),
    ).toBe(120);
  });
});

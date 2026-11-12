import { ApiUserProblem } from '@/lib/api-user';
import { decisionRefusal } from './moderation-api';

// The "from" time never names a minute before the database's deadline, today or another day
// (Codex #221 rounds 1 and 2).
describe('decisionRefusal: approval waits', () => {
  const refusal = (availableAt: string) =>
    decisionRefusal(
      new ApiUserProblem({
        status: 409,
        code: 'media_recently_uploaded',
        availableAt,
      } as never),
      { primaryFormat: 'video' },
      'approve',
    ).message;

  afterEach(() => jest.useRealTimers());

  it('rounds a deadline later today up to the next minute', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-01T13:30:00Z'));
    expect(refusal('2026-11-01T14:05:59Z')).toBe(
      'The video is still being processed. You can approve it from 14:06.',
    );
  });

  it('rounds a deadline on another day up to the next minute too', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-01T23:30:00Z'));
    expect(refusal('2026-11-02T00:05:59Z')).toMatch(
      /2 November 2026 at 00:06\.$/,
    );
  });
});

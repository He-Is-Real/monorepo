import type { SurrealQueryable } from 'surrealdb';
import {
  DatabaseQueryError,
  isMediaNotReadyError,
  isStoryTextTooShortError,
  isTransactionConflict,
  requireWritten,
  retryOnConflict,
  runQuery,
  WriteNotAppliedError,
} from './query';
import { requestHash } from './idempotency';

function db(responses: unknown[]) {
  return {
    query: jest.fn().mockReturnValue({
      json: () => ({ responses: async () => responses }),
    }),
  } as unknown as SurrealQueryable;
}

describe('runQuery', () => {
  it('returns every statement’s result', async () => {
    await expect(
      runQuery(
        db([
          { success: true, result: 1 },
          { success: true, result: [2] },
        ]),
        'x',
      ),
    ).resolves.toEqual([1, [2]]);
  });

  it('throws the root cause of a failed transaction, not "not executed"', async () => {
    const err = await runQuery(
      db([
        { success: true },
        {
          success: false,
          error: new Error(
            'The query was not executed due to a failed transaction',
          ),
        },
        {
          success: false,
          error: new Error('An error occurred: consent ledger is append-only'),
        },
      ]),
      'x',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseQueryError);
    expect((err as DatabaseQueryError).message).toContain('append-only');
    expect((err as DatabaseQueryError).statement).toBe(2);
  });
});

describe('retryOnConflict', () => {
  const conflict = new Error(
    'Transaction conflict: Resource busy. This transaction can be retried',
  );

  it('re-runs the whole command on a retryable conflict', async () => {
    const work = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue('ok');
    await expect(retryOnConflict(work, { backoffMs: 1 })).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded attempts, and never retries other errors', async () => {
    const always = jest.fn().mockRejectedValue(conflict);
    await expect(retryOnConflict(always, { backoffMs: 1 })).rejects.toBe(
      conflict,
    );
    expect(always).toHaveBeenCalledTimes(3);
    const other = jest.fn().mockRejectedValue(new Error('refused'));
    await expect(retryOnConflict(other)).rejects.toThrow('refused');
    expect(other).toHaveBeenCalledTimes(1);
    expect(isTransactionConflict(new Error('refused'))).toBe(false);
  });
});

describe('requireWritten (the D13 silent no-op)', () => {
  it('passes exactly one row and fails loudly on an empty result', () => {
    expect(requireWritten([{ id: 'consent:a' }], 'consent')).toEqual({
      id: 'consent:a',
    });
    expect(() => requireWritten([], 'consent')).toThrow(WriteNotAppliedError);
    expect(() => requireWritten(undefined, 'consent')).toThrow(
      WriteNotAppliedError,
    );
  });
});

describe('requestHash', () => {
  it('ignores key order but not values', () => {
    expect(requestHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      requestHash({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe('database refusals the APIs map to 4xx', () => {
  it('recognises the approval gate (A2)', () => {
    expect(
      isMediaNotReadyError(
        new DatabaseQueryError(
          'An error occurred: media_not_ready: a video needs its width, height and duration',
          1,
        ),
      ),
    ).toBe(true);
    expect(
      isMediaNotReadyError(new Error('publicStory must mirror the story')),
    ).toBe(false);
    expect(isMediaNotReadyError('media not ready')).toBe(false);
  });

  it('recognises the 200-character minimum on submit', () => {
    expect(
      isStoryTextTooShortError(
        new Error(
          'An error occurred: a written story needs at least 200 characters before it is submitted',
        ),
      ),
    ).toBe(true);
    expect(
      isStoryTextTooShortError(new Error('a written story needs its text')),
    ).toBe(false);
  });
});

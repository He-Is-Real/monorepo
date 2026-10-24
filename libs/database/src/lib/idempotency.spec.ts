import { RecordId, type SurrealQueryable } from 'surrealdb';
import { runIdempotent } from './idempotency';

/**
 * A scripted database: each query gets the next scripted answer, chosen by whether it is the
 * key lookup or the command's transaction.
 */
function scriptedDb(script: {
  lookups: (unknown[] | undefined)[];
  transactions: ('conflict' | 'taken' | { status: number; id: string })[];
}) {
  const calls: string[] = [];
  const query = jest.fn((sql: string) => {
    const isLookup = sql.trimStart().startsWith('SELECT');
    calls.push(isLookup ? 'lookup' : 'transaction');
    let responses: unknown[];
    if (isLookup) {
      responses = [{ success: true, result: script.lookups.shift() ?? [] }];
    } else {
      const next = script.transactions.shift();
      if (next === 'conflict' || next === 'taken') {
        const message =
          next === 'conflict'
            ? 'Transaction conflict: Resource busy. This transaction can be retried'
            : 'Database record `idempotencyKey:[...]` already exists';
        responses = [{ success: false, error: new Error(message) }];
      } else {
        responses = [
          { success: true },
          {
            success: true,
            result: [{ status: next?.status, response: { id: next?.id } }],
          },
          { success: true },
        ];
      }
    }
    return { json: () => ({ responses: async () => responses }) };
  });
  return { db: { query } as unknown as SurrealQueryable, calls };
}

const scope = {
  service: 'api-user' as const,
  owner: new RecordId('user', 'ann'),
  key: 'key-0123456789abcdef',
};
const command = { statements: 'LET $result = {};', vars: {}, status: 201 };

describe('runIdempotent', () => {
  it('after a conflict, looks the key up again before re-preparing (review round 2)', async () => {
    // Two same-key requests overlap: the other one commits, this one gets a conflict. By the
    // time it retries, the DPA version in force has changed, so preparing again would refuse
    // (409). It must find the committed key and replay it instead.
    const { db, calls } = scriptedDb({
      lookups: [
        [], // first attempt: no key yet
        [{ requestHash: 'h', status: 201, response: { id: 'consent:winner' } }],
      ],
      transactions: ['conflict'],
    });
    const prepare = jest
      .fn()
      .mockResolvedValueOnce(command)
      .mockRejectedValue(new Error('dpa_version_not_in_force'));
    await expect(runIdempotent(db, scope, 'h', prepare)).resolves.toEqual({
      replayed: true,
      response: { status: 201, id: 'consent:winner', version: null },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['lookup', 'transaction', 'lookup']);
  });

  it('after losing the key to a racing request, replays it', async () => {
    const { db } = scriptedDb({
      lookups: [
        [],
        [{ requestHash: 'h', status: 202, response: { id: 'consent:w' } }],
      ],
      transactions: ['taken'],
    });
    await expect(
      runIdempotent(db, scope, 'h', async () => command),
    ).resolves.toMatchObject({ replayed: true, response: { status: 202 } });
  });

  it('retries a conflict that wasn’t about the key: lookup, prepare and write again', async () => {
    const { db, calls } = scriptedDb({
      lookups: [[], []],
      transactions: ['conflict', { status: 201, id: 'consent:mine' }],
    });
    const prepare = jest.fn().mockResolvedValue(command);
    await expect(runIdempotent(db, scope, 'h', prepare)).resolves.toEqual({
      replayed: false,
      response: { status: 201, id: 'consent:mine', version: null },
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['lookup', 'transaction', 'lookup', 'transaction']);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { db, calls } = scriptedDb({
      lookups: [],
      transactions: Array(10).fill('conflict'),
    });
    await expect(
      runIdempotent(db, scope, 'h', async () => command, { backoffMs: 1 }),
    ).rejects.toThrow('Transaction conflict');
    expect(calls.filter((c) => c === 'transaction')).toHaveLength(4);
  });

  it('never retries other errors (e.g. the command refusing)', async () => {
    const { db } = scriptedDb({ lookups: [[]], transactions: [] });
    const prepare = jest.fn().mockRejectedValue(new Error('refused'));
    await expect(runIdempotent(db, scope, 'h', prepare)).rejects.toThrow(
      'refused',
    );
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

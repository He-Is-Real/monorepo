import type { SurrealQueryable } from 'surrealdb';
import { readConsentRelaxed } from './consent-setting';

function db(responses: () => Promise<unknown[]>) {
  const query = jest.fn(() => ({ json: () => ({ responses }) }));
  return { db: { query } as unknown as SurrealQueryable, query };
}

describe('readConsentRelaxed (D48)', () => {
  it('asks the database’s own switch, fn::consent::relaxed()', async () => {
    const { db: d, query } = db(async () => [{ success: true, result: true }]);
    await expect(readConsentRelaxed(d)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      'RETURN fn::consent::relaxed()',
      undefined,
    );
  });

  it.each([false, null, 'true', 1])(
    'is false for anything but true (%p)',
    async (result) => {
      const { db: d } = db(async () => [{ success: true, result }]);
      await expect(readConsentRelaxed(d)).resolves.toBe(false);
    },
  );

  it('is undefined when the database can’t say (error or no answer in time)', async () => {
    const { db: failing } = db(async () => [
      { success: false, error: { message: 'no such function' } },
    ]);
    await expect(readConsentRelaxed(failing)).resolves.toBeUndefined();
    const { db: hanging } = db(() => new Promise(() => undefined));
    await expect(readConsentRelaxed(hanging, 20)).resolves.toBeUndefined();
  });
});

import type { Surreal } from 'surrealdb';
import { DatabaseHealthService } from './database-health.service';

function service(query: jest.Mock) {
  return new DatabaseHealthService({ query } as unknown as Surreal);
}

describe('DatabaseHealthService', () => {
  it('reports up when a query succeeds', async () => {
    await expect(
      service(jest.fn().mockResolvedValue([true])).check(),
    ).resolves.toBe('up');
  });

  it('reports down when a query fails', async () => {
    await expect(
      service(jest.fn().mockRejectedValue(new Error('refused'))).check(),
    ).resolves.toBe('down');
  });

  it('reports down when a query hangs (e.g. while reconnecting)', async () => {
    const hanging = jest.fn().mockReturnValue(new Promise(() => undefined));
    await expect(service(hanging).check(20)).resolves.toBe('down');
  });
});

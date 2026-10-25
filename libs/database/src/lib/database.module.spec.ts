import type { SecretsService } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { connectDatabase } from './database.module';

const config = {
  url: 'ws://surrealdb:8000',
  namespace: 'heisreal',
  database: 'main',
  username: 'api_admin',
  passwordSecret: 'surreal-api-admin-password',
};
const secrets = { get: vi.fn() } as unknown as SecretsService;

function client(connect: Promise<true>) {
  return {
    connect: vi.fn().mockReturnValue(connect),
    close: vi.fn().mockResolvedValue(true),
  };
}

describe('connectDatabase', () => {
  it('fails and stops reconnecting when the database is unreachable', async () => {
    const db = client(new Promise(() => undefined));
    await expect(
      connectDatabase(db as unknown as Surreal, config, secrets, 20),
    ).rejects.toThrow('Connecting to ws://surrealdb:8000 timed out after 20ms');
    expect(db.close).toHaveBeenCalled();
  });
});

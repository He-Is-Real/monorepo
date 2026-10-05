import type { SecretsService } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { connectDatabase } from './database.module';

const config = {
  url: 'ws://surrealdb:8000',
  namespace: 'heisreal',
  database: 'main',
  username: 'api_read',
  passwordSecret: 'surreal-api-read-password',
};
const secrets = { get: jest.fn() } as unknown as SecretsService;

function client(connect: Promise<true>) {
  return {
    connect: jest.fn().mockReturnValue(connect),
    close: jest.fn().mockResolvedValue(true),
  };
}

describe('connectDatabase', () => {
  it('returns the client once connected', async () => {
    const db = client(Promise.resolve(true));
    await expect(
      connectDatabase(db as unknown as Surreal, config, secrets),
    ).resolves.toBe(db);
    expect(db.close).not.toHaveBeenCalled();
  });

  it('fails and stops reconnecting when the database is unreachable', async () => {
    const db = client(new Promise(() => undefined));
    await expect(
      connectDatabase(db as unknown as Surreal, config, secrets, 20),
    ).rejects.toThrow('Connecting to ws://surrealdb:8000 timed out after 20ms');
    expect(db.close).toHaveBeenCalled();
  });
});

import type { SecretsService } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { connectDatabase, serviceSignIn } from './database.module';

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

describe('serviceSignIn', () => {
  it('signs in as the service record through DEFINE ACCESS svc (D13 B)', async () => {
    const get = jest.fn().mockResolvedValue('s3cret');
    await expect(
      serviceSignIn(config, { get } as unknown as SecretsService),
    ).resolves.toEqual({
      namespace: 'heisreal',
      database: 'main',
      access: 'svc',
      variables: { name: config.username, secret: 's3cret' },
    });
    expect(get).toHaveBeenCalledWith(config.passwordSecret);
  });
});

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

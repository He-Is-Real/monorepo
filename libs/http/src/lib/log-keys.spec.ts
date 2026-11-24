import { logHash, resetLogKeys } from '@heisreal/logging/event';
import type { SecretsService } from '@heisreal/secrets';
import { LogKeysLoader } from './log-keys';

describe('the log keys at start-up', () => {
  const saved = { ...process.env };
  const secrets = {
    get: async (name: string) => `value-of-${name}`,
  } as unknown as SecretsService;

  beforeEach(() => {
    for (const name of [
      'K_SERVICE',
      'LOG_HMAC_SECRET',
      'LOG_SEARCH_HMAC_SECRET',
    ])
      delete process.env[name];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...saved };
    resetLogKeys();
    vi.restoreAllMocks();
  });

  it('refuses to start a deployed service when either key is missing', async () => {
    process.env['K_SERVICE'] = 'api-user';
    await expect(new LogKeysLoader(secrets).onModuleInit()).rejects.toThrow(
      /Log keys not set/,
    );
    process.env['LOG_HMAC_SECRET'] = 'log-hmac';
    await expect(new LogKeysLoader(secrets).onModuleInit()).rejects.toThrow(
      /Log keys not set/,
    );
  });

  it('starts a deployed service with both keys read from Secret Manager', async () => {
    process.env['K_SERVICE'] = 'api-user';
    process.env['LOG_HMAC_SECRET'] = 'log-hmac';
    process.env['LOG_SEARCH_HMAC_SECRET'] = 'log-search-hmac';
    const devHash = logHash('x');
    await new LogKeysLoader(secrets).onModuleInit();
    expect(logHash('x')).not.toBe(devHash);
  });

  it('uses the development keys locally, with a warning', async () => {
    await new LogKeysLoader().onModuleInit();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('development keys'),
    );
  });
});

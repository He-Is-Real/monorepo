import { Test } from '@nestjs/testing';
import { logHash, resetLogKeys } from '@heisreal/logging/event';
import { SECRET_MANAGER_CLIENT } from '@heisreal/secrets';
import { AppModule } from './app.module';
import { NEWEST, SIGNER, SIGNER_CONFIG } from './config';

/** The whole service starting as Cloud Run starts it, with Secret Manager in memory. */
async function start() {
  const read: string[] = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SECRET_MANAGER_CLIENT)
    .useValue({
      accessSecretVersion: async ({ name }: { name: string }) => {
        read.push(name);
        return [{ payload: { data: Buffer.from(`key from ${name}`) } }];
      },
    })
    .overrideProvider(SIGNER_CONFIG)
    .useValue({})
    .overrideProvider(SIGNER)
    .useValue(async () => Buffer.alloc(0))
    .overrideProvider(NEWEST)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  return { app, read };
}

describe('cert-signer starting up (its log keys)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env['GCP_PROJECT'] = 'heisreal-test';
    process.env['K_SERVICE'] = 'cert-signer';
    delete process.env['LOG_HMAC_SECRET'];
    delete process.env['LOG_SEARCH_HMAC_SECRET'];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...saved };
    resetLogKeys();
    vi.restoreAllMocks();
  });

  it('refuses to start deployed without the log keys', async () => {
    const { app } = await start();
    await expect(app.init()).rejects.toThrow(/Log keys not set/);
  });

  it('reads both log keys from Secret Manager before serving, so hashes stop using the development key', async () => {
    process.env['LOG_HMAC_SECRET'] = 'log-hmac';
    process.env['LOG_SEARCH_HMAC_SECRET'] = 'log-search-hmac';
    const devHash = logHash('joel-pc');
    const { app, read } = await start();
    await app.init();
    expect(read.sort()).toEqual([
      'projects/heisreal-test/secrets/log-hmac/versions/latest',
      'projects/heisreal-test/secrets/log-search-hmac/versions/latest',
    ]);
    expect(logHash('joel-pc')).not.toBe(devHash);
    await app.close();
  });
});

import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

describe('api-public-read AppModule', () => {
  it('serves GET /health as api-public-read', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api-public-read', db: 'up' },
    });
  });
});

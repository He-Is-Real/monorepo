import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

describe('api-read AppModule', () => {
  it('serves GET /health as api-read', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api-read', db: 'up' },
    });
  });
});

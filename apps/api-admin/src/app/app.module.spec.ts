import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

describe('api-admin AppModule', () => {
  it('serves GET /health as api-admin', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api-admin', db: 'up' },
    });
  });
});

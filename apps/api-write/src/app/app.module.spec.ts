import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

describe('api-write AppModule', () => {
  it('serves GET /health as api-write', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api-write', db: 'up' },
    });
  });
});

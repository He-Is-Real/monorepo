import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

describe('api-user AppModule', () => {
  it('serves GET /health as api-user', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api-user', db: 'up' },
    });
  });
});

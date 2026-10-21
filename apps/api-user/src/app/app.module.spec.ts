import { useTestClerkEnv } from '@heisreal/auth/testing';
import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

useTestClerkEnv();

describe('api-user AppModule', () => {
  it('serves GET /health as api-user', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api-user', db: 'up' },
    });
  });
});

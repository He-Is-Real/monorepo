import { getHealth } from '@heisreal/health/testing';
import { AppModule } from './app.module';

describe('workflow AppModule', () => {
  it('serves GET /health as workflow', async () => {
    await expect(getHealth(AppModule)).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'workflow', db: 'up' },
    });
  });
});

import { RefusedError, seedConfig } from './config';

const DEV = {
  DEV_SEED_ENVIRONMENT: 'dev',
  GCP_PROJECT: 'heisreal-dev',
  SURREAL_URL: 'ws://surrealdb:8000',
  SURREAL_NAMESPACE: 'heisreal',
  SURREAL_DATABASE: 'main',
  SURREAL_USER: 'dev_seed',
  SURREAL_PASSWORD_SECRET: 'surreal-dev-seed-password',
};

describe('seedConfig', () => {
  it.each([
    ['another environment', { DEV_SEED_ENVIRONMENT: 'prod' }],
    ['no environment', { DEV_SEED_ENVIRONMENT: undefined }],
    ['another project', { GCP_PROJECT: 'heisreal-prod' }],
  ])('refuses %s', (_, change) => {
    expect(() => seedConfig({ ...DEV, ...change })).toThrow(RefusedError);
  });

  it('names a missing setting', () => {
    expect(() => seedConfig({ ...DEV, SURREAL_URL: ' ' })).toThrow(
      'SURREAL_URL',
    );
  });
});

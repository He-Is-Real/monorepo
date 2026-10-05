import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Global, Module } from '@nestjs/common';
import { requireEnv } from './env';
import {
  SECRET_MANAGER_CLIENT,
  SECRETS_PROJECT,
  SecretsService,
} from './secrets.service';

/**
 * Global module exposing {@link SecretsService}. The GCP project comes from
 * `GCP_PROJECT` (e.g. the dev or prod project), so the same build runs in
 * every environment.
 */
@Global()
@Module({
  providers: [
    {
      provide: SECRET_MANAGER_CLIENT,
      useFactory: () => new SecretManagerServiceClient(),
    },
    { provide: SECRETS_PROJECT, useFactory: () => requireEnv('GCP_PROJECT') },
    SecretsService,
  ],
  exports: [SecretsService],
})
export class SecretsModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LogKeysModule } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { gcsNewestRecords, kmsSigner } from '@heisreal/worker-identity';
import { GoogleAuth } from 'google-auth-library';
import { CertificatesController } from './certificates.controller';
import {
  NEWEST,
  SIGNER,
  SIGNER_CONFIG,
  type SignerConfig,
  signerConfig,
} from './config';
import { ProblemFilter } from './problem.filter';

// This service's own account (Cloud Run's metadata server).
const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/cloudkms',
    'https://www.googleapis.com/auth/devstorage.read_write',
  ],
});
const accessToken = async () => {
  const token = await auth.getAccessToken();
  if (!token) throw new Error('no access token');
  return token;
};

@Module({
  // The log keys (log-hmac, log-search-hmac) for the request's wide event, read before it serves
  // (libs/http): deployed, it won't start without them.
  imports: [SecretsModule, LogKeysModule],
  controllers: [CertificatesController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: SIGNER_CONFIG, useFactory: () => signerConfig() },
    {
      // Signs with the authority's KMS key as this service's own account (Cloud Run's metadata
      // server): the only account the key lets sign.
      provide: SIGNER,
      inject: [SIGNER_CONFIG],
      useFactory: (config: SignerConfig) =>
        kmsSigner(config.kmsKeyVersion, accessToken),
    },
    {
      // Each machine's newest certificate, in the bucket only this account may use.
      provide: NEWEST,
      inject: [SIGNER_CONFIG],
      useFactory: (config: SignerConfig) =>
        gcsNewestRecords(config.recordsBucket, accessToken),
    },
  ],
})
export class AppModule {}

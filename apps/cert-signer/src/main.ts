/**
 * cert-signer: the media worker's certificate signing service (W1-A; Joel, 2026-11-08,
 * worker-and-gcloud-sign-in.html). One route: the worker sends a new public key, proves it holds
 * a current certificate from our authority, and gets a certificate for the new key with the same
 * machine name, signed by the authority's Cloud KMS key. No database, nothing stored. Only the
 * media-worker Google account may call it (Cloud Run IAM).
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { writeLog } from '@heisreal/logging';
import { JsonLogger } from '@heisreal/logging/nest';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    bufferLogs: true,
    // The shared JSON log format (libs/logging; Joel, 2026-11-14).
    logger: new JsonLogger(),
  });
  app.flushLogs();
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3005;
  await app.listen(port);
  Logger.log(`cert-signer listening on http://localhost:${port}`);
}

bootstrap().catch((err: unknown) => {
  // A bad setting (config.ts) stops it here; Cloud Run keeps the previous revision.
  writeLog('ERROR', 'failed_to_start', {
    step: 'failed_to_start',
    error: err instanceof Error ? err.message : 'error',
  });
  process.exit(1);
});

/**
 * api-public-read: anonymous public queries only (D33, D35); no auth. Connects to SurrealDB as a read-only (VIEWER) user.
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { failedToStart, START_UP_OPTIONS } from '@heisreal/database';
import { corsOptions } from '@heisreal/http';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // D31: the browser calls this service directly, from web's origin only (CORS_ALLOWED_ORIGINS).
  const app = await NestFactory.create(AppModule, {
    cors: corsOptions(),
    // A start-up failure exits with code 1 (failedToStart; a refused database sign-in logs one
    // `database_refused` line), and Cloud Run keeps the previous revision.
    ...START_UP_OPTIONS,
  }).catch(failedToStart);
  app.flushLogs();
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  Logger.log(`api-public-read listening on http://localhost:${port}`);
}

bootstrap();

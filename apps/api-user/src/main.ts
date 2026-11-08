/**
 * api-user: the signed-in person's own reads and commands (Clerk JWT on every route), plus signed webhooks (D33, D35). Signs in as service:api_user; personal queries run as the person (D27).
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { failedToStart, START_UP_OPTIONS } from '@heisreal/database';
import { corsOptions } from '@heisreal/http';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // D31: the browser calls this service directly, from web's origin only (CORS_ALLOWED_ORIGINS).
  // rawBody: Clerk's and Bunny's webhooks are verified over the exact bytes they signed (D33).
  const app = await NestFactory.create(AppModule, {
    cors: corsOptions(),
    rawBody: true,
    // A start-up failure exits with code 1 (failedToStart; a refused database sign-in logs one
    // `database_refused` line), and Cloud Run keeps the previous revision.
    ...START_UP_OPTIONS,
  }).catch(failedToStart);
  app.flushLogs();
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3002;
  await app.listen(port);
  Logger.log(`api-user listening on http://localhost:${port}`);
}

bootstrap();

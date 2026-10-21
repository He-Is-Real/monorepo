/**
 * api-user: the signed-in person's own reads and commands (Clerk JWT on every route), plus signed webhooks (D33, D35). Signs in as service:api_user; personal queries run as the person (D27).
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { corsOptions } from '@heisreal/http';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // D31: the browser calls this service directly, from web's origin only (CORS_ALLOWED_ORIGINS).
  const app = await NestFactory.create(AppModule, { cors: corsOptions() });
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3002;
  await app.listen(port);
  Logger.log(`api-user listening on http://localhost:${port}`);
}

bootstrap();

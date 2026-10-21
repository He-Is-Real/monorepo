/**
 * api-admin: Restricted moderation/admin API on its own hostname (Moderator+ on every route). Connects as an EDITOR user.
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
  const port = process.env.PORT ?? 3003;
  await app.listen(port);
  Logger.log(`api-admin listening on http://localhost:${port}`);
}

bootstrap();

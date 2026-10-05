/**
 * api-admin: Restricted moderation/admin API on its own hostname (Moderator+ on every route). Connects as an EDITOR user.
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3003;
  await app.listen(port);
  Logger.log(`api-admin listening on http://localhost:${port}`);
}

bootstrap();

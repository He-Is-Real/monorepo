/**
 * api-user: the signed-in person's own reads and commands (Clerk JWT on every route), plus signed webhooks (D33, D35). Connects as an EDITOR user.
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3002;
  await app.listen(port);
  Logger.log(`api-user listening on http://localhost:${port}`);
}

bootstrap();

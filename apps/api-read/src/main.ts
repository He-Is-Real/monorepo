/**
 * api-read: Public read API. Connects to SurrealDB as a read-only (VIEWER) user; serves anonymous and signed-in reads.
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  Logger.log(`api-read listening on http://localhost:${port}`);
}

bootstrap();

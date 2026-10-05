/**
 * workflow: GKE Dapr Workflow orchestrator for the processing pipeline (M7). Connects as an EDITOR user; no public ingress.
 * See project docs: context/future/architecture/service-topology.md
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3004;
  await app.listen(port);
  Logger.log(`workflow listening on http://localhost:${port}`);
}

bootstrap();

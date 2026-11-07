/**
 * workflow: the media result writer (M2 plan item 13, D78). A private Cloud Run service that Pub/Sub
 * pushes the media worker's answers to (media-results); it writes them to the storyFile rows,
 * signed in as service:workflow. Never on GKE, and no public address.
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

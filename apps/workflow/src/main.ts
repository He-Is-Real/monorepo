/**
 * workflow: the media result writer (M2 plan item 13, D78; media-worker-final.html). A Cloud Run
 * service the media worker calls directly with its answers (J5); it writes them to the storyFile
 * rows and ends their mediaJob rows, signed in as service:workflow. Never on GKE; only the
 * media-worker Google account may call it (Cloud Run IAM).
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

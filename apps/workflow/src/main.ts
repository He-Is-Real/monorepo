/**
 * workflow: the media result writer (M2 plan item 13, D78; media-worker-final.html). A Cloud Run
 * service the media worker calls directly with its answers (J5); it writes them to the storyFile
 * rows and ends their mediaJob rows, signed in as service:workflow. Never on GKE; only the
 * media-worker Google account may call it (Cloud Run IAM).
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { failedToStart, START_UP_OPTIONS } from '@heisreal/database';
import { wideEvents } from '@heisreal/http';
import { AppModule } from './app/app.module';
import { startTracing } from '@heisreal/logging/tracing';
import { readSecret } from '@heisreal/secrets/read';

// First: OpenTelemetry spans to Axiom where OpenTofu configured them (LG-15; off locally).
startTracing({ service: 'workflow', read: (name) => readSecret(name) });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // A start-up failure exits with code 1 (failedToStart; a refused database sign-in logs one
    // `database_refused` line), and Cloud Run keeps the previous revision.
    ...START_UP_OPTIONS,
  }).catch(failedToStart);
  app.flushLogs();
  // One `event: "job"` per call from the media worker, with the worker's trace id (its
  // `traceparent`), started before anything else can refuse it (libs/http; LG-2 C, LG-4 A).
  app.use(wideEvents('workflow', 'job'));
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3004;
  await app.listen(port);
  Logger.log(`workflow listening on http://localhost:${port}`);
}

bootstrap();

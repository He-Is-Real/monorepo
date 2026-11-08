import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  DatabaseAvailabilityInterceptor,
  DatabaseModule,
} from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule, SecretsService } from '@heisreal/secrets';
import { WRITER_BUNNY, writerBunnyFromEnv } from './bunny';
import { MediaJobsController } from './media-jobs.controller';
import { MEDIA_QUEUE, mediaQueueFromEnv } from './media-queue';

@Module({
  imports: [SecretsModule, DatabaseModule, HealthModule.forService('workflow')],
  controllers: [MediaJobsController],
  // D30: every error as an RFC 9457 problem; unknown errors never say why (a 500: the worker leaves the job in the queue).
  // The database restarting (Spot) is `503 service_restarting`, at once, not a hung request.
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: DatabaseAvailabilityInterceptor },
    // Bunny's library key and the images token key (K1; part A), and the job queue (J1 check e).
    {
      provide: WRITER_BUNNY,
      inject: [SecretsService],
      useFactory: (secrets: SecretsService) => writerBunnyFromEnv(secrets),
    },
    { provide: MEDIA_QUEUE, useFactory: () => mediaQueueFromEnv() },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { StoriesModule } from './stories/stories.controller';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    HealthModule.forService('api-public-read'),
    StoriesModule,
  ],
  // RFC 9457 errors (D30). api-user and api-admin adopt it with their first M1/M2 commands.
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { MediaResultsController } from './media-results.controller';

@Module({
  imports: [SecretsModule, DatabaseModule, HealthModule.forService('workflow')],
  controllers: [MediaResultsController],
  // D30: every error as an RFC 9457 problem; unknown errors never say why (a 500: Pub/Sub retries).
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { SecretsModule } from '@heisreal/secrets';

@Module({
  imports: [SecretsModule, DatabaseModule, HealthModule.forService('api-read')],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConsentModule } from '@heisreal/consent';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { SecretsModule } from '@heisreal/secrets';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // D21: global fail-closed consent guard (approve checks the submitter's consent, M3).
    ConsentModule.forRoot(),
    HealthModule.forService('api-admin'),
  ],
})
export class AppModule {}

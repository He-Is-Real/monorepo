import { Module } from '@nestjs/common';
import { AccountConsentsModule, ConsentModule } from '@heisreal/consent';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { SecretsModule } from '@heisreal/secrets';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // D21: global fail-closed consent guard. Sign-in (the authenticator) arrives with task 0.5;
    // until then every personal route answers 401.
    ConsentModule.forRoot(),
    AccountConsentsModule,
    HealthModule.forService('api-user'),
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ApiUserAuthenticator, ClerkAuthModule } from '@heisreal/auth';
import { AccountConsentsModule, ConsentModule } from '@heisreal/consent';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { SecretsModule } from '@heisreal/secrets';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // Task 0.5: Clerk session tokens, verified without the network. The person's `user` row
    // is created on first use, on api-user's own login (D13); their queries then run in their
    // own session (D27). Roles are optional here: every signed-in person is at least a User.
    ClerkAuthModule.forRoot({ rolePolicy: 'optional' }),
    // D21: global fail-closed consent guard.
    ConsentModule.forRoot({ authenticator: ApiUserAuthenticator }),
    AccountConsentsModule,
    HealthModule.forService('api-user'),
  ],
})
export class AppModule {}

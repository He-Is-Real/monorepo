import { Module } from '@nestjs/common';
import { ApiAdminAuthenticator, ClerkAuthModule } from '@heisreal/auth';
import { ConsentModule } from '@heisreal/consent';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { SecretsModule } from '@heisreal/secrets';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // Task 0.5 + D1: Clerk session tokens, and every route must declare its minimum role
    // (@RequiresRole, the contract's x-required-role) or @NoRoleRequired; the app won't start
    // otherwise. Staff need an existing `user` row: api-admin's login can't create one (D13).
    ClerkAuthModule.forRoot(),
    // D21: global fail-closed consent guard (approve checks the submitter's consent, M3).
    ConsentModule.forRoot({ authenticator: ApiAdminAuthenticator }),
    HealthModule.forService('api-admin'),
  ],
})
export class AppModule {}

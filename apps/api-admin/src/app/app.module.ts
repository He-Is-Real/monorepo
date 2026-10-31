import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiAdminAuthenticator, ClerkAuthModule } from '@heisreal/auth';
import { ConsentModule } from '@heisreal/consent';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { LegalDocumentsModule } from './legal-documents/legal-documents.controller';
import { SubmissionSettingsModule } from './submission-settings/submission-settings.controller';
import { ThemesModule } from './themes/themes.controller';

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
    LegalDocumentsModule,
    SubmissionSettingsModule,
    ThemesModule,
  ],
  // D30: every error as an RFC 9457 problem; unknown errors never say why.
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

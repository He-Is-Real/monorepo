import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiAdminAuthenticator, ClerkAuthModule } from '@heisreal/auth';
import {
  DatabaseAvailabilityInterceptor,
  DatabaseModule,
} from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { MediaUrlsModule } from '@heisreal/story-cards';
import { LegalDocumentsModule } from './legal-documents/legal-documents.controller';
import { ModerationModule } from './moderation/moderation.controller';
import { AllStoriesModule } from './stories/all-stories.controller';
import { SubmissionSettingsModule } from './submission-settings/submission-settings.controller';
import { ThemesModule } from './themes/themes.controller';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // Task 0.5 + D1: Clerk session tokens, and every route must declare its minimum role
    // (@RequiresRole, the contract's x-required-role) or @NoRoleRequired; the app won't start
    // otherwise. Staff need an existing `user` row: api-admin's login can't create one (D13).
    ClerkAuthModule.forRoot({ authenticator: ApiAdminAuthenticator }),
    HealthModule.forService('api-admin'),
    // Moderators' one-hour player and picture links (M3 plan PR 1, concern C6), signed like
    // api-public-read's (D52); without the BUNNY_* variables signing is off and links are null.
    MediaUrlsModule,
    AllStoriesModule,
    LegalDocumentsModule,
    ModerationModule,
    SubmissionSettingsModule,
    ThemesModule,
  ],
  // D30: every error as an RFC 9457 problem; unknown errors never say why.
  // The database restarting (Spot) is `503 service_restarting`, at once, not a hung request.
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: DatabaseAvailabilityInterceptor },
  ],
})
export class AppModule {}

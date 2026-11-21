import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  ApiAdminAuthenticator,
  ClerkAuthModule,
  PersonSessions,
} from '@heisreal/auth';
import {
  DatabaseAvailabilityInterceptor,
  DatabaseModule,
} from '@heisreal/database';
import { HealthController, HealthModule } from '@heisreal/health';
import { ProblemFilter, RateLimitModule, RateLimits } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { MediaUrlsModule } from '@heisreal/story-cards';
import {
  BlockListController,
  BlockListModule,
} from './block-list/block-list.controller';
import {
  LegalDocumentsController,
  LegalDocumentsModule,
} from './legal-documents/legal-documents.controller';
import {
  ModerationController,
  ModerationModule,
} from './moderation/moderation.controller';
import { StaffController, StaffModule } from './staff/staff.controller';
import {
  AllStoriesController,
  AllStoriesModule,
} from './stories/all-stories.controller';
import {
  SubmissionSettingsController,
  SubmissionSettingsModule,
} from './submission-settings/submission-settings.controller';
import { signInRefusal } from './sign-in-refusal';
import { ThemesController, ThemesModule } from './themes/themes.controller';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    RateLimitModule.forRoot(),
    // Task 0.5 + D1: Clerk session tokens, and every route must declare its minimum role
    // (@RequiresRole, the contract's x-required-role) or @NoRoleRequired; the app won't start
    // otherwise. Staff need an existing `user` row: api-admin's login can't create one (D13).
    ClerkAuthModule.forRoot({ authenticator: ApiAdminAuthenticator }),
    HealthModule.forService('api-admin'),
    // Moderators' one-hour player and picture links (M3 plan PR 1, concern C6), signed like
    // api-public-read's (D52); without the BUNNY_* variables signing is off and links are null.
    MediaUrlsModule,
    AllStoriesModule,
    BlockListModule,
    LegalDocumentsModule,
    ModerationModule,
    StaffModule,
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
export class AppModule implements NestModule {
  constructor(
    private readonly rateLimits: RateLimits,
    private readonly people: PersonSessions,
  ) {}

  // Rate limits (Joel 2026-11-21, RL-1..RL-9; groups and numbers in libs/http limits.ts). RL-2:
  // signed-in staff aren't limited; only requests refused for sign-in count, per address, and an
  // address over that gets the generic error before sign-in is checked. Health has its own.
  configure(consumer: MiddlewareConsumer) {
    const limits = this.rateLimits;
    consumer
      .apply(limits.refusals('staffRefused', signInRefusal(this.people)))
      .forRoutes(
        AllStoriesController,
        BlockListController,
        LegalDocumentsController,
        ModerationController,
        StaffController,
        SubmissionSettingsController,
        ThemesController,
      );
    consumer.apply(limits.for('health')).forRoutes(HealthController);
  }
}

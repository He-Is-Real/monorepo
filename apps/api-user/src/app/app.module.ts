import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiUserAuthenticator, ClerkAuthModule } from '@heisreal/auth';
import {
  DatabaseAvailabilityInterceptor,
  DatabaseModule,
} from '@heisreal/database';
import { HealthController, HealthModule } from '@heisreal/health';
import {
  LogKeysModule,
  ProblemFilter,
  RateLimitModule,
  RateLimits,
  route,
} from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { MediaUrlsModule } from '@heisreal/story-cards';
import { AccountController, AccountModule } from './account/account.controller';
import { ErasureModule } from './erasure/erasure.module';
import { ExportController, ExportModule } from './export/export.controller';
import {
  FavouritesController,
  FavouritesModule,
} from './favourites/favourites.controller';
import { BunnyWebhookModule } from './media/bunny-webhook';
import {
  BunnyStreamModule,
  StoriesController,
  StoriesModule,
} from './stories/stories.controller';

@Module({
  imports: [
    SecretsModule,
    // The log keys (log-hmac, log-search-hmac) for the request's wide event (libs/http).
    LogKeysModule,
    DatabaseModule,
    RateLimitModule.forRoot(),
    // Task 0.5: Clerk session tokens, verified without the network. The person's `user` row
    // is created on first use, on api-user's own login (D13); their queries then run in their
    // own session (D27). Every route declares its minimum role (the contract's x-required-role)
    // or @NoRoleRequired, or the app won't start (D1, fail closed). "Agree first" (plan 4e) is
    // the database's: it refuses the person's writes until they agree (403, agreements.ts).
    ClerkAuthModule.forRoot({ authenticator: ApiUserAuthenticator }),
    // Bunny Stream: uploads (PR 7) and erasure's video deletions (D40).
    BunnyStreamModule,
    // M2 plan PR 11: erasure for "Delete my account" and Clerk's user.deleted webhook (D39, D40,
    // D82).
    ErasureModule,
    // Media ready (M2 plan item 13, D78): Bunny's "finished", "failed" and "deleted" notices,
    // checked, written to the mediaJob table and sent on media-jobs for the media worker.
    BunnyWebhookModule,
    // The account bootstrap, agreeing (plan 4e) and "Delete my account".
    AccountModule,
    // Hearts (M2). Their cards carry signed thumbnail and image links, signed like
    // api-public-read's (D52); without the BUNNY_* variables signing is off and links are null.
    MediaUrlsModule,
    FavouritesModule,
    // M2 plan PR 12: "Download my data" (Art 15, Art 20), with ErasureModule's Clerk client.
    ExportModule,
    // M2 plan PR 4: the submit flow for written stories.
    StoriesModule,
    HealthModule.forService('api-user'),
  ],
  // D30: every error as an RFC 9457 problem; unknown errors never say why.
  // The database restarting (Spot) is `503 service_restarting`, at once, not a hung request.
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: DatabaseAvailabilityInterceptor },
  ],
})
export class AppModule implements NestModule {
  constructor(private readonly rateLimits: RateLimits) {}

  // Rate limits (Joel 2026-11-21, RL-1..RL-9; groups and numbers in libs/http limits.ts), per
  // address. The provider webhooks have none yet: their signatures are checked, and a ceiling
  // waits until their real bursts are known (the decision document's starting table).
  configure(consumer: MiddlewareConsumer) {
    const limits = this.rateLimits;
    consumer
      .apply(
        limits.byMethod({
          read: 'accountReads',
          write: 'accountWrites',
          delete: 'deletion',
        }),
      )
      .forRoutes(AccountController, StoriesController);
    consumer
      .apply(limits.byMethod({ read: 'accountReads', write: 'accountWrites' }))
      .forRoutes(FavouritesController);
    // Upload grants count here as well as in accountWrites.
    consumer
      .apply(limits.for('uploadGrants'))
      .forRoutes(route('v1/stories/:id/upload-url', RequestMethod.POST));
    consumer.apply(limits.for('dataExport')).forRoutes(ExportController);
    consumer.apply(limits.for('health')).forRoutes(HealthController);
  }
}

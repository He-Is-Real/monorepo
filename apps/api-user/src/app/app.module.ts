import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiUserAuthenticator, ClerkAuthModule } from '@heisreal/auth';
import { AccountConsentsModule, ConsentModule } from '@heisreal/consent';
import { DatabaseModule } from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { MediaUrlsModule } from '@heisreal/story-cards';
import { AccountModule } from './account/account.controller';
import { ErasureModule } from './erasure/erasure.module';
import { FavouritesModule } from './favourites/favourites.controller';
import { BunnyStreamModule, StoriesModule } from './stories/stories.controller';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // Task 0.5: Clerk session tokens, verified without the network. The person's `user` row
    // is created on first use, on api-user's own login (D13); their queries then run in their
    // own session (D27). Every route declares its minimum role (the contract's x-required-role)
    // or @NoRoleRequired, or the app won't start (D1, fail closed as for consent).
    ClerkAuthModule.forRoot(),
    // D21: global fail-closed consent guard.
    ConsentModule.forRoot({ authenticator: ApiUserAuthenticator }),
    // Bunny Stream: uploads (PR 7) and erasure's video deletions (D40).
    BunnyStreamModule,
    // M2 plan PR 11: erasure for "Delete my account", the consent withdrawals that delete the
    // account (D88, D73) and Clerk's user.deleted webhook (D39, D40, D82).
    ErasureModule,
    AccountConsentsModule,
    AccountModule,
    // Hearts (M2). Their cards carry signed thumbnail and image links, signed like
    // api-public-read's (D52); without the BUNNY_* variables signing is off and links are null.
    MediaUrlsModule,
    FavouritesModule,
    // M2 plan PR 4: the submit flow for written stories.
    StoriesModule,
    HealthModule.forService('api-user'),
  ],
  // D30: every error as an RFC 9457 problem; unknown errors never say why.
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

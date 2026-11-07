import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  DatabaseAvailabilityInterceptor,
  DatabaseModule,
} from '@heisreal/database';
import { HealthModule } from '@heisreal/health';
import { ProblemFilter } from '@heisreal/http';
import { SecretsModule } from '@heisreal/secrets';
import { LegalModule } from './legal/legal.controller';
import { MediaUrlsModule } from '@heisreal/story-cards';
import { SiteVideosModule } from './site-videos/site-videos.controller';
import { StoriesModule } from './stories/stories.controller';
import { ThemesModule } from './themes/themes.controller';
import { PublicAnswerCache, PublicCacheInterceptor } from './public-cache';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    MediaUrlsModule,
    HealthModule.forService('api-public-read'),
    StoriesModule,
    ThemesModule,
    LegalModule,
    SiteVideosModule,
  ],
  // RFC 9457 errors (D30). api-user and api-admin adopt it with their first M1/M2 commands.
  // R13: recent public answers from memory, for 60 seconds at most (public-cache.ts).
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: PublicAnswerCache, useFactory: () => new PublicAnswerCache() },
    { provide: APP_INTERCEPTOR, useClass: PublicCacheInterceptor },
    // After the cache, so a remembered answer is still served while the database restarts;
    // anything else is `503 service_restarting` at once.
    { provide: APP_INTERCEPTOR, useClass: DatabaseAvailabilityInterceptor },
  ],
})
export class AppModule {}

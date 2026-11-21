import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import {
  DatabaseAvailabilityInterceptor,
  DatabaseModule,
} from '@heisreal/database';
import { HealthController, HealthModule } from '@heisreal/health';
import { ProblemFilter, RateLimitModule, RateLimits } from '@heisreal/http';
import { SecretsModule, SecretsService } from '@heisreal/secrets';
import { LegalController, LegalModule } from './legal/legal.controller';
import { MediaUrlsModule } from '@heisreal/story-cards';
import {
  SiteVideosController,
  SiteVideosModule,
} from './site-videos/site-videos.controller';
import { BrowseController } from './stories/browse.controller';
import { StoriesController, StoriesModule } from './stories/stories.controller';
import { ThemesController, ThemesModule } from './themes/themes.controller';
import { PublicAnswerCache, PublicCacheInterceptor } from './public-cache';
import { websiteKeyFromSecret } from './website-key';

@Module({
  imports: [
    SecretsModule,
    DatabaseModule,
    // RL-8 A: web's own server carries the website key and shares one large allowance.
    RateLimitModule.forRoot({
      websiteKey: {
        inject: [SecretsService],
        useFactory: websiteKeyFromSecret,
      },
    }),
    MediaUrlsModule,
    HealthModule.forService('api-public-read'),
    StoriesModule,
    ThemesModule,
    LegalModule,
    SiteVideosModule,
  ],
  // RFC 9457 errors (D30). api-user and api-admin adopt it with their first M1/M2 commands.
  // R13: recent public answers from memory, for 30 seconds at most (public-cache.ts).
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: PublicAnswerCache, useFactory: () => new PublicAnswerCache() },
    { provide: APP_INTERCEPTOR, useClass: PublicCacheInterceptor },
    // After the cache, so a remembered answer is still served while the database restarts;
    // anything else is `503 service_restarting` at once.
    { provide: APP_INTERCEPTOR, useClass: DatabaseAvailabilityInterceptor },
  ],
})
export class AppModule implements NestModule {
  constructor(private readonly rateLimits: RateLimits) {}

  // Rate limits (Joel 2026-11-21, RL-1..RL-9; groups and numbers in libs/http limits.ts).
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(this.rateLimits.publicReads())
      .forRoutes(
        StoriesController,
        BrowseController,
        ThemesController,
        LegalController,
        SiteVideosController,
      );
    consumer.apply(this.rateLimits.for('health')).forRoutes(HealthController);
  }
}

import { Global, type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import type { TestDatabase } from '@heisreal/database/integration-testing';
import { ProblemFilter } from '@heisreal/http';
import type { Surreal } from 'surrealdb';
import { MediaUrls } from '../src/app/media/media-urls';
import { StoriesModule } from '../src/app/stories/stories.controller';
import { TagsModule } from '../src/app/tags/tags.controller';

/** api-public-read's real controllers on its own read-only login (D13), listening locally. */
export async function startPublicRead(
  t: TestDatabase,
): Promise<{ app: INestApplication; url: string }> {
  const connection: Surreal = await t.service('api_public_read');

  @Global()
  @Module({
    providers: [
      { provide: SURREAL, useValue: connection },
      { provide: MediaUrls, useValue: new MediaUrls(null) },
    ],
    exports: [SURREAL, MediaUrls],
  })
  class ReadOnlyDatabase {}

  const moduleRef = await Test.createTestingModule({
    imports: [ReadOnlyDatabase, StoriesModule, TagsModule],
    providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

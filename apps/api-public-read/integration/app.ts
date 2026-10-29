import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import type { TestDatabase } from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { MediaUrls } from '@heisreal/story-cards';
import { checkResponsesAgainstContract } from './contract';
import {
  SITE_VIDEOS,
  type SiteVideos,
} from '../src/app/site-videos/site-videos.controller';

/**
 * api-public-read's real AppModule (every controller, the health check and the error format)
 * on its own read-only login (D13), listening locally. Only what reaches outside is swapped:
 * the database connection is the test database's, Secret Manager is never called, and media
 * signing is off unless a `MediaUrls` is given. `connection` replaces the login, e.g. with a
 * closed one to stand for a database that's down. Site videos are none unless given.
 */
export async function startPublicRead(
  t: TestDatabase,
  media: MediaUrls = new MediaUrls(null),
  connection?: Surreal,
  { siteVideos = new Map() }: { siteVideos?: SiteVideos } = {},
): Promise<{ app: INestApplication; url: string }> {
  const db = connection ?? (await t.service('api_public_read'));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SURREAL)
    .useValue(db)
    .overrideProvider(MediaUrls)
    .useValue(media)
    .overrideProvider(SITE_VIDEOS)
    .useValue(siteVideos)
    .overrideProvider(SECRET_MANAGER_CLIENT)
    .useValue({})
    .overrideProvider(SECRETS_PROJECT)
    .useValue('test-project')
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  checkResponsesAgainstContract(app);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

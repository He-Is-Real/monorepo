import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  agreeAll,
  createPeople,
  draft,
  grantUpload,
  rows,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  BUNNY_WEBHOOK_CONFIG,
  MEDIA_JOBS,
  type MediaJob,
  type MediaJobs,
} from '../src/app/media/bunny-webhook';

/**
 * Bunny's webhook through api-user's real AppModule (media-worker-final.html, steps 1-3): the job
 * is written to the mediaJob table first, then sent on media-jobs with its id (in order per
 * story), then its send is recorded; a send that fails leaves the job in the table. Pub/Sub is an
 * in-memory stand-in that records what it was given and can be made to fail.
 */
class FakeQueue implements MediaJobs {
  readonly sent: { job: MediaJob; orderingKey: string }[] = [];
  failing = false;
  async publish(job: MediaJob, orderingKey: string) {
    if (this.failing) throw new Error('Pub/Sub answered 503');
    this.sent.push({ job, orderingKey });
  }
}

const KEY = 'a1b2c3d4-read-only-library-key';
const LIBRARY = 789855;

describe('Bunny webhook: the job is written, then sent', () => {
  const contract = new Contract('api-user.yaml');
  const queue = new FakeQueue();
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let app: INestApplication;
  let url: string;
  let n = 0;

  async function notice(videoGuid: string, status: number) {
    const body = JSON.stringify({
      VideoLibraryId: LIBRARY,
      VideoGuid: videoGuid,
      Status: status,
      EventId: `evt_${++n}`,
      Timestamp: '2026-11-07T10:00:00Z',
    });
    const res = await fetch(`${url}/v1/webhooks/bunny`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bunnystream-signature': createHmac('sha256', KEY)
          .update(body)
          .digest('hex'),
        'x-bunnystream-signature-version': 'v1',
        'x-bunnystream-signature-algorithm': 'hmac-sha256',
      },
      body,
    });
    expect(await contract.check('POST', res), 'POST webhook').toEqual([]);
    return res.status;
  }

  /** A video draft of pat's whose file is the Bunny video it returns. */
  async function videoDraft() {
    const story = `wh_${++n}`;
    const video = randomUUID();
    const pat = await t.person('user_pat');
    await draft(pat, story, { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, { video, story, person: 'pat', version: 1 }),
    ).toMatchObject({ ok: true });
    return { story, video };
  }
  const jobs = (video: string) =>
    rows(
      migrator,
      `SELECT record::id(id) AS id, kind, reasons, sends, sentAt != NONE AS sent, doneAt
       FROM mediaJob WHERE file = type::record('storyFile', $video)`,
      { video },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    const clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    await createPeople(t, { pat: 'user_pat' });
    await agreeAll(await t.person('user_pat'));
    await rows(
      migrator,
      `UPSERT submitterLimits:pat SET user = user:pat, openDraftsMax = 100,
         uploadRequestsPerHour = 100, uploadsPer7Days = 100`,
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(apiUser)
      .overrideProvider(CLERK_CONFIG)
      .useValue(
        parseClerkConfig({
          issuer: clerk.issuer,
          publicKeyPem: clerk.publicKeyPem,
          authorizedParties: clerk.authorizedParty,
        }),
      )
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .overrideProvider(BUNNY_WEBHOOK_CONFIG)
      .useValue({ libraryId: LIBRARY, readonlyKey: async () => KEY })
      .overrideProvider(MEDIA_JOBS)
      .useValue(queue)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    await app.listen(0);
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });
  beforeEach(() => {
    queue.sent.length = 0;
    queue.failing = false;
  });

  it('"finished" writes a check job, sends it with its id in story order, then records the send', async () => {
    const { story, video } = await videoDraft();

    expect(await notice(video, 3)).toBe(200);

    const [job] = await jobs(video);
    expect(job).toMatchObject({
      kind: 'check',
      reasons: ['bunny_finished'],
      sends: 1,
      sent: true,
    });
    expect(queue.sent).toEqual([
      {
        job: {
          jobId: job['id'],
          kind: 'check',
          videoId: video,
          eventId: `evt_${n}`,
        },
        orderingKey: story,
      },
    ]);
  });

  it('a "deleted" notice for a file with an open job joins it and sends it again', async () => {
    const { video } = await videoDraft();
    await notice(video, 3);

    expect(await notice(video, 32)).toBe(200);

    expect(await jobs(video)).toEqual([
      expect.objectContaining({
        reasons: ['bunny_finished', 'bunny_deleted'],
        sends: 2,
      }),
    ]);
    expect(queue.sent.map((s) => s.job.jobId)).toEqual([
      (await jobs(video))[0]['id'],
      (await jobs(video))[0]['id'],
    ]);
  });

  it('a send that fails answers 503 and leaves the job in the table, not marked sent', async () => {
    const { video } = await videoDraft();
    queue.failing = true;

    expect(await notice(video, 5)).toBe(503);

    expect(await jobs(video)).toEqual([
      expect.objectContaining({
        reasons: ['bunny_failed'],
        sends: 0,
        sent: false,
      }),
    ]);
  });

  it('a video no story file names, and statuses we don’t act on, are acknowledged and dropped', async () => {
    const { video } = await videoDraft();
    const stranger = randomUUID();

    expect(await notice(stranger, 3)).toBe(200);
    expect(await notice(video, 4)).toBe(200);

    expect(await jobs(stranger)).toEqual([]);
    expect(await jobs(video)).toEqual([]);
    expect(queue.sent).toEqual([]);
  });
});

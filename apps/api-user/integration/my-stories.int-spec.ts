import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  approve,
  createPeople,
  grantAll,
  publishDpa,
  rows,
  run,
  STORY_TEXT_PADDING,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
} from '../src/app/stories/bunny-stream';

/**
 * The profile's commands on the person's own stories (M2 plan PR 8), through api-user's real
 * AppModule as /account calls them: WithdrawStory and DeleteStory (D71). The database is the
 * behaviour: what may be deleted is its story permission, and a delete reaches every copy
 * (story_erasure_cascade). Bunny Stream is an in-memory stand-in that records deletes. Every
 * answer is checked against api-user.yaml. The list also says when each draft will be deleted
 * (fn::story::draft_expires_at, the rule housekeeping deletes by).
 */
class FakeStream implements BunnyStream {
  readonly deleted: string[] = [];
  async createVideo() {
    return randomUUID();
  }
  async video() {
    return null;
  }
  async deleteVideo(id: string) {
    this.deleted.push(id);
  }
  sign(videoId: string, now?: number) {
    return signUpload('42', 'library-key', videoId, now);
  }
}

describe('my stories: withdraw and delete', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let admin: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;
  const key = () => `profile-key-${++keySeq}-${'x'.repeat(16)}`;

  async function call(
    method: string,
    path: string,
    who: string,
    {
      body,
      headers = {},
    }: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${clerk.token(`user_${who}`)}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  async function person(who: string) {
    await createPeople(t, { [who]: `user_${who}` });
    await grantAll(await t.person(`user_${who}`));
  }
  const create = async (who: string, format = 'written') => {
    const res = await call('POST', '/v1/stories', who, {
      body: {
        title: 'How I found hope',
        primaryFormat: format,
        tagSlugs: ['healing'],
        ...(format === 'written'
          ? { body: `My story${STORY_TEXT_PADDING}` }
          : {}),
      },
      headers: { 'idempotency-key': key() },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const submit = (who: string, id: string, version: number) =>
    call('POST', `/v1/stories/${id}/submit`, who, {
      headers: { 'if-match': `"${version}"`, 'idempotency-key': key() },
    });
  const withdraw = (who: string, id: string, version: number) =>
    call('POST', `/v1/stories/${id}/withdraw`, who, {
      headers: { 'if-match': `"${version}"` },
    });
  const remove = (who: string, id: string, version: number) =>
    call('DELETE', `/v1/stories/${id}`, who, {
      headers: { 'if-match': `"${version}"` },
    });
  const statusOf = async (id: string) =>
    (
      await rows<string>(
        migrator,
        `SELECT VALUE status FROM type::record('story', $id)`,
        { id },
      )
    )[0];
  const versionOf = async (id: string) =>
    (
      await rows<number>(
        migrator,
        `SELECT VALUE version FROM type::record('story', $id)`,
        { id },
      )
    )[0];
  /** A moderator's status (in_review, rejected …), set as a system user would. */
  const moderate = (id: string, status: string) =>
    run(migrator, `UPDATE type::record('story', $id) SET status = $status`, {
      id,
      status,
    });

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_user'))
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
      .overrideProvider(BUNNY_STREAM)
      .useValue(bunny)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
    await createPeople(t, { moderator: 'user_mod' });
    await run(
      admin,
      `CREATE tag:healing SET name = 'Healing', category = 'theme'`,
    );
    // More stories each than D94's limits let a person start: trusted.
    for (const who of ['ann', 'bob']) {
      await person(who);
      await run(
        migrator,
        `CREATE type::record('submitterLimits', $who) SET user = type::record('user', $who), trusted = true`,
        { who },
      );
    }
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('withdraws a published story off the site at once, then deletes it everywhere', async () => {
    const id = await create('ann');
    expect((await submit('ann', id, 1)).status).toBe(200);
    await approve(admin, id);
    // Bob hearts it.
    await run(
      await t.person('user_bob'),
      `CREATE favourite CONTENT { person: $auth, story: type::record('story', $id) }`,
      { id },
    );
    const live = await versionOf(id);

    const withdrawn = await withdraw('ann', id, live);
    expect(withdrawn).toEqual({
      status: 200,
      body: { id, version: live + 1 },
    });
    expect(await statusOf(id)).toBe('withdrawn');
    expect(
      await rows(migrator, `SELECT id FROM type::record('publicStory', $id)`, {
        id,
      }),
    ).toEqual([]);
    // Withdrawn stays withdrawn (D61): nothing to withdraw again.
    expect((await withdraw('ann', id, live + 1)).body.code).toBe(
      'story_not_withdrawable',
    );

    expect((await remove('ann', id, live + 1)).status).toBe(204);
    expect(
      await rows(
        migrator,
        `RETURN [
           (SELECT id FROM type::record('story', $id)),
           (SELECT id FROM moderationReview WHERE story = type::record('story', $id)),
           (SELECT id FROM favourite WHERE story = type::record('story', $id))
         ]`,
        { id },
      ),
    ).toEqual([[], [], []]);
    // A retry after a lost answer: it's gone.
    expect((await remove('ann', id, live + 1)).status).toBe(404);
  });

  it('deletes a draft and the video made for it at Bunny; its upload still counts', async () => {
    const id = await create('ann', 'video');
    const upload = await call('POST', `/v1/stories/${id}/upload-url`, 'ann', {
      body: {
        format: 'video',
        contentType: 'video/mp4',
        fileSizeBytes: 2_000_000,
        durationSeconds: 30,
      },
      headers: { 'if-match': '"1"', 'idempotency-key': key() },
    });
    expect(upload.status).toBe(200);
    const videoId = upload.body.headers.VideoId as string;

    expect((await remove('ann', id, 2)).status).toBe(204);
    expect(await statusOf(id)).toBeUndefined();
    expect(bunny.deleted).toContain(videoId);
    // D113: the grant stays, so deleting a story frees no upload.
    expect(
      await rows(
        migrator,
        `SELECT VALUE record::id(id) FROM type::record('uploadGrant', $v)`,
        { v: videoId },
      ),
    ).toEqual([videoId]);
  });

  it('deletes a story sent back for changes without withdrawing it, and its video at Bunny', async () => {
    const id = await create('ann', 'video');
    const upload = await call('POST', `/v1/stories/${id}/upload-url`, 'ann', {
      body: {
        format: 'video',
        contentType: 'video/mp4',
        fileSizeBytes: 2_000_000,
        durationSeconds: 30,
      },
      headers: { 'if-match': '"1"', 'idempotency-key': key() },
    });
    expect(upload.status).toBe(200);
    const videoId = upload.body.headers.VideoId as string;
    await moderate(id, 'changes_requested');

    expect((await remove('ann', id, await versionOf(id))).status).toBe(204);
    expect(await statusOf(id)).toBeUndefined();
    expect(bunny.deleted).toContain(videoId);
  });

  it('tells the owner when each draft will be deleted: 186 days after its last edit or resumed upload', async () => {
    const DAY = 864e5;
    const written = await create('ann');
    const video = await create('ann', 'video');
    const upload = await call(
      'POST',
      `/v1/stories/${video}/upload-url`,
      'ann',
      {
        body: {
          format: 'video',
          contentType: 'video/mp4',
          fileSizeBytes: 2_000_000,
          durationSeconds: 30,
        },
        headers: { 'if-match': '"1"', 'idempotency-key': key() },
      },
    );
    expect(upload.status).toBe(200);
    const submitted = await create('ann');
    expect((await submit('ann', submitted, 1)).status).toBe(200);
    // The upload is resumed later (api-user renews its grant): that counts as activity.
    const [renewedAt] = await rows<string>(
      migrator,
      `UPDATE type::record('uploadGrant', $v) SET renewedAt = time::now() RETURN VALUE <string> time::floor(renewedAt, 1ms)`,
      { v: upload.body.headers.VideoId },
    );

    const { status, body } = await call('GET', '/v1/account/stories', 'ann');
    expect(status).toBe(200);
    const byId = new Map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (body.data as any[]).map((s) => [s.id, s]),
    );
    const mine = byId.get(written);
    expect(Date.parse(mine.draftExpiresAt)).toBe(
      Date.parse(mine.updatedAt) + 186 * DAY,
    );
    expect(Date.parse(byId.get(video).draftExpiresAt)).toBe(
      Date.parse(renewedAt) + 186 * DAY,
    );
    expect(byId.get(submitted).draftExpiresAt).toBeNull();
  });

  it('refuses to delete a story under review or published, or someone else’s, changing nothing', async () => {
    const pending = await create('ann');
    expect((await submit('ann', pending, 1)).status).toBe(200);
    const inReview = await create('ann');
    await moderate(inReview, 'in_review');
    const approved = await create('ann');
    expect((await submit('ann', approved, 1)).status).toBe(200);
    await approve(admin, approved);

    for (const id of [pending, inReview, approved]) {
      const res = await remove('ann', id, await versionOf(id));
      expect([res.status, res.body.code]).toEqual([409, 'story_not_deletable']);
    }
    expect(
      await Promise.all([pending, inReview, approved].map(statusOf)),
    ).toEqual(['pending', 'in_review', 'approved']);

    // Someone else's draft: as if it didn't exist, to delete or to withdraw.
    const bobs = await create('bob');
    expect((await remove('ann', bobs, 1)).status).toBe(404);
    expect((await withdraw('ann', bobs, 1)).status).toBe(404);
    expect(await statusOf(bobs)).toBe('draft');

    // A draft is deleted, not withdrawn; a stale version changes nothing.
    expect((await withdraw('bob', bobs, 1)).body.code).toBe(
      'story_not_withdrawable',
    );
    expect((await remove('bob', bobs, 7)).status).toBe(412);
    expect(await statusOf(bobs)).toBe('draft');
  });
});

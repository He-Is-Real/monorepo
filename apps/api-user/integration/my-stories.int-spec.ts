import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  agreeAll,
  approve,
  createPeople,
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
 * AppModule as /account calls them: Edit (ED-1, ED-4) and DeleteStory (ED-3, every state). The
 * database is the behaviour: which steps a story may take is its status log's rule, and a delete
 * reaches every copy
 * (story_erasure_cascade). Bunny Stream is an in-memory stand-in that records deletes. Every
 * answer is checked against api-user.yaml. The list also says when each draft, story being edited
 * after it was sent, and rejected story will be deleted (fn::story::deletes_at, the rule
 * housekeeping deletes by).
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

describe('my stories: edit and delete', () => {
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
    await agreeAll(await t.person(`user_${who}`));
  }
  const create = async (who: string, format = 'written') => {
    const res = await call('POST', '/v1/stories', who, {
      body: {
        title: 'How I found hope',
        primaryFormat: format,
        themeIds: ['healing'],
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
  const startEditing = (who: string, id: string, version: number) =>
    call('POST', `/v1/stories/${id}/edit`, who, {
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
        `SELECT VALUE fn::story::status_of($this) FROM type::record('story', $id)`,
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
  /**
   * The person sends their story, then a moderator decides it (`action`: e.g. changesRequested,
   * rejected), as the status log (R6) records it. Added as a system user, which names who did each
   * step.
   */
  const moderate = (id: string, action: string) =>
    run(
      migrator,
      `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'sent',
         actor: 'person' };
       CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: $action,
         actor: 'moderator', by: user:moderator, comment: 'Please say more about the start' };`,
      { id, action },
    );
  const mine = async (who: string, id: string) =>
    (await call('GET', `/v1/account/stories/${id}`, who)).body;

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
    await createPeople(t, { moderator: 'user_mod' });
    await run(
      admin,
      `CREATE theme:healing SET name = 'Healing', category = themeCategory:other`,
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

  it('Edit takes a published story off the site at once; it changes, goes back and keeps its address, hearts and date; then Delete removes it everywhere', async () => {
    const id = await create('ann');
    const before = await mine('ann', id);
    expect(before).toMatchObject({ status: 'editing', submittedAt: null });
    // Before its first approval, the address follows the title (SL-1 A).
    const retitled = await call('PATCH', `/v1/stories/${id}`, 'ann', {
      body: { title: 'Hope found me' },
      headers: {
        'if-match': '"1"',
        'content-type': 'application/merge-patch+json',
      },
    });
    expect(retitled.status).toBe(200);
    const slug = (await mine('ann', id)).slug as string;
    expect(slug).toMatch(/^hope-found-me-/);
    expect((await submit('ann', id, 2)).status).toBe(200);
    await approve(admin, id);
    // Bob hearts it.
    await run(
      await t.person('user_bob'),
      `CREATE favourite:ulid() CONTENT { person: $auth, story: type::record('story', $id) }`,
      { id },
    );
    const published = await mine('ann', id);
    expect(published).toMatchObject({ status: 'approved', slug });
    const live = published.version as number;

    const editing = await startEditing('ann', id, live);
    expect(editing).toEqual({
      status: 200,
      body: { id, version: live + 1 },
    });
    expect(await statusOf(id)).toBe('editing');
    expect(
      await rows(
        await t.service('api_public_read'),
        `SELECT id FROM type::record('story', $id)`,
        { id },
      ),
    ).toEqual([]);
    // Being edited already: nothing to take down.
    expect((await startEditing('ann', id, live + 1)).body.code).toBe(
      'story_not_editable',
    );
    // After its first approval the address never changes, even with a new title (SL-1 A).
    const edited = await call('PATCH', `/v1/stories/${id}`, 'ann', {
      body: { title: 'A new title' },
      headers: {
        'if-match': `"${live + 1}"`,
        'content-type': 'application/merge-patch+json',
      },
    });
    expect(edited.status).toBe(200);
    expect(await mine('ann', id)).toMatchObject({
      title: 'A new title',
      slug,
      status: 'editing',
      submittedAt: published.submittedAt,
      approvedAt: published.approvedAt,
    });
    expect((await submit('ann', id, live + 2)).status).toBe(200);
    await approve(admin, id);
    expect(await mine('ann', id)).toMatchObject({
      status: 'approved',
      slug,
      approvedAt: published.approvedAt,
    });
    expect(
      await rows(
        migrator,
        `SELECT VALUE id FROM favourite WHERE story = type::record('story', $id)`,
        { id },
      ),
    ).toHaveLength(1);

    // Delete, straight from published (ED-3).
    expect((await remove('ann', id, await versionOf(id))).status).toBe(204);
    expect(
      await rows(
        migrator,
        `RETURN [
           (SELECT id FROM type::record('story', $id)),
           (SELECT id FROM storyStatusLog WHERE story = type::record('story', $id)),
           (SELECT id FROM favourite WHERE story = type::record('story', $id))
         ]`,
        { id },
      ),
    ).toEqual([[], [], []]);
    // A retry after a lost answer: it's gone.
    expect((await remove('ann', id, 1)).status).toBe(404);
  });

  it('shows the owner the real status: hidden as hidden (G2), and a moderator’s note while sent back or rejected', async () => {
    const hidden = await create('ann');
    expect((await submit('ann', hidden, 1)).status).toBe(200);
    await approve(admin, hidden);
    await run(
      admin,
      `CREATE storyStatusLog CONTENT { story: type::record('story', $id),
         action: 'hiddenByModerator', comment: 'Checking something', by: user:moderator }`,
      { id: hidden },
    );
    expect(await mine('ann', hidden)).toMatchObject({
      status: 'hidden',
      rejectionFeedback: null,
    });
    const listed = await call(
      'GET',
      '/v1/account/stories?status=hidden',
      'ann',
    );
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual([hidden]);
    // A hidden story can be taken down to edit.
    expect(
      (await startEditing('ann', hidden, await versionOf(hidden))).status,
    ).toBe(200);

    const sentBack = await create('ann');
    await moderate(sentBack, 'changesRequested');
    expect(await mine('ann', sentBack)).toMatchObject({
      status: 'editing',
      rejectionFeedback: 'Please say more about the start',
      submittedAt: expect.any(String),
    });
    const rejected = await create('ann');
    await moderate(rejected, 'rejected');
    expect(await mine('ann', rejected)).toMatchObject({
      status: 'rejected',
      rejectionFeedback: 'Please say more about the start',
    });
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
        `SELECT VALUE record::id(id) FROM type::record('storyFile', $v)`,
        { v: videoId },
      ),
    ).toEqual([videoId]);
  });

  it('deletes a story sent back for changes, and its video at Bunny', async () => {
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
    await moderate(id, 'changesRequested');

    expect((await remove('ann', id, await versionOf(id))).status).toBe(204);
    expect(await statusOf(id)).toBeUndefined();
    expect(bunny.deleted).toContain(videoId);
  });

  it('tells the owner when each draft, story being edited after it was sent, and rejected story will be deleted', async () => {
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
    // G3 B: sent back for changes, the Limits page's 186 days after it was last touched (the
    // drafts' clock); rejected, its 90 days after the rejection.
    const sentBack = await create('ann');
    await moderate(sentBack, 'changesRequested');
    const rejected = await create('ann');
    await moderate(rejected, 'rejected');
    const [rejectedAt] = await rows<string>(
      migrator,
      `SELECT VALUE <string> currentStatus.at FROM type::record('story', $id)`,
      { id: rejected },
    );
    // The upload is resumed later (api-user renews its grant): that counts as activity.
    const [renewedAt] = await rows<string>(
      migrator,
      `UPDATE type::record('storyFile', $v) SET renewedAt = time::now() RETURN VALUE <string> time::floor(renewedAt, 1ms)`,
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
    const back = byId.get(sentBack);
    expect(Date.parse(back.draftExpiresAt)).toBe(
      Date.parse(back.updatedAt) + 186 * DAY,
    );
    expect(Date.parse(byId.get(rejected).draftExpiresAt)).toBe(
      Date.parse(rejectedAt) + 90 * DAY,
    );
  });

  it('deletes a story in every state, never someone else’s; Edit only from waiting, published or hidden', async () => {
    const pending = await create('ann');
    expect((await submit('ann', pending, 1)).status).toBe(200);
    const approved = await create('ann');
    expect((await submit('ann', approved, 1)).status).toBe(200);
    await approve(admin, approved);
    const rejected = await create('ann');
    await moderate(rejected, 'rejected');

    // A rejected story can only be deleted; a draft is already being edited.
    for (const id of [rejected]) {
      const res = await startEditing('ann', id, await versionOf(id));
      expect([res.status, res.body.code]).toEqual([409, 'story_not_editable']);
    }
    for (const id of [pending, approved, rejected]) {
      expect((await remove('ann', id, await versionOf(id))).status).toBe(204);
      expect(await statusOf(id)).toBeUndefined();
    }

    // Someone else's draft: as if it didn't exist, to delete or to edit.
    const bobs = await create('bob');
    expect((await remove('ann', bobs, 1)).status).toBe(404);
    expect((await startEditing('ann', bobs, 1)).status).toBe(404);
    expect(await statusOf(bobs)).toBe('editing');

    // A draft is being edited already; a stale version changes nothing.
    expect((await startEditing('bob', bobs, 1)).body.code).toBe(
      'story_not_editable',
    );
    expect((await remove('bob', bobs, 7)).status).toBe(412);
    expect(await statusOf(bobs)).toBe('editing');
  });

  // Everyone reads a published story (R11), so the owner's routes ask for their own themselves
  // (Codex, B1 round 1: Ann read Bob's as hers).
  it('someone else’s published story is not found on any of the owner’s routes', async () => {
    const bobs = await create('bob');
    expect((await submit('bob', bobs, 1)).status).toBe(200);
    await approve(admin, bobs);
    const version = await versionOf(bobs);
    const ifMatch = { 'if-match': `"${version}"` };

    expect(
      (await call('GET', `/v1/account/stories/${bobs}`, 'ann')).status,
    ).toBe(404);
    expect(
      (await call('GET', '/v1/account/stories', 'ann')).body.data.map(
        (s: { id: string }) => s.id,
      ),
    ).not.toContain(bobs);
    for (const res of [
      await call('PATCH', `/v1/stories/${bobs}`, 'ann', {
        body: { title: 'Not mine' },
        headers: { ...ifMatch, 'content-type': 'application/merge-patch+json' },
      }),
      await call('POST', `/v1/stories/${bobs}/submit`, 'ann', {
        headers: { ...ifMatch, 'idempotency-key': key() },
      }),
      await startEditing('ann', bobs, version),
      await remove('ann', bobs, version),
      await call('POST', `/v1/stories/${bobs}/upload-url`, 'ann', {
        body: {
          format: 'video',
          contentType: 'video/mp4',
          fileSizeBytes: 1000,
          durationSeconds: 10,
        },
        headers: { ...ifMatch, 'idempotency-key': key() },
      }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect([await statusOf(bobs), await versionOf(bobs)]).toEqual([
      'approved',
      version,
    ]);
    expect(
      (await call('GET', `/v1/account/stories/${bobs}`, 'bob')).status,
    ).toBe(200);
  });
});

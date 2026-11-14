import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import { StringRecordId } from 'surrealdb';
import {
  approve,
  buildWorld,
  draft,
  edit,
  processed,
  run,
  step,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { MediaUrls } from '@heisreal/story-cards';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';

const VIDEO = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const PICTURE = `stories/ann_video/${'a'.repeat(32)}.webp`;
const NOTE =
  'Thank you for sharing. Could you say a little more about the day it changed?';

/**
 * M3 plan PR 1 (tasks 3.1 and 3.2), MD-3 and MD-4: the moderators' list and one story, read-only,
 * through api-admin's real AppModule on its own login, with signing on. Every answer is checked
 * against api-admin.yaml. Concern C2: the database doesn't know who is a moderator, so each route
 * refuses a User here.
 */
describe('moderation, the read side (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let app: NestExpressApplication;
  let url: string;
  let ann: Awaited<ReturnType<typeof buildWorld>>['ann'];
  let migrator: Awaited<ReturnType<TestDatabase['migrator']>>;

  async function get(
    path: string,
    { role = 'Moderator', sub = 'user_mod', headers = {} } = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      headers: {
        authorization: `Bearer ${clerk.token(sub, { role })}`,
        ...headers,
      },
    });
    expect(await contract.check('GET', res), path).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      etag: res.headers.get('etag'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }

  /** Every story the list gives for `query`, page by page. */
  async function list(query: string, limit = 50, role = 'Moderator') {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await get(
        `/v1/moderation/stories?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        { role },
      );
      expect(page.status).toBe(200);
      ids.push(...page.body.data.map((s: { id: string }) => s.id));
      cursor = page.body.nextCursor;
    } while (cursor && ids.length <= 10);
    return ids;
  }

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    // Ann's and Bob's waiting stories (sent in that order), Bob's published one, two drafts.
    const world = await buildWorld(t);
    const { admin, bob } = world;
    ann = world.ann;
    migrator = await t.migrator();
    const workflow = await t.service('workflow');

    // A video story with a picture, processed, then sent: third in the queue.
    await draft(ann, 'ann_video', { primaryFormat: 'video', body: undefined });
    await run(
      migrator,
      `CREATE type::record('storyFile', $video) CONTENT {
         story: story:ann_video, person: user:ann, format: 'video', contentType: 'video/mp4',
         sizeBytes: 1000, storyVersion: 1, at: time::now() - 1d,
         thumbnailPath: $video + '/thumbnail.jpg' };
       CREATE type::record('storyFile', $picture) CONTENT {
         story: story:ann_video, person: user:ann, format: 'image', contentType: 'image/webp',
         sizeBytes: 1000, storyVersion: 1, width: 900, height: 1200, at: time::now() - 1d };
       UPDATE story:ann_video SET mediaFile = type::record('storyFile', $video),
         image = { file: type::record('storyFile', $picture), alt: 'A sunrise' };`,
      { video: VIDEO, picture: PICTURE },
    );
    await processed(workflow, 'ann_video');
    await submit(ann, 'ann_video');

    // Bob's is sent back with a note and sent again: it goes to the back of the queue.
    await step(admin, 'bob_pending', 'changesRequested', { comment: NOTE });
    await submit(bob, 'bob_pending');

    // Sent, then taken down by its owner to edit (ED-4): no longer waiting.
    await draft(ann, 'ann_editing');
    await submit(ann, 'ann_editing');
    await edit(ann, 'ann_editing');

    // MD-3/MD-4: a waiting story about Doubt (the theme filter), a rejected one, and one a
    // moderator took down.
    await draft(ann, 'ann_doubt', {
      themeRefs: [new StringRecordId('theme:doubt')],
    });
    await submit(ann, 'ann_doubt');
    await draft(bob, 'bob_rejected');
    await submit(bob, 'bob_rejected');
    await step(admin, 'bob_rejected', 'rejected', { comment: NOTE });
    await draft(bob, 'bob_hidden');
    await submit(bob, 'bob_hidden');
    await approve(admin, 'bob_hidden');
    await step(admin, 'bob_hidden', 'hiddenByModerator', { comment: NOTE });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_admin'))
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
      .overrideProvider(MediaUrls)
      .useValue(
        new MediaUrls({
          config: {
            streamLibraryId: '123456',
            streamCdnHost: 'vz-test.b-cdn.net',
            imagesCdnHost: 'images-test.b-cdn.net',
            streamTokenKeySecret: 'bunny-stream-token-key',
            imagesTokenKeySecret: 'bunny-images-token-key',
          },
          streamKey: 'stream-key',
          imagesKey: 'images-key',
        }),
      )
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    useBodyParser(app); // as main.ts
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('the list opens on waiting stories, oldest sent first, page by page', async () => {
    const expected = ['ann_pending', 'ann_video', 'bob_pending', 'ann_doubt'];
    expect(await list('', 1)).toEqual(expected);
    expect(await list('state=pending')).toEqual(expected);
    const page = await get('/v1/moderation/stories');
    expect(page.body.data[1]).toMatchObject({
      id: 'ann_video',
      state: 'pending',
      action: 'sent',
      title: 'Story ann_video',
      primaryFormat: 'video',
      themes: [{ id: 'common', name: 'Common' }],
    });
    expect(page.body.data[1].since).toBe(page.body.data[1].sentAt);
    // Unchanged since: 304.
    const again = await get('/v1/moderation/stories', {
      headers: { 'if-none-match': page.etag ?? '' },
    });
    expect(again.status).toBe(304);
    for (const bad of [
      'cursor=forged',
      'state=approved',
      'state=nonsense',
      'theme=no%20spaces',
      'limit=0',
    ]) {
      expect((await get(`/v1/moderation/stories?${bad}`)).status, bad).toBe(
        400,
      );
    }
    // Times Date.parse takes but the database won't cast: a 400, never a 500 (Codex #210).
    for (const at of ['0', '2026-02-31T00:00:00Z', '2026-01-01T24:00:00Z']) {
      const cursor = Buffer.from(JSON.stringify([at, 'entry'])).toString(
        'base64url',
      );
      expect(
        (await get(`/v1/moderation/stories?cursor=${cursor}`)).status,
        at,
      ).toBe(400);
    }
  });

  it('moderators see each state that isn’t public, with what put it there; a theme narrows it', async () => {
    const rows = async (query: string) =>
      (await get(`/v1/moderation/stories?${query}`)).body.data.map(
        (r: { id: string; state: string; action: string | null }) => [
          r.id,
          r.state,
          r.action,
        ],
      );
    expect(await rows('state=editing')).toEqual([
      ['ann_editing', 'editing', 'editStarted'],
    ]);
    expect(await rows('state=hidden')).toEqual([
      ['bob_hidden', 'hidden', 'hiddenByModerator'],
    ]);
    expect(await rows('state=rejected')).toEqual([
      ['bob_rejected', 'rejected', 'rejected'],
    ]);
    expect(await list('state=pending&theme=doubt')).toEqual(['ann_doubt']);
    expect(await list('state=pending&theme=common')).toEqual([
      'ann_pending',
      'ann_video',
      'bob_pending',
    ]);
    expect(await list('state=editing&theme=doubt')).toEqual([]);
  });

  // MD-3: "admins can also see never sent drafts too".
  it('only an Admin sees drafts never sent, on the list and on their review page', async () => {
    const refused = await get('/v1/moderation/stories?state=draft');
    expect([refused.status, refused.body.code]).toEqual([403, 'role_required']);
    expect((await get('/v1/moderation/stories/ann_draft')).status).toBe(404);

    expect(await list('state=draft', 1, 'Admin')).toEqual([
      'ann_draft',
      'bob_draft',
    ]);
    const page = await get('/v1/moderation/stories?state=draft', {
      role: 'Admin',
    });
    expect(page.body.data[0]).toMatchObject({
      id: 'ann_draft',
      state: 'draft',
      action: null,
      sentAt: null,
    });
    const opened = await get('/v1/moderation/stories/ann_draft', {
      role: 'Admin',
    });
    expect([
      opened.status,
      opened.body.status,
      opened.body.submittedAt,
    ]).toEqual([200, 'editing', null]);
  });

  it('a story under review: its words, picture and a one-hour player link, and its history with moderators’ notes', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { status, body } = await get('/v1/moderation/stories/ann_video');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: 'ann_video',
      status: 'pending',
      title: 'Story ann_video',
      primaryFormat: 'video',
      themes: [{ id: 'common', name: 'Common' }],
      statusLog: [
        { action: 'sent', status: 'pending', actor: 'person', comment: null },
      ],
    });
    const [media] = body.media;
    expect(media).toMatchObject({
      format: 'video',
      width: 1080,
      height: 1920,
      durationSeconds: 60,
      processing: 'ready',
    });
    expect(media.playbackUrl).toMatch(
      new RegExp(
        `^https://player\\.mediadelivery\\.net/embed/123456/${VIDEO}\\?token=`,
      ),
    );
    const expires = Number(
      new URL(media.playbackUrl).searchParams.get('expires'),
    );
    expect(expires - before).toBeGreaterThanOrEqual(3600);
    expect(expires - before).toBeLessThanOrEqual(3600 + 60);
    expect(media.thumbnailUrl).toContain(
      `https://vz-test.b-cdn.net/${VIDEO}/thumbnail.jpg?token=HS256-`,
    );
    expect(body.image).toMatchObject({
      width: 900,
      height: 1200,
      alt: 'A sunrise',
    });
    expect(body.image.url).toContain(
      `https://images-test.b-cdn.net/${PICTURE}?token=HS256-`,
    );

    // Sent back and sent again: the moderator's note is in its history, never who wrote it.
    const revised = await get('/v1/moderation/stories/bob_pending');
    expect(
      revised.body.statusLog.map(
        (e: {
          action: string;
          status: string;
          actor: string;
          comment: string | null;
        }) => [e.action, e.status, e.actor, e.comment],
      ),
    ).toEqual([
      ['sent', 'pending', 'person', null],
      ['changesRequested', 'editing', 'moderator', NOTE],
      ['sent', 'pending', 'person', null],
    ]);
    expect(revised.body.submittedAt).toBe(revised.body.statusLog[2].at);
    expect(JSON.stringify(revised.body)).not.toMatch(/user_|submitter|"by"/);
  });

  it('every state the list shows opens, and a published story (MD-1: Take down from its page)', async () => {
    for (const [id, status] of [
      ['bob_live', 'approved'],
      ['ann_editing', 'editing'],
      ['bob_rejected', 'rejected'],
      ['bob_hidden', 'hidden'],
    ]) {
      const opened = await get(`/v1/moderation/stories/${id}`);
      expect([opened.status, opened.body.status], id).toEqual([200, status]);
    }
    expect((await get('/v1/moderation/stories/no_such_story')).status).toBe(
      404,
    );
  });

  it('shows an Admin, never a Moderator, the IP address a story was sent from while it is under 30 days old (block list, G21 D)', async () => {
    await draft(ann, 'ann_ip');
    await run(
      ann,
      `CREATE storyStatusLog CONTENT { story: story:ann_ip, action: 'sent', senderIp: '203.0.113.7' }`,
    );
    await draft(ann, 'ann_ip_old');
    await run(
      migrator,
      `CREATE storyStatusLog CONTENT { story: story:ann_ip_old, action: 'sent', actor: 'person',
         at: time::now() - 31d, senderIp: '203.0.113.8' }`,
    );
    const asAdmin = { role: 'Admin', sub: 'user_mod' };
    expect(
      (await get('/v1/moderation/stories/ann_ip', asAdmin)).body.senderIp,
    ).toBe('203.0.113.7');
    expect((await get('/v1/moderation/stories/ann_ip')).body.senderIp).toBe(
      null,
    );
    expect(
      (await get('/v1/moderation/stories/ann_ip_old', asAdmin)).body.senderIp,
    ).toBe(null);
    // Stories sent before addresses were kept have none.
    expect(
      (await get('/v1/moderation/stories/ann_video', asAdmin)).body.senderIp,
    ).toBe(null);
  });

  // M3 plan concern C2: the role check is the only thing between a User and these routes.
  it('a User is refused on both routes', async () => {
    for (const path of [
      '/v1/moderation/stories',
      '/v1/moderation/stories/ann_video',
    ]) {
      const refused = await get(path, { role: 'User', sub: 'user_ann' });
      expect([refused.status, refused.body.code], path).toEqual([
        403,
        'role_required',
      ]);
    }
  });
});

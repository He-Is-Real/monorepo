import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import { StringRecordId } from 'surrealdb';
import {
  approve,
  loadApproval,
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
  let bob: Awaited<ReturnType<typeof buildWorld>>['bob'];
  let admin: Awaited<ReturnType<typeof buildWorld>>['admin'];
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
    ({ admin, bob, ann } = world);
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
         image = { file: type::record('storyFile', $picture) };`,
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
      const cursor = Buffer.from(
        JSON.stringify(['oldest', at, 'entry']),
      ).toString('base64url');
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

  // MQ-1 E (Joel, 2026-11-17): search, three sorts, and the counts on the tabs and formats; the
  // revised OQ-2 (Joel, 2026-11-19): one format and one theme, filtered as browse filters them.
  describe('filters, sorts and counts (MQ-1 E)', () => {
    const ids = async (query: string, role = 'Moderator') =>
      (await get(`/v1/moderation/stories?${query}`, { role })).body.data.map(
        (s: { id: string }) => s.id,
      );

    beforeAll(async () => {
      // Waiting: Ann's about Doubt and the common theme, with capitals in its title.
      await draft(ann, 'ann_both', {
        title: 'Hope in the HOSPITAL',
        themeRefs: [
          new StringRecordId('theme:doubt'),
          new StringRecordId('theme:common'),
        ],
      });
      await submit(ann, 'ann_both');
      // When each waiting story last changed (only the migrator can set it): two at once.
      await run(
        migrator,
        `UPDATE story:ann_pending SET updatedAt = d'2030-01-05T00:00:00Z';
         UPDATE story:ann_video SET updatedAt = d'2030-01-01T00:00:00Z';
         UPDATE story:bob_pending SET updatedAt = d'2030-01-03T00:00:00Z';
         UPDATE story:ann_doubt SET updatedAt = d'2030-01-03T00:00:00Z';
         UPDATE story:ann_both SET updatedAt = d'2030-01-02T00:00:00Z';`,
      );
    });

    it('a title search ignores capitals and spaces around it', async () => {
      expect(await ids('q=hospital')).toEqual(['ann_both']);
      expect(await ids('q=%20%20Hospital%20')).toEqual(['ann_both']);
      expect(await ids('q=STORY%20ANN')).toEqual([
        'ann_pending',
        'ann_video',
        'ann_doubt',
      ]);
      expect(await ids('q=nothing%20like%20it')).toEqual([]);
    });

    it('one format and one theme, as browse: with the search, each must pass', async () => {
      expect(await ids('format=video')).toEqual(['ann_video']);
      expect(await ids('format=written')).toEqual([
        'ann_pending',
        'bob_pending',
        'ann_doubt',
        'ann_both',
      ]);
      expect(await ids('format=audio')).toEqual([]);
      expect(await ids('theme=doubt')).toEqual(['ann_doubt', 'ann_both']);
      // As browse (themes plan v3, A8): an id that isn't a theme filters nothing.
      expect(await ids('theme=no_such_theme')).toEqual(await ids(''));
      expect(await ids('theme=common&format=video')).toEqual(['ann_video']);
      expect(await ids('theme=doubt&q=story')).toEqual(['ann_doubt']);
      expect(await ids('theme=doubt&format=video')).toEqual([]);
    });

    it('sorts oldest (the default) or newest by when it entered its state, or by when it last changed', async () => {
      const oldest = [
        'ann_pending',
        'ann_video',
        'bob_pending',
        'ann_doubt',
        'ann_both',
      ];
      expect(await ids('sort=oldest')).toEqual(oldest);
      expect(await ids('sort=newest')).toEqual([...oldest].reverse());
      const changed = await ids('sort=changed');
      expect(changed[0]).toBe('ann_pending');
      expect(new Set(changed.slice(1, 3))).toEqual(
        new Set(['bob_pending', 'ann_doubt']),
      );
      expect(changed.slice(3)).toEqual(['ann_both', 'ann_video']);
      // Each page carries its sort's time: the rows come newest changed first.
      const page = (await get('/v1/moderation/stories?sort=changed')).body;
      const times = page.data.map((s: { updatedAt: string }) => s.updatedAt);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('pages through every sort, filtered or not, one row at a time with no repeats or gaps', async () => {
      for (const sort of ['oldest', 'newest', 'changed']) {
        for (const query of [
          `sort=${sort}`,
          `sort=${sort}&format=written`,
          `sort=${sort}&theme=common`,
        ]) {
          expect(await list(query, 1), query).toEqual(await list(query));
        }
        const drafts = `state=draft&sort=${sort}`;
        expect(await list(drafts, 1, 'Admin'), drafts).toEqual(
          await list(drafts, 50, 'Admin'),
        );
      }
      // A cursor pages only the sort it came from.
      const first = await get('/v1/moderation/stories?sort=newest&limit=1');
      const elsewhere = await get(
        `/v1/moderation/stories?sort=changed&cursor=${first.body.nextCursor}`,
      );
      expect(elsewhere.status).toBe(400);
    });

    it('counts each state whatever the filters, and this state’s formats with the search and theme but not the format', async () => {
      const counted = async (query: string, role = 'Moderator') =>
        (await get(`/v1/moderation/stories?${query}`, { role })).body.counts;
      const everyState = {
        pending: (await list('state=pending')).length,
        editing: (await list('state=editing')).length,
        hidden: (await list('state=hidden')).length,
        rejected: (await list('state=rejected')).length,
      };
      expect(everyState.pending).toBe(5);
      // A Moderator never gets the drafts' count; an Admin does.
      expect(await counted('')).toEqual({
        states: everyState,
        formats: { video: 1, audio: 0, written: 4 },
      });
      expect(
        (await counted('q=hospital&format=video&theme=doubt')).states,
      ).toEqual(everyState);
      expect((await counted('', 'Admin')).states).toEqual({
        ...everyState,
        draft: (await list('state=draft', 50, 'Admin')).length,
      });
      // Formats: the search and theme narrow them; the format filter doesn't.
      expect((await counted('format=video')).formats).toEqual({
        video: 1,
        audio: 0,
        written: 4,
      });
      expect((await counted('theme=doubt&format=video')).formats).toEqual({
        video: 0,
        audio: 0,
        written: 2,
      });
      expect((await counted('q=story%20ann')).formats).toEqual({
        video: 1,
        audio: 0,
        written: 2,
      });
      expect((await counted('state=rejected')).formats).toEqual({
        video: 0,
        audio: 0,
        written: 1,
      });
    });

    it('a changed count changes the ETag, even when the page’s rows don’t', async () => {
      const before = await get('/v1/moderation/stories?state=rejected');
      expect(
        (
          await get('/v1/moderation/stories?state=rejected', {
            headers: { 'if-none-match': before.etag ?? '' },
          })
        ).status,
      ).toBe(304);
      await draft(bob, 'bob_counted');
      await submit(bob, 'bob_counted');
      const after = await get('/v1/moderation/stories?state=rejected', {
        headers: { 'if-none-match': before.etag ?? '' },
      });
      expect(after.status).toBe(200);
      expect(after.body.data).toEqual(before.body.data);
      expect(after.body.counts.states.pending).toBe(
        before.body.counts.states.pending + 1,
      );
      // Back as it was for the tests after this one.
      await step(admin, 'bob_counted', 'rejected', { comment: NOTE });
    });

    it('refuses values it doesn’t take: 400', async () => {
      for (const bad of [
        'q=',
        'q=%20%20',
        `q=${'a'.repeat(101)}`,
        'q=a&q=b',
        'format=film',
        // One format and one theme at a time, as browse.
        'format=video&format=audio',
        'theme=doubt&theme=common',
        'theme=no%20spaces',
        `theme=${'t'.repeat(41)}`,
        'sort=random',
        'sort=oldest&sort=newest',
        'state=pending&state=editing',
      ]) {
        const refused = await get(`/v1/moderation/stories?${bad}`);
        expect([refused.status, refused.body.code], bad).toEqual([
          400,
          'validation_failed',
        ]);
      }
      // 100 characters, and a 40-character theme id, are fine.
      expect(
        (await get(`/v1/moderation/stories?q=${'a'.repeat(100)}`)).status,
      ).toBe(200);
      expect(
        (await get(`/v1/moderation/stories?theme=${'t'.repeat(40)}`)).status,
      ).toBe(200);
      // Drafts stay an Admin's, filtered or not.
      expect(
        (await get('/v1/moderation/stories?state=draft&sort=newest')).status,
      ).toBe(403);
    });
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

  it('shows an Admin, never a Moderator, the email a story was sent with, kept as long as the story, and whether it and the address are blocked (EM-1 B, EM-2)', async () => {
    await draft(ann, 'ann_em');
    await run(
      ann,
      `CREATE storyStatusLog CONTENT { story: story:ann_em, action: 'sent',
         senderIp: '203.0.113.9', senderEmail: 'ann@example.com' }`,
    );
    await draft(ann, 'ann_em_old');
    await run(
      migrator,
      `CREATE storyStatusLog CONTENT { story: story:ann_em_old, action: 'sent', actor: 'person',
         at: time::now() - 31d, senderIp: '203.0.113.10', senderEmail: 'ann@example.com' }`,
    );
    const asAdmin = { role: 'Admin', sub: 'user_mod' };
    const sender = async (id: string, who = {}) => {
      const { senderIp, senderIpBlocked, senderEmail, senderEmailBlocked } = (
        await get(`/v1/moderation/stories/${id}`, who)
      ).body;
      return { senderIp, senderIpBlocked, senderEmail, senderEmailBlocked };
    };
    expect(await sender('ann_em', asAdmin)).toEqual({
      senderIp: '203.0.113.9',
      senderIpBlocked: false,
      senderEmail: 'ann@example.com',
      senderEmailBlocked: false,
    });
    // After 30 days the address is gone, the email stays.
    expect(await sender('ann_em_old', asAdmin)).toEqual({
      senderIp: null,
      senderIpBlocked: null,
      senderEmail: 'ann@example.com',
      senderEmailBlocked: false,
    });
    const nothing = {
      senderIp: null,
      senderIpBlocked: null,
      senderEmail: null,
      senderEmailBlocked: null,
    };
    expect(await sender('ann_em')).toEqual(nothing);
    await run(
      await t.service('api_admin'),
      `CREATE blockedEmail:⟨ann@example.com⟩ CONTENT { email: 'ann@example.com', addedBy: 'joel@heisreal.today' };
       CREATE blockedIp:⟨203.0.113.9⟩ CONTENT { ip: '203.0.113.9', addedBy: 'joel@heisreal.today' };`,
    );
    try {
      expect(await sender('ann_em', asAdmin)).toEqual({
        senderIp: '203.0.113.9',
        senderIpBlocked: true,
        senderEmail: 'ann@example.com',
        senderEmailBlocked: true,
      });
      expect(await sender('ann_em')).toEqual(nothing);
    } finally {
      await run(migrator, 'DELETE blockedEmail; DELETE blockedIp;');
    }
  });

  // Part 1a (Joel, 2026-11-10; P1-5, P1-9, 2026-11-14): a waiting story, or one the site took
  // off itself, whose file's check gave up on our side after the nightly housekeeping's 3 new
  // checks, says so in the list; every other says nothing.
  it('the list marks a story whose media check keeps giving up on our side: "a problem on our side"', async () => {
    const migrator = await t.migrator();
    const problem = async (state = 'pending') =>
      Object.fromEntries(
        (await get(`/v1/moderation/stories?state=${state}`)).body.data.map(
          (s: { id: string; mediaProblem: string | null }) => [
            s.id,
            s.mediaProblem,
          ],
        ),
      );
    const giveUp = () =>
      run(
        migrator,
        `CREATE mediaJob CONTENT { file: type::record('storyFile', $video), kind: 'check',
           reasons: ['resent'], outcome: 'gave_up', doneAt: time::now(),
           errorType: 'worker_error' }`,
        { video: VIDEO },
      );
    /** The rows marked "a problem on our side". */
    const ours = async (state = 'pending') =>
      Object.entries(await problem(state))
        .filter(([, p]) => p !== null)
        .map(([id, p]) => [id, p]);
    expect(Object.keys(await problem())).toContain('ann_video');
    expect(await ours()).toEqual([]);
    // The first give-up (the check its sending opened) and the housekeeping's three nights.
    await run(
      migrator,
      `UPDATE mediaJob SET outcome = 'gave_up', doneAt = time::now(), errorType = 'bunny_unavailable'
         WHERE file = type::record('storyFile', $video) AND doneAt = NONE`,
      { video: VIDEO },
    );
    expect(await ours()).toEqual([]);
    for (let n = 2; n <= 3; n++) {
      await giveUp();
      expect(await ours()).toEqual([]);
    }
    await giveUp();
    expect(await ours()).toEqual([['ann_video', 'ours']]);

    // Published, then taken off by the site itself (its file is being processed again): still
    // ours; one a moderator took down never says so.
    await loadApproval(migrator, 'ann_video');
    await run(
      migrator,
      `UPDATE type::record('storyFile', $video) SET processing = 'processing'`,
      { video: VIDEO },
    );
    expect(Object.keys(await problem('hidden'))).toContain('bob_hidden');
    expect(await ours('hidden')).toEqual([['ann_video', 'ours']]);
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

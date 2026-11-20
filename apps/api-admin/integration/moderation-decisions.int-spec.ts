import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  buildWorld,
  createPeople,
  draft,
  edit,
  grantImage,
  processed,
  rows,
  run,
  statusOf,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import { MediaUrls } from '@heisreal/story-cards';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
} from '@heisreal/story-cards/bunny-stream';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';
import {
  PICTURE_CHECK_MS,
  STORY_FOLDERS,
} from '../src/app/moderation/story-media';
import { STORY_MEDIA_BUDGET_MS } from '@heisreal/story-cards/story-media';

/**
 * Bunny, in memory (DEL-1): records what an Admin's Delete removes at Bunny Stream and in the
 * images zone, fails every call while `down`, as Bunny would in an outage, or never answers
 * while `stalled`.
 */
const NEVER = new Promise<never>(() => undefined);
class FakeBunny implements BunnyStream {
  down = false;
  stalled = false;
  readonly videos: string[] = [];
  readonly folders: string[] = [];
  /** The thumbnail file Bunny names for each video it has (RE-2 B's approval check). */
  readonly pictures = new Map<string, string>();
  readonly looked: string[] = [];
  async createVideo(): Promise<string> {
    throw new Error('api-admin never creates videos');
  }
  async video(id: string) {
    this.looked.push(id);
    if (this.stalled) return NEVER;
    if (this.down) throw new Error('Bunny Stream get answered 503');
    const name = this.pictures.get(id);
    return name === undefined
      ? null
      : { status: 4, length: 60, mp4Height: 1080, thumbnailFileName: name };
  }
  async deleteVideo(id: string) {
    if (this.stalled) return NEVER;
    if (this.down) throw new Error('Bunny Stream delete answered 503');
    this.videos.push(id);
  }
  sign(videoId: string, now?: number) {
    return signUpload('42', 'library-key', videoId, now);
  }
  async setThumbnail(): Promise<void> {
    throw new Error('No video’s picture is set in these tests');
  }
  readonly zone = {
    deleteFolder: async (folder: string) => {
      if (this.stalled) return NEVER;
      if (this.down) throw new Error('The images zone answered 503');
      this.folders.push(folder);
    },
  };
}

const NOTE =
  'Thank you for sharing this. Could you tell us a little more about that winter?';

/**
 * M3 plan PR 6: the moderators' decisions through api-admin's real AppModule on its own login,
 * against the real database rules: approve, send back and reject from pending, hide and show
 * again (G5), overturning a rejection or a take-down (OV-1 C, OV-2 A), the first decision wins (D-1), decisions name what was reviewed (G14 B), and only an
 * Admin approves anyway, never during the upload-link hour (G11 B, G24), or deletes (P1-11). Every answer is checked
 * against api-admin.yaml.
 */
describe('moderation, the decisions (api-admin)', () => {
  const contract = new Contract('api-admin.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let app: NestExpressApplication;
  let url: string;
  let migrator: Surreal;
  let ann: Surreal;
  let admin: Surreal;
  let n = 0;
  const bunny = new FakeBunny();

  const MOD = { role: 'Moderator', sub: 'user_mod' };
  const ADMIN = { role: 'Admin', sub: 'user_boss' };

  async function call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    {
      who = MOD,
      body,
      ifMatch,
    }: {
      who?: { role: string; sub: string };
      body?: unknown;
      ifMatch?: string;
    } = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${clerk.token(who.sub, { role: who.role })}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      etag: res.headers.get('etag'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }

  /** The review page's view of the story, and the tag its decisions name. */
  const open = async (id: string, who = MOD) => {
    const page = await call('GET', `/v1/moderation/stories/${id}`, { who });
    expect(page.status, id).toBe(200);
    return { story: page.body, tag: `"${page.body.reviewTag}"` };
  };

  const decide = (
    id: string,
    what:
      | 'approve'
      | 'request-changes'
      | 'reject'
      | 'hide'
      | 'show'
      | 'return-to-queue',
    tag: string,
    body?: unknown,
    who = MOD,
  ) =>
    call('POST', `/v1/moderation/stories/${id}/${what}`, {
      who,
      body,
      ifMatch: tag,
    });

  /** Ann's written story, sent for review. */
  const waiting = async () => {
    const id = `dec_${++n}`;
    await draft(ann, id);
    await submit(ann, id);
    return id;
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    ({ ann, admin } = await buildWorld(t));
    await createPeople(t, { boss: 'user_boss' });
    migrator = await t.migrator();

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
      .useValue(new MediaUrls(null))
      .overrideProvider(BUNNY_STREAM)
      .useValue(bunny)
      .overrideProvider(STORY_FOLDERS)
      .useValue(bunny.zone)
      // A short wait for Bunny, so the stalled-Bunny case is quick (8 s in the service).
      .overrideProvider(STORY_MEDIA_BUDGET_MS)
      .useValue(300)
      .overrideProvider(PICTURE_CHECK_MS)
      .useValue(300)
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

  it('approve publishes it, named as the moderator; the page then offers to hide it', async () => {
    const id = await waiting();
    const { story, tag } = await open(id);
    expect(story.status).toBe('pending');
    const approved = await decide(id, 'approve', tag);
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ id, version: expect.any(Number) });
    expect(await statusOf(migrator, id)).toBe('approved');
    expect(
      await rows(
        migrator,
        `SELECT VALUE [actor, record::id(by)] FROM storyStatusLog
           WHERE story = type::record('story', $id) AND action = 'approved'`,
        { id },
      ),
    ).toEqual([['moderator', 'moderator']]); // user_mod's own user record
    // Published stories open too (G5), with the approval in their history.
    const after = await open(id);
    expect(after.story.status).toBe('approved');
    expect(
      after.story.statusLog.map((e: { action: string }) => e.action),
    ).toEqual(['sent', 'approved']);
    // The answer's ETag is what the next decision names.
    expect(approved.etag).toBe(after.tag);
  });

  it('send back and reject need a note of 1–2000 characters, which the person reads', async () => {
    const back = await waiting();
    const { tag } = await open(back);
    for (const body of [
      undefined,
      {},
      { feedbackToSubmitter: '   ' },
      { feedbackToSubmitter: 'x'.repeat(2001) },
    ]) {
      const refused = await decide(back, 'request-changes', tag, body);
      expect([refused.status, refused.body.code]).toEqual([
        400,
        'validation_failed',
      ]);
      expect(refused.body.errors[0].pointer).toBe('/feedbackToSubmitter');
    }
    expect(await statusOf(migrator, back)).toBe('pending');
    expect(
      (
        await decide(back, 'request-changes', tag, {
          feedbackToSubmitter: `  ${NOTE}  `,
        })
      ).status,
    ).toBe(200);
    expect(await statusOf(migrator, back)).toBe('editing');
    // The person reads the note, trimmed; moderators still open it (MD-4), with nothing to decide.
    expect(
      await rows(
        ann,
        `SELECT VALUE currentStatus.comment FROM type::record('story', $id)`,
        { id: back },
      ),
    ).toEqual([NOTE]);
    const sentBack = await call('GET', `/v1/moderation/stories/${back}`);
    expect([sentBack.status, sentBack.body.status]).toEqual([200, 'editing']);

    const no = await waiting();
    const opened = await open(no);
    expect(
      (
        await decide(no, 'reject', opened.tag, {
          feedbackToSubmitter: 'x'.repeat(2000),
        })
      ).status,
    ).toBe(200);
    expect(await statusOf(migrator, no)).toBe('rejected');
  });

  it('the first decision wins (D-1): the second moderator is told another has decided', async () => {
    const id = await waiting();
    const { tag } = await open(id);
    const other = { role: 'Moderator', sub: 'user_boss' };
    const [a, b] = await Promise.all([
      decide(id, 'approve', tag),
      decide(id, 'reject', tag, { feedbackToSubmitter: NOTE }, other),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.code).toBe(
      'already_decided',
    );
    // One decision only.
    expect(
      await rows(
        migrator,
        `SELECT VALUE action FROM storyStatusLog WHERE story = type::record('story', $id)
           AND actor = 'moderator'`,
        { id },
      ),
    ).toHaveLength(1);
    // Later, with the page still open: the same.
    expect((await decide(id, 'approve', tag)).body.code).toBe(
      'already_decided',
    );
  });

  it('decisions name what was reviewed (G14 B): a story that changed since is refused, a forged or missing tag too', async () => {
    const id = await waiting();
    const { tag } = await open(id);
    // Background work changing the version alone changes nothing reviewed.
    await run(migrator, `UPDATE type::record('story', $id) SET version += 1`, {
      id,
    });
    const same = await open(id);
    expect(same.tag).toBe(tag);
    // The person takes it down to edit and sends it again: a new entry.
    await edit(ann, id);
    await submit(ann, id);
    const stale = await decide(id, 'approve', tag);
    expect([stale.status, stale.body.code]).toEqual([412, 'stale_version']);
    expect((await decide(id, 'approve', '"forged"')).status).toBe(412);
    const missing = await call('POST', `/v1/moderation/stories/${id}/approve`);
    expect([missing.status, missing.body.code]).toEqual([
      428,
      'if_match_required',
    ]);
    expect(await statusOf(migrator, id)).toBe('pending');
    // A story that's gone.
    expect((await decide('no_such_story', 'approve', tag)).status).toBe(404);
  });

  it('hide needs a reason and takes the story down until a moderator shows it again (G5)', async () => {
    const id = await waiting();
    expect((await decide(id, 'approve', (await open(id)).tag)).status).toBe(
      200,
    );
    const live = await open(id);
    const refused = await decide(id, 'hide', live.tag, { reason: '' });
    expect([refused.status, refused.body.errors[0].pointer]).toEqual([
      400,
      '/reason',
    ]);
    // Nothing else from approved: approving again is refused.
    expect((await decide(id, 'approve', live.tag)).body.code).toBe(
      'wrong_status',
    );
    expect(
      (
        await decide(id, 'hide', live.tag, {
          reason: 'A third party is named; checking with them first.',
        })
      ).status,
    ).toBe(200);
    expect(await statusOf(migrator, id)).toBe('hidden');
    expect(
      await rows(
        await t.service('api_public_read'),
        `SELECT id FROM type::record('story', $id)`,
        { id },
      ),
    ).toEqual([]);
    const hidden = await open(id);
    expect(hidden.story.status).toBe('hidden');
    expect((await decide(id, 'show', hidden.tag, {}, ADMIN)).status).toBe(200);
    expect(await statusOf(migrator, id)).toBe('approved');
    // EM-1 (Joel 2026-11-17): the history names the staff member who took each action, by
    // email, to Moderators and Admins alike; the person's own entries name nobody.
    for (const who of [MOD, ADMIN]) {
      expect(
        (await open(id, who)).story.statusLog.map(
          (e: { action: string; staffEmail: string | null }) => [
            e.action,
            e.staffEmail,
          ],
        ),
      ).toEqual([
        ['sent', null],
        ['approved', 'mod@heisreal.today'],
        ['hiddenByModerator', 'mod@heisreal.today'],
        ['shownByModerator', 'boss@heisreal.today'],
      ]);
    }
  });

  it('approve anyway is for Admins, skips only the processing, never the upload-link hour (G11 B, G24)', async () => {
    const id = `dec_${++n}`;
    await draft(ann, id);
    // A picture uploaded just now: its link can be used for 10 minutes.
    const [version] = await rows<number>(
      migrator,
      `SELECT VALUE version FROM type::record('story', $id)`,
      { id },
    );
    const pic = await grantImage(await t.service('api_user'), {
      story: id,
      person: 'ann',
      version,
    });
    expect(pic).toMatchObject({ ok: true });
    await submit(ann, id);
    await processed(await t.service('workflow'), id);
    const { tag } = await open(id);

    const cooldown = await decide(
      id,
      'approve',
      tag,
      { approveAnyway: true },
      ADMIN,
    );
    expect(cooldown.status).toBe(409);
    expect(cooldown.body.code).toBe('media_recently_uploaded');
    const until = Date.parse(cooldown.body.availableAt);
    expect(until).toBeGreaterThan(Date.now() + 8 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);

    // A Moderator may not ask to.
    const moderator = await decide(id, 'approve', tag, { approveAnyway: true });
    expect([moderator.status, moderator.body.code]).toEqual([
      403,
      'role_required',
    ]);
    expect(await statusOf(migrator, id)).toBe('pending');
  });

  /**
   * Ann's video story, sent, its file uploaded a day ago, with the thumbnail file api-user
   * recorded at send (RE-2 B) and Bunny showing that file. Answers the story and video ids.
   */
  const sentVideo = async (
    recorded: string | null = 'thumbnail_1a2b3c4d.jpg',
  ) => {
    const id = `dec_${++n}`;
    const video = randomUUID();
    await draft(ann, id, { primaryFormat: 'video', body: undefined });
    await run(
      migrator,
      `CREATE type::record('storyFile', $video) CONTENT {
         story: type::record('story', $id), person: user:ann, format: 'video',
         contentType: 'video/mp4', sizeBytes: 1000, storyVersion: 1, at: time::now() - 1d,
         thumbnailPath: IF $recorded != NONE { $video + '/' + $recorded } };
       UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $video);`,
      { id, video, recorded: recorded ?? undefined },
    );
    if (recorded) bunny.pictures.set(video, recorded);
    await submit(ann, id);
    return { id, video };
  };

  it('a story whose media is still being processed: a Moderator waits, an Admin approves anyway and the entry says so', async () => {
    const { id, video } = await sentVideo();
    await processed(await t.service('workflow'), id);
    // A check of the video still open (J6), as api-user opens one.
    await run(
      await t.service('api_user'),
      `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', 'submitted')`,
      { video },
    );
    const { tag } = await open(id);
    const waits = await decide(id, 'approve', tag);
    expect([waits.status, waits.body.code]).toEqual([
      409,
      'media_still_processing',
    ]);
    expect(
      (await decide(id, 'approve', tag, { approveAnyway: true }, ADMIN)).status,
    ).toBe(200);
    expect(await statusOf(migrator, id)).toBe('approved');
    expect(
      await rows(
        admin,
        `SELECT VALUE currentStatus.skippedMediaWait FROM type::record('story', $id)`,
        { id },
      ),
    ).toEqual([true]);
  });

  // RE-2 B (Joel, 2026-11-17): a picture can reach Bunny late (a send that timed out, another
  // tab), so approval compares Bunny's thumbnail file with the one recorded at send.
  it('a video story is approved only while Bunny shows the picture recorded at send; approve anyway too', async () => {
    const PICTURE_CHANGED = {
      code: 'picture_changed_at_bunny',
      detail:
        'The picture changed at Bunny. Send it back so the person sends again.',
    };
    // Bunny shows another file: refused, for a Moderator and an Admin approving anyway alike.
    const late = await sentVideo();
    await processed(await t.service('workflow'), late.id);
    bunny.pictures.set(late.video, 'thumbnail_0badf00d.jpg');
    const lateTag = (await open(late.id)).tag;
    const refused = await decide(late.id, 'approve', lateTag);
    expect([refused.status, refused.body]).toEqual([
      409,
      expect.objectContaining(PICTURE_CHANGED),
    ]);
    const anyway = await decide(
      late.id,
      'approve',
      lateTag,
      { approveAnyway: true },
      ADMIN,
    );
    expect([anyway.status, anyway.body]).toEqual([
      409,
      expect.objectContaining(PICTURE_CHANGED),
    ]);
    expect(await statusOf(migrator, late.id)).toBe('pending');
    // Sending it back still works, so the person sends again.
    expect(
      (
        await decide(late.id, 'request-changes', lateTag, {
          feedbackToSubmitter: NOTE,
        })
      ).status,
    ).toBe(200);

    // Nothing recorded at send: refused the same way.
    const none = await sentVideo(null);
    await processed(await t.service('workflow'), none.id);
    bunny.pictures.set(none.video, 'thumbnail.jpg');
    const noneRefused = await decide(
      none.id,
      'approve',
      (await open(none.id)).tag,
    );
    expect([noneRefused.status, noneRefused.body.code]).toEqual([
      409,
      'picture_changed_at_bunny',
    ]);
    expect(await statusOf(migrator, none.id)).toBe('pending');

    // Bunny down, stalled or without the video: never approved unchecked; the generic answer.
    const ok = await sentVideo();
    await processed(await t.service('workflow'), ok.id);
    const { tag } = await open(ok.id);
    for (const how of ['down', 'stalled', 'gone'] as const) {
      bunny.down = how === 'down';
      bunny.stalled = how === 'stalled';
      if (how === 'gone') bunny.pictures.delete(ok.video);
      const failed = await decide(ok.id, 'approve', tag);
      expect([failed.status, failed.body.code], how).toEqual([
        502,
        'bunny_unavailable',
      ]);
      expect(await statusOf(migrator, ok.id), how).toBe('pending');
    }
    bunny.down = false;
    bunny.stalled = false;
    bunny.pictures.set(ok.video, 'thumbnail_1a2b3c4d.jpg');

    // Bunny shows the recorded file: approved.
    expect((await decide(ok.id, 'approve', tag)).status).toBe(200);
    expect(await statusOf(migrator, ok.id)).toBe('approved');
    expect(bunny.looked).toContain(ok.video);
  });

  // RE-3 A (Joel, 2026-11-17): Show again puts a story back on the site, so it gets approval's
  // picture check at Bunny too.
  it('Show again shows a hidden video story only while Bunny shows the picture recorded at send', async () => {
    const { id, video } = await sentVideo();
    await processed(await t.service('workflow'), id);
    expect((await decide(id, 'approve', (await open(id)).tag)).status).toBe(
      200,
    );
    expect(
      (await decide(id, 'hide', (await open(id)).tag, { reason: NOTE })).status,
    ).toBe(200);
    const { tag } = await open(id);

    // Bunny shows another file: stays hidden, for a Moderator and an Admin showing anyway alike.
    bunny.pictures.set(video, 'thumbnail_0badf00d.jpg');
    for (const [body, who] of [
      [undefined, undefined],
      [{ approveAnyway: true }, ADMIN],
    ] as const) {
      const refused = await decide(id, 'show', tag, body, who);
      expect([refused.status, refused.body]).toEqual([
        409,
        expect.objectContaining({
          code: 'picture_changed_at_bunny',
          detail:
            'The picture changed at Bunny. Send it back so the person sends again.',
        }),
      ]);
      expect(await statusOf(migrator, id)).toBe('hidden');
    }

    // Bunny down: the generic answer, still hidden.
    bunny.pictures.set(video, 'thumbnail_1a2b3c4d.jpg');
    bunny.down = true;
    const failed = await decide(id, 'show', tag);
    bunny.down = false;
    expect([failed.status, failed.body.code]).toEqual([
      502,
      'bunny_unavailable',
    ]);
    expect(await statusOf(migrator, id)).toBe('hidden');

    // Bunny shows the recorded file: back on the site.
    expect((await decide(id, 'show', tag)).status).toBe(200);
    expect(await statusOf(migrator, id)).toBe('approved');
  });

  /** The story's status log, as api-admin's review page lists it. */
  const actions = async (id: string) =>
    (await open(id)).story.statusLog.map((e: { action: string }) => e.action);
  /** When the nightly housekeeping would delete it (G3 B), or null: the database's one rule. */
  const deletesAt = async (id: string) =>
    (
      await rows<string | null>(
        migrator,
        `SELECT VALUE fn::story::deletes_at(id) FROM type::record('story', $id)`,
        { id },
      )
    )[0] ?? null;
  /** The site takes it off itself: its video or audio can't play. */
  const hideBySite = (id: string) =>
    run(
      migrator,
      `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'hiddenBySystem',
         actor: 'system', hiddenReason: 'media_unavailable' }`,
      { id },
    );
  const rejectNow = async (id: string) =>
    expect(
      (
        await decide(id, 'reject', (await open(id)).tag, {
          feedbackToSubmitter: NOTE,
        })
      ).status,
    ).toBe(200);

  it('every taken-down story, whoever took it down, can be rejected or sent back with a note (OV-2 A)', async () => {
    // Taken down by a moderator, then rejected (refused before OV-2 A).
    const hidByMod = await waiting();
    expect(
      (await decide(hidByMod, 'approve', (await open(hidByMod)).tag)).status,
    ).toBe(200);
    expect(
      (
        await decide(hidByMod, 'hide', (await open(hidByMod)).tag, {
          reason: NOTE,
        })
      ).status,
    ).toBe(200);
    await rejectNow(hidByMod);
    expect(await statusOf(migrator, hidByMod)).toBe('rejected');

    // Taken down by the site, then rejected (P1-9, P1-11) or sent back.
    for (const what of ['reject', 'request-changes'] as const) {
      const hidBySite = await waiting();
      expect(
        (await decide(hidBySite, 'approve', (await open(hidBySite)).tag))
          .status,
      ).toBe(200);
      await hideBySite(hidBySite);
      const site = await open(hidBySite);
      expect(site.story.status).toBe('hidden');
      // A note is needed, as from pending.
      expect((await decide(hidBySite, what, site.tag, {})).status).toBe(400);
      expect(
        (await decide(hidBySite, what, site.tag, { feedbackToSubmitter: NOTE }))
          .status,
      ).toBe(200);
      expect(await statusOf(migrator, hidBySite)).toBe(
        what === 'reject' ? 'rejected' : 'editing',
      );
    }

    // Taken down by a moderator, then sent back: the person reads the note and can change it.
    const back = await waiting();
    expect((await decide(back, 'approve', (await open(back)).tag)).status).toBe(
      200,
    );
    expect(
      (await decide(back, 'hide', (await open(back)).tag, { reason: NOTE }))
        .status,
    ).toBe(200);
    const taken = await open(back);
    // Nothing else from hidden: no second take-down, no approval, no return to the queue.
    for (const what of ['hide', 'approve', 'return-to-queue'] as const) {
      const refused = await decide(back, what, taken.tag, { reason: NOTE });
      expect([refused.status, refused.body.code], what).toEqual([
        409,
        'wrong_status',
      ]);
    }
    expect(
      (
        await decide(back, 'request-changes', taken.tag, {
          feedbackToSubmitter: 'Please leave out the surname.',
        })
      ).status,
    ).toBe(200);
    expect(await statusOf(migrator, back)).toBe('editing');
    expect(
      await rows(
        ann,
        `SELECT VALUE currentStatus.comment FROM type::record('story', $id)`,
        { id: back },
      ),
    ).toEqual(['Please leave out the surname.']);
  });

  it('a rejected story can be approved again; one published before keeps its first publication date (OV-1 C, OV-5 A)', async () => {
    // Rejected while waiting: never published, so it is published now.
    const fresh = await waiting();
    await rejectNow(fresh);
    expect(await deletesAt(fresh)).not.toBeNull();
    const rejected = await open(fresh);
    expect(rejected.story.status).toBe('rejected');
    const approved = await decide(fresh, 'approve', rejected.tag, {}, ADMIN);
    expect(approved.status).toBe(200);
    expect(await statusOf(migrator, fresh)).toBe('approved');
    // The rejection's 90-day deletion no longer applies.
    expect(await deletesAt(fresh)).toBeNull();

    // Published, taken down by the site, rejected, then approved again: its first date stands.
    const id = await waiting();
    expect((await decide(id, 'approve', (await open(id)).tag)).status).toBe(
      200,
    );
    const published = async () =>
      rows<string>(
        await t.service('api_public_read'),
        `SELECT VALUE currentStatus.publishedAt FROM type::record('story', $id)`,
        { id },
      );
    const [first] = await published();
    expect(first).toBeDefined();
    await hideBySite(id);
    await rejectNow(id);
    expect(await published()).toEqual([]);
    expect((await decide(id, 'approve', (await open(id)).tag)).status).toBe(
      200,
    );
    expect(await published()).toEqual([first]);
    expect(await actions(id)).toEqual([
      'sent',
      'approved',
      'hiddenBySystem',
      'rejected',
      'approved',
    ]);
  });

  it('approving a rejected story runs approval’s checks: no skipping the upload-link hour', async () => {
    const id = `dec_${++n}`;
    await draft(ann, id);
    // A picture uploaded just now: its link can be used for 10 minutes.
    const pic = await grantImage(await t.service('api_user'), {
      story: id,
      person: 'ann',
      version: await versionOf(id),
    });
    expect(pic).toMatchObject({ ok: true });
    await submit(ann, id);
    await processed(await t.service('workflow'), id);
    await rejectNow(id);
    const { tag } = await open(id);
    for (const body of [{}, { approveAnyway: true }]) {
      const refused = await decide(id, 'approve', tag, body, ADMIN);
      expect([refused.status, refused.body.code]).toEqual([
        409,
        'media_recently_uploaded',
      ]);
    }
    expect(await statusOf(migrator, id)).toBe('rejected');
  });

  it('a rejected story can be sent back with a note, or put back in the waiting list unchanged (OV-1 C, OV-3 A)', async () => {
    const id = await waiting();
    await rejectNow(id);
    const rejected = await open(id);
    // Nothing else from rejected: no take-down, no show again, no second rejection.
    for (const what of ['hide', 'show', 'reject'] as const) {
      const refused = await decide(id, what, rejected.tag, {
        reason: NOTE,
        feedbackToSubmitter: NOTE,
      });
      expect([refused.status, refused.body.code], what).toEqual([
        409,
        'wrong_status',
      ]);
    }
    // Back in the waiting list: no note, its words and files as they were.
    const back = await decide(id, 'return-to-queue', rejected.tag);
    expect(back.status).toBe(200);
    expect(await statusOf(migrator, id)).toBe('pending');
    expect(await deletesAt(id)).toBeNull();
    const waitingAgain = await open(id);
    expect(back.etag).toBe(waitingAgain.tag);
    for (const field of ['title', 'description', 'body', 'themes', 'media'])
      expect(waitingAgain.story[field], field).toEqual(rejected.story[field]);
    expect(
      waitingAgain.story.statusLog.map(
        (e: { action: string; status: string; comment: string | null }) => [
          e.action,
          e.status,
          e.comment,
        ],
      ),
    ).toEqual([
      ['sent', 'pending', null],
      ['rejected', 'rejected', NOTE],
      ['returnedToQueue', 'pending', null],
    ]);
    // It shows on the Waiting for review list again.
    const list = await call('GET', '/v1/moderation/stories?state=pending');
    expect(list.body.data.map((s: { id: string }) => s.id)).toContain(id);
    // Only from rejected.
    const again = await decide(id, 'return-to-queue', waitingAgain.tag);
    expect([again.status, again.body.code]).toEqual([409, 'wrong_status']);

    // Rejected again, then sent back: the person reads the new note and can change it.
    await rejectNow(id);
    const r2 = await open(id);
    expect((await decide(id, 'request-changes', r2.tag, {})).status).toBe(400);
    expect(
      (
        await decide(id, 'request-changes', r2.tag, {
          feedbackToSubmitter: 'Nearly there: please leave out the surname.',
        })
      ).status,
    ).toBe(200);
    expect(await statusOf(migrator, id)).toBe('editing');
    expect(
      await rows(
        ann,
        `SELECT VALUE currentStatus.comment FROM type::record('story', $id)`,
        { id },
      ),
    ).toEqual(['Nearly there: please leave out the surname.']);
    await run(ann, `UPDATE type::record('story', $id) SET title = 'Changed'`, {
      id,
    });
    await submit(ann, id);
    expect(await statusOf(migrator, id)).toBe('pending');
  });

  it('a published story can’t be put back in the waiting list', async () => {
    const id = await waiting();
    expect((await decide(id, 'approve', (await open(id)).tag)).status).toBe(
      200,
    );
    const refused = await decide(id, 'return-to-queue', (await open(id)).tag);
    expect([refused.status, refused.body.code]).toEqual([409, 'wrong_status']);
    expect(await statusOf(migrator, id)).toBe('approved');
  });

  /** Ann's video story with a picture, sent for review: its video's id at Bunny. */
  const videoStory = async () => {
    const id = `dec_${++n}`;
    const video = randomUUID();
    await draft(ann, id, { primaryFormat: 'video', body: undefined });
    await run(
      migrator,
      `CREATE type::record('storyFile', $video) CONTENT {
         story: type::record('story', $id), person: user:ann, format: 'video',
         contentType: 'video/mp4', sizeBytes: 1000, storyVersion: 1, at: time::now() - 1d };
       UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $video);`,
      { id, video },
    );
    const pic = await grantImage(await t.service('api_user'), {
      story: id,
      person: 'ann',
      version: await versionOf(id),
    });
    expect(pic).toMatchObject({ ok: true });
    await submit(ann, id);
    return { id, video };
  };
  const versionOf = async (id: string) =>
    (
      await rows<number>(
        migrator,
        `SELECT VALUE version FROM type::record('story', $id)`,
        { id },
      )
    )[0];
  const remove = (id: string, who = ADMIN) =>
    call('DELETE', `/v1/moderation/stories/${id}`, { who });
  /** The story's picture folder, still queued for housekeeping's final pass. */
  const queuedFolder = (id: string) =>
    rows(migrator, `SELECT VALUE ref FROM pendingDeletion WHERE ref = $ref`, {
      ref: `stories/${id}/`,
    });

  it('an Admin deletes a story as its owner would (P1-11): its log, hearts and search row go, its picture folder at Bunny at once (DEL-1); a Moderator is refused', async () => {
    const id = await waiting();
    expect((await decide(id, 'approve', (await open(id)).tag)).status).toBe(
      200,
    );
    // Bob hearts it.
    await run(
      await t.person('user_bob'),
      `CREATE favourite:ulid() CONTENT { person: $auth, story: type::record('story', $id) }`,
      { id },
    );

    // A Moderator has no Delete (DEL-2 A).
    expect(await remove(id, MOD)).toMatchObject({
      status: 403,
      body: { code: 'role_required' },
    });
    expect(await statusOf(migrator, id)).toBe('approved');

    expect((await remove(id)).status).toBe(204);
    expect(
      await rows(
        migrator,
        `RETURN [
           (SELECT id FROM type::record('story', $id)),
           (SELECT id FROM storyStatusLog WHERE story = type::record('story', $id)),
           (SELECT id FROM favourite WHERE story = type::record('story', $id)),
           (SELECT id FROM type::record('storySearch', $id))
         ]`,
        { id },
      ),
    ).toEqual([[], [], [], []]);
    // Its picture folder goes at Bunny at once (DEL-1) and stays queued for housekeeping's final
    // pass, as for the owner's Delete (a PUT link may still be used).
    expect(bunny.folders).toContain(`stories/${id}/`);
    expect(await queuedFolder(id)).toEqual([`stories/${id}/`]);
    // Already gone.
    expect((await remove(id)).status).toBe(404);
  });

  it('an Admin deletes a story whose words and files changed after the page opened (DEL-3), and a draft never sent', async () => {
    const { id, video } = await videoStory();
    await open(id, ADMIN);
    // Ann presses Edit, changes the words and picks a new picture meanwhile.
    await edit(ann, id);
    await run(
      ann,
      `UPDATE type::record('story', $id) SET title = 'A new title'`,
      {
        id,
      },
    );
    expect(
      await grantImage(await t.service('api_user'), {
        story: id,
        person: 'ann',
        version: await versionOf(id),
        name: 'b'.repeat(32),
        expectedImage: `stories/${id}/${'a'.repeat(32)}.webp`,
      }),
    ).toMatchObject({ ok: true });
    expect((await remove(id)).status).toBe(204);
    expect(
      await rows(migrator, `SELECT id FROM type::record('story', $id)`, { id }),
    ).toEqual([]);
    expect(bunny.videos).toContain(video);
    expect(bunny.folders).toContain(`stories/${id}/`);

    const never = `dec_${++n}`;
    await draft(ann, never);
    await open(never, ADMIN);
    expect((await remove(never)).status).toBe(204);
    expect(
      await rows(migrator, `SELECT id FROM type::record('story', $id)`, {
        id: never,
      }),
    ).toEqual([]);
  });

  it('Bunny down: an Admin’s Delete still succeeds, and the clean-up queue still holds the picture folder', async () => {
    const { id, video } = await videoStory();
    bunny.down = true;
    try {
      expect((await remove(id)).status).toBe(204);
    } finally {
      bunny.down = false;
    }
    expect(
      await rows(migrator, `SELECT id FROM type::record('story', $id)`, { id }),
    ).toEqual([]);
    expect(bunny.videos).not.toContain(video);
    expect(bunny.folders).not.toContain(`stories/${id}/`);
    // Housekeeping deletes the folder from the queue; the video, no story's now, goes in the
    // nightly orphan sweep (its file row stays for the upload limits, D113).
    expect(await queuedFolder(id)).toEqual([`stories/${id}/`]);
    expect(
      await rows(
        migrator,
        `SELECT VALUE [record::id(id), story] FROM type::record('storyFile', $video)`,
        { video },
      ),
    ).toEqual([[video, expect.anything()]]);
  });

  it('Bunny stalled: an Admin’s Delete answers once its wait for Bunny runs out, and the clean-up still has the files', async () => {
    const { id, video } = await videoStory();
    bunny.stalled = true;
    try {
      // Bunny never answers; without the wait's limit this request would never end.
      expect((await remove(id)).status).toBe(204);
    } finally {
      bunny.stalled = false;
    }
    expect(
      await rows(migrator, `SELECT id FROM type::record('story', $id)`, { id }),
    ).toEqual([]);
    expect(await queuedFolder(id)).toEqual([`stories/${id}/`]);
    expect(
      await rows(
        migrator,
        `SELECT VALUE [record::id(id), story] FROM type::record('storyFile', $video)`,
        { video },
      ),
    ).toEqual([[video, expect.anything()]]);
  });

  it('a User is refused on every decision', async () => {
    const id = await waiting();
    const { tag } = await open(id);
    for (const what of [
      'approve',
      'request-changes',
      'reject',
      'hide',
      'show',
      'return-to-queue',
    ] as const) {
      const refused = await decide(
        id,
        what,
        tag,
        { feedbackToSubmitter: NOTE, reason: NOTE },
        { role: 'User', sub: 'user_ann' },
      );
      expect([refused.status, refused.body.code], what).toEqual([
        403,
        'role_required',
      ]);
    }
    expect(await statusOf(migrator, id)).toBe('pending');
  });
});

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
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { useBodyParser } from '../src/app/body-parser';

const NOTE =
  'Thank you for sharing this. Could you tell us a little more about that winter?';

/**
 * M3 plan PR 6: the moderators' decisions through api-admin's real AppModule on its own login,
 * against the real database rules: approve, send back and reject from pending, hide and show
 * again (G5), the first decision wins (D-1), decisions name what was reviewed (G14 B), and only an
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
    what: 'approve' | 'request-changes' | 'reject' | 'hide' | 'show',
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
    expect((await decide(id, 'show', hidden.tag)).status).toBe(200);
    expect(await statusOf(migrator, id)).toBe('approved');
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

  it('a story whose media is still being processed: a Moderator waits, an Admin approves anyway and the entry says so', async () => {
    const id = `dec_${++n}`;
    await draft(ann, id, { primaryFormat: 'video', body: undefined });
    await run(
      migrator,
      `CREATE type::record('storyFile', $id + '-video') CONTENT {
         story: type::record('story', $id), person: user:ann, format: 'video',
         contentType: 'video/mp4', sizeBytes: 1000, storyVersion: 1, at: time::now() - 1d };
       UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $id + '-video');`,
      { id },
    );
    await submit(ann, id);
    await processed(await t.service('workflow'), id);
    // A check of the video still open (J6), as api-user opens one.
    await run(
      await t.service('api_user'),
      `RETURN fn::media::queue_job(type::record('storyFile', $id + '-video'), 'check', 'submitted')`,
      { id },
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

  it('a story the site took off itself can be rejected (P1-9, P1-11); a moderator’s take-down can’t', async () => {
    const hidBySite = await waiting();
    expect(
      (await decide(hidBySite, 'approve', (await open(hidBySite)).tag)).status,
    ).toBe(200);
    // The site takes it off: its video or audio can't play.
    await run(
      migrator,
      `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'hiddenBySystem',
         actor: 'system', hiddenReason: 'media_unavailable' }`,
      { id: hidBySite },
    );
    const site = await open(hidBySite);
    expect(site.story.status).toBe('hidden');
    expect(
      (
        await decide(hidBySite, 'reject', site.tag, {
          feedbackToSubmitter: NOTE,
        })
      ).status,
    ).toBe(200);
    expect(await statusOf(migrator, hidBySite)).toBe('rejected');

    const hidByMod = await waiting();
    expect(
      (await decide(hidByMod, 'approve', (await open(hidByMod)).tag)).status,
    ).toBe(200);
    const live = await open(hidByMod);
    expect(
      (await decide(hidByMod, 'hide', live.tag, { reason: NOTE })).status,
    ).toBe(200);
    const taken = await open(hidByMod);
    const refused = await decide(hidByMod, 'reject', taken.tag, {
      feedbackToSubmitter: NOTE,
    });
    expect([refused.status, refused.body.code]).toEqual([409, 'wrong_status']);
    expect(await statusOf(migrator, hidByMod)).toBe('hidden');
  });

  it('an Admin deletes a story as its owner would (P1-11): its log, hearts and search row go; a Moderator is refused', async () => {
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
    const { tag } = await open(id, ADMIN);
    const remove = (ifMatch?: string, who = ADMIN) =>
      call('DELETE', `/v1/moderation/stories/${id}`, { who, ifMatch });

    // A Moderator has no Delete.
    expect(await remove(tag, MOD)).toMatchObject({
      status: 403,
      body: { code: 'role_required' },
    });
    // It names what the Admin reviewed (G14 B).
    expect((await remove()).status).toBe(428);
    expect((await remove('"forged"')).status).toBe(412);
    expect(await statusOf(migrator, id)).toBe('approved');

    expect((await remove(tag)).status).toBe(204);
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
    // Its picture folder is queued for housekeeping, as for the owner's Delete.
    expect(
      await rows(
        migrator,
        `SELECT VALUE ref FROM pendingDeletion WHERE ref = $ref`,
        { ref: `stories/${id}/` },
      ),
    ).toEqual([`stories/${id}/`]);
    // Already gone.
    expect((await remove(tag)).status).toBe(404);
  });

  it('an Admin deletes a draft never sent; a story that changed since it was opened is refused', async () => {
    const id = `dec_${++n}`;
    await draft(ann, id);
    const opened = await open(id, ADMIN);
    // Ann sends it meanwhile: not what the Admin looked at.
    await submit(ann, id);
    const stale = await call('DELETE', `/v1/moderation/stories/${id}`, {
      who: ADMIN,
      ifMatch: opened.tag,
    });
    expect([stale.status, stale.body.code]).toEqual([412, 'stale_version']);
    expect(await statusOf(migrator, id)).toBe('pending');

    const never = `dec_${++n}`;
    await draft(ann, never);
    const page = await open(never, ADMIN);
    expect(
      (
        await call('DELETE', `/v1/moderation/stories/${never}`, {
          who: ADMIN,
          ifMatch: page.tag,
        })
      ).status,
    ).toBe(204);
    expect(
      await rows(migrator, `SELECT id FROM type::record('story', $id)`, {
        id: never,
      }),
    ).toEqual([]);
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

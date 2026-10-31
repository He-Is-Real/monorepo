import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  approve,
  createPeople,
  draft,
  grantAll,
  grantImage,
  grantUpload,
  publishDpa,
  rows,
  run,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  CLERK_BACKEND,
  type ClerkBackend,
} from '../src/app/erasure/clerk-backend';
import {
  BUNNY_STORAGE,
  BunnyImageStore,
} from '../src/app/stories/bunny-storage';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
} from '../src/app/stories/bunny-stream';

/**
 * Erasure (M2 plan PR 11; D39, D40, D82) through api-user's real AppModule, for its three callers:
 * "Delete my account" (`DELETE /v1/account`), withdrawing the testimony consent (D88) and Clerk's
 * signed `user.deleted` webhook. The database is the behaviour: what goes, what stays, and that a
 * still-valid token can't bring the person back (#44). Bunny Stream and Clerk's Backend API are
 * in-memory stand-ins that record what they were asked to delete, and can be made to fail.
 * Every answer is checked against api-user.yaml.
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

/** The images zone: records the pictures whose story's folder it was asked to delete. */
class FakeImages extends BunnyImageStore {
  readonly deleted: string[] = [];
  override async deleteImage(path: string) {
    this.deleted.push(path);
  }
}

const WEBHOOK_KEY = Buffer.alloc(24, 7);

class FakeClerk implements ClerkBackend {
  readonly deleted: string[] = [];
  failing = false;
  webhooksOn = true;
  async deleteUser(id: string) {
    if (this.failing) throw new Error('Clerk answered 503');
    this.deleted.push(id);
  }
  async webhookKey() {
    return this.webhooksOn ? WEBHOOK_KEY : null;
  }
}

/**
 * api-user's database login, made to fail on demand: `failing` names a piece of SurrealQL whose
 * queries throw (the database half of erasure, or the deletion queue).
 */
function breakable(db: Surreal) {
  const breaks = { failing: null as string | null };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql: string, vars?: Record<string, unknown>) =>
          target.query(
            breaks.failing && sql.includes(breaks.failing)
              ? `THROW 'the database is unavailable'`
              : sql,
            vars,
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, breaks };
}

describe('erasure: delete my account, Art 9 withdrawal and Clerk’s user.deleted', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
  const images = new FakeImages({
    name: 'test-zone',
    password: 'zone-password',
    host: 'uk-s3.storage.bunnycdn.com',
    region: 'uk',
  });
  const clerkApi = new FakeClerk();
  let breaks: { failing: string | null };
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let app: INestApplication;
  let url: string;

  async function call(
    method: string,
    path: string,
    who: string,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${clerk.token(`user_${who}`)}`,
        ...headers,
      },
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }

  /** Clerk's webhook, signed as Svix signs it (or with another key). */
  async function webhook(
    event: unknown,
    { id = `msg_${randomUUID()}`, key = WEBHOOK_KEY } = {},
  ) {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
    const res = await fetch(`${url}/v1/webhooks/clerk`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signature}`,
      },
      body,
    });
    expect(await contract.check('POST', res), 'POST webhook').toEqual([]);
    return res.status;
  }

  /**
   * A person with a published written story, Bob's heart on it, and a video draft with its video
   * and its own thumbnail.
   */
  async function personWithStories(who: string) {
    await createPeople(t, { [who]: `user_${who}` });
    const session = await t.person(`user_${who}`);
    await grantAll(session);
    await run(
      migrator,
      `CREATE type::record('submitterLimits', $who) SET user = type::record('user', $who), trusted = true`,
      { who },
    );
    const live = `${who}_live`;
    await draft(session, live);
    await submit(session, live);
    await approve(admin, live);
    await run(
      await t.person('user_bob'),
      `CREATE favourite CONTENT { person: $auth, story: type::record('story', $id) }`,
      { id: live },
    );
    const video = randomUUID();
    await draft(session, `${who}_video`, {
      primaryFormat: 'video',
      body: undefined,
    });
    expect(
      await grantUpload(apiUser, {
        video,
        story: `${who}_video`,
        person: who,
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    const picture = `stories/${who}_video/${'b'.repeat(32)}.webp`;
    expect(
      await grantImage(apiUser, {
        story: `${who}_video`,
        person: who,
        version: 2,
        path: picture,
      }),
    ).toMatchObject({ ok: true });
    return { video, picture };
  }

  /** What the database still holds of the person. */
  const left = (who: string) =>
    rows(
      migrator,
      `RETURN {
         stories: (SELECT VALUE record::id(id) FROM story WHERE submitter = type::record('user', $who)),
         publicStories: (SELECT VALUE id FROM publicStory WHERE string::starts_with(record::id(id), $who)),
         hearts: (SELECT VALUE id FROM favourite WHERE string::starts_with(record::id(story), $who)),
         grants: (SELECT VALUE id FROM uploadGrant WHERE person = type::record('user', $who)),
         user: (SELECT VALUE [clerkUserId, gdprDeletedAt != NONE] FROM ONLY type::record('user', $who)),
         ledger: count(SELECT id FROM consent WHERE subject = type::record('user', $who)),
         erasedBy: (SELECT VALUE reason FROM auditLog
           WHERE action = 'EraseAccount' AND entity = type::record('user', $who)),
         rowsForClerkId: (SELECT VALUE id FROM user WHERE clerkUserId = $clerkUserId),
         queued: (SELECT VALUE id FROM pendingDeletion)
       }`,
      { who, clerkUserId: `user_${who}` },
    ).then(([r]) => r);

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    apiUser = await t.service('api_user');
    const broken = breakable(apiUser);
    breaks = broken.breaks;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(broken.db)
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
      .overrideProvider(BUNNY_STORAGE)
      .useValue(images)
      .overrideProvider(CLERK_BACKEND)
      .useValue(clerkApi)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
    await createPeople(t, { admin: 'user_admin', bob: 'user_bob' });
    await grantAll(await t.person('user_bob'));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('deletes my account: stories, hearts, video, picture and Clerk account go; the ledger stays; my token is refused', async () => {
    const { video, picture } = await personWithStories('ann');
    expect((await call('GET', '/v1/account', 'ann')).status).toBe(200);

    expect(await call('DELETE', '/v1/account', 'ann')).toEqual({
      status: 202,
      body: undefined,
    });
    expect(await left('ann')).toEqual({
      stories: [],
      publicStories: [],
      hearts: [],
      grants: [],
      user: [undefined, true],
      ledger: expect.any(Number),
      erasedBy: ['account_deleted'],
      rowsForClerkId: [],
      queued: [],
    });
    expect((await left('ann')).ledger).toBeGreaterThan(0);
    expect(bunny.deleted).toContain(video);
    expect(images.deleted).toEqual([picture]);
    expect(clerkApi.deleted).toEqual(['user_ann']);

    // #44: the same, still-valid token neither signs in nor recreates the person, however often.
    for (const path of ['/v1/account', '/v1/account/stories']) {
      expect((await call('GET', path, 'ann')).status).toBe(401);
    }
    expect((await call('DELETE', '/v1/account', 'ann')).status).toBe(401);
    expect((await left('ann')).rowsForClerkId).toEqual([]);
  });

  it('keeps a Clerk deletion that failed queued, pushed back, without holding up the next erasure (D40)', async () => {
    await personWithStories('cat');
    clerkApi.failing = true;
    expect((await call('DELETE', '/v1/account', 'cat')).status).toBe(202);
    // The database half is done; only the Clerk account waits, an hour at first (housekeeping).
    expect(await left('cat')).toMatchObject({
      stories: [],
      user: [undefined, true],
      queued: [expect.stringMatching(/^pendingDeletion:/)],
    });
    expect(
      await rows(
        migrator,
        `SELECT attempts, nextAttemptAt > time::now() + 50m AS later FROM pendingDeletion`,
      ),
    ).toEqual([{ attempts: 1, later: true }]);
    expect((await call('GET', '/v1/account', 'cat')).status).toBe(401);

    clerkApi.failing = false;
    await personWithStories('dan');
    expect((await call('DELETE', '/v1/account', 'dan')).status).toBe(202);
    expect(clerkApi.deleted).toContain('user_dan');
    expect(clerkApi.deleted).not.toContain('user_cat');
    expect(
      await rows(migrator, `SELECT VALUE ref FROM pendingDeletion`),
    ).toEqual(['user_cat']);
    await run(migrator, `DELETE pendingDeletion`);
  });

  it('answers 202 once the account is erased, even if the deletion queue then fails: the deletions wait', async () => {
    const { video, picture } = await personWithStories('ida');
    breaks.failing = 'pendingDeletion';
    try {
      expect(await call('DELETE', '/v1/account', 'ida')).toEqual({
        status: 202,
        body: undefined,
      });
    } finally {
      breaks.failing = null;
    }
    expect(await left('ida')).toMatchObject({
      stories: [],
      user: [undefined, true],
      erasedBy: ['account_deleted'],
    });
    expect(
      await rows(
        migrator,
        `SELECT VALUE ref FROM pendingDeletion ORDER BY ref`,
      ),
    ).toEqual([video, picture, 'user_ida'].sort());
    expect(bunny.deleted).not.toContain(video);
    expect(images.deleted).not.toContain(picture);
    expect((await call('GET', '/v1/account', 'ida')).status).toBe(401);
    await run(migrator, `DELETE pendingDeletion`);
  });

  it('withdrawing the testimony consent deletes the account, with the withdrawal kept as proof (D88)', async () => {
    const { video } = await personWithStories('eve');
    const res = await call(
      'POST',
      '/v1/account/consents/special_category_religious/withdraw',
      'eve',
      { 'idempotency-key': `withdraw-eve-${'x'.repeat(16)}` },
    );
    expect(res.status).toBe(202);
    expect(await left('eve')).toMatchObject({
      stories: [],
      publicStories: [],
      user: [undefined, true],
      erasedBy: ['consent_withdrawn'],
      queued: [],
    });
    expect(await rows(migrator, `SELECT VALUE id FROM erasureRequest`)).toEqual(
      [],
    );
    expect(
      await rows(
        migrator,
        `SELECT VALUE event FROM consent WHERE subject = user:eve
           AND type = 'special_category_religious' ORDER BY occurredAt DESC LIMIT 1`,
      ),
    ).toEqual(['withdrawn']);
    expect(bunny.deleted).toContain(video);
    expect(clerkApi.deleted).toContain('user_eve');
  });

  it('a withdrawal whose erasure fails still answers 202, and the erasure stays requested with it (D88)', async () => {
    await personWithStories('jo');
    breaks.failing = 'fn::account::erase';
    try {
      const res = await call(
        'POST',
        '/v1/account/consents/account_data/withdraw',
        'jo',
        { 'idempotency-key': `withdraw-jo-${'x'.repeat(16)}` },
      );
      expect(res.status).toBe(202);
    } finally {
      breaks.failing = null;
    }
    expect(await left('jo')).toMatchObject({
      user: ['user_jo', false],
      erasedBy: [],
    });
    // Committed with the withdrawal: housekeeping erases Jo tonight if nobody does first.
    expect(
      await rows(migrator, `SELECT VALUE id FROM erasureRequest:jo`),
    ).toEqual(['erasureRequest:jo']);
    // Jo deleting their account meanwhile settles it.
    expect((await call('DELETE', '/v1/account', 'jo')).status).toBe(202);
    expect(await rows(migrator, `SELECT VALUE id FROM erasureRequest`)).toEqual(
      [],
    );
    expect((await left('jo')).erasedBy).toEqual(['account_deleted']);
  });

  it('taking all my stories off the site (withdrawing publish) keeps the account and the stories', async () => {
    await personWithStories('fay');
    const res = await call(
      'POST',
      '/v1/account/consents/publish/withdraw',
      'fay',
      { 'idempotency-key': `withdraw-fay-${'x'.repeat(16)}` },
    );
    expect(res.status).toBe(202);
    expect(await left('fay')).toMatchObject({
      stories: expect.arrayContaining(['fay_live', 'fay_video']),
      publicStories: [],
      user: ['user_fay', false],
      erasedBy: [],
    });
    expect((await call('GET', '/v1/account', 'fay')).status).toBe(200);
  });

  describe('Clerk’s user.deleted webhook', () => {
    it('erases the person once, without asking Clerk to delete them again', async () => {
      const { video } = await personWithStories('gus');
      const event = {
        type: 'user.deleted',
        object: 'event',
        data: { id: 'user_gus', object: 'user', deleted: true },
      };
      const id = `msg_${randomUUID()}`;
      expect(await webhook(event, { id })).toBe(204);
      expect(await left('gus')).toMatchObject({
        stories: [],
        user: [undefined, true],
        erasedBy: ['clerk_user_deleted'],
        queued: [],
      });
      expect(bunny.deleted).toContain(video);
      expect(clerkApi.deleted).not.toContain('user_gus');
      // Svix redelivers: acknowledged, nothing more.
      expect(await webhook(event, { id })).toBe(204);
      expect((await left('gus')).erasedBy).toEqual(['clerk_user_deleted']);
      // A Clerk id we never saw: fingerprinted, so a leftover token can't create it.
      expect(
        await webhook({ ...event, data: { id: 'user_never', object: 'user' } }),
      ).toBe(204);
      expect((await call('GET', '/v1/account', 'never')).status).toBe(401);
      expect((await left('never')).rowsForClerkId).toEqual([]);
    });

    it('refuses an unsigned or wrongly signed event, and erases nothing', async () => {
      await createPeople(t, { hal: 'user_hal' });
      const event = { type: 'user.deleted', data: { id: 'user_hal' } };
      expect(await webhook(event, { key: Buffer.alloc(24, 8) })).toBe(400);
      const res = await fetch(`${url}/v1/webhooks/clerk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      expect(res.status).toBe(400);
      expect((await left('hal')).user).toEqual(['user_hal', false]);
    });

    it('acknowledges other events and stores nothing from them', async () => {
      expect(
        await webhook({ type: 'user.updated', data: { id: 'user_bob' } }),
      ).toBe(204);
      expect((await left('bob')).user).toEqual(['user_bob', false]);
    });

    it('answers 503 until the signing secret is set, so Svix retries', async () => {
      clerkApi.webhooksOn = false;
      try {
        expect(
          await webhook({ type: 'user.deleted', data: { id: 'user_bob' } }),
        ).toBe(503);
      } finally {
        clerkApi.webhooksOn = true;
      }
      expect((await left('bob')).user).toEqual(['user_bob', false]);
    });
  });
});

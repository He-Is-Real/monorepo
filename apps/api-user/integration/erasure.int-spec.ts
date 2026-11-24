import { createHmac, randomUUID } from 'node:crypto';
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
  draft,
  grantImage,
  grantUpload,
  rows,
  run,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { wideEvents } from '@heisreal/http';
import { LOG_SINKS, type LogSink } from '@heisreal/logging/event';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  CLERK_BACKEND,
  type ClerkBackend,
} from '../src/app/erasure/clerk-backend';
import { Erasure } from '../src/app/erasure/erasure';
import {
  BUNNY_STORAGE,
  BunnyImageStore,
} from '../src/app/stories/bunny-storage';
import {
  BUNNY_STREAM,
  type BunnyStream,
  signUpload,
} from '@heisreal/story-cards/bunny-stream';

/**
 * Erasure (M2 plan PR 11; D39, D40, D82) through api-user's real AppModule, for its two callers:
 * "Delete my account" (`DELETE /v1/account`, also how a person withdraws all consent, plan 4e)
 * and Clerk's signed `user.deleted` webhook. The database is the behaviour: what goes, what stays, and that a
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
  async setThumbnail(): Promise<void> {
    throw new Error('No video’s picture is set in these tests');
  }
}

/** The images zone: records the story folders it was asked to delete. */
class FakeImages extends BunnyImageStore {
  readonly deleted: string[] = [];
  override async deleteFolder(folder: string) {
    this.deleted.push(folder);
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
  passIssuer() {
    return null;
  }
  async getUser(): Promise<never> {
    throw new Error('not in these tests');
  }
}

/**
 * api-user's database login, made to fail on demand: `failing` names a piece of SurrealQL whose
 * queries throw (the database half of erasure, or the deletion queue), after the first `skip` of
 * them have run. `holding` keeps a matching query's answer back (after it has run) until
 * `release` is called.
 */
function breakable(db: Surreal) {
  const breaks = {
    failing: null as string | null,
    skip: 0,
    holding: null as {
      sql: string;
      reached: () => void;
      release: Promise<void>;
    } | null,
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql: string, vars?: Record<string, unknown>) => {
          let fail = false;
          if (breaks.failing && sql.includes(breaks.failing)) {
            if (breaks.skip > 0) breaks.skip--;
            else fail = true;
          }
          const query = target.query(
            fail ? `THROW 'the database is unavailable'` : sql,
            vars,
          );
          const hold = breaks.holding;
          if (!hold || !sql.includes(hold.sql)) return query;
          breaks.holding = null;
          // runQuery reads `query(…).json().responses()`: answer once released.
          return {
            json: () => ({
              responses: async () => {
                const answer = await query.json().responses();
                hold.reached();
                await hold.release;
                return answer;
              },
            }),
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, breaks };
}

type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('erasure: delete my account and Clerk’s user.deleted', () => {
  const contract = new Contract('api-user.yaml');
  const bunny = new FakeStream();
  const images = new FakeImages({
    name: 'test-zone',
    password: 'zone-password',
    host: 'uk-s3.storage.bunnycdn.com',
    region: 'uk',
  });
  const clerkApi = new FakeClerk();
  let breaks: ReturnType<typeof breakable>['breaks'];
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let app: INestApplication;
  let url: string;
  const entries: Entry[] = [];
  const waiting: (() => void)[] = [];
  const sink: LogSink = {
    write: (_severity, entry) => {
      entries.push(entry);
      waiting.splice(0).forEach((wake) => wake());
    },
  };
  const sinksBefore = [...LOG_SINKS];

  /** The log entries matching `pick`, once `count` of them have been written. */
  async function written(pick: (e: Entry) => boolean, count = 1) {
    while (entries.filter(pick).length < count) {
      await new Promise<void>((wake) => waiting.push(wake));
    }
    return entries.filter(pick);
  }

  /** A traceparent whose trace id makes the request's ref `ref(n)`. */
  const traceId = (n: number) =>
    `0e1a5e00000070008000${String(n).padStart(12, '0')}`;
  const ref = (n: number) =>
    traceId(n).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const traced = (n: number) => ({
    traceparent: `00-${traceId(n)}-00f067aa0ba902b7-01`,
  });
  const requestEvent = (n: number) =>
    written((e) => e['ref'] === ref(n) && e['event'] === 'request').then(
      ([e]) => e,
    );

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
    await agreeAll(session);
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
      `CREATE favourite:ulid() CONTENT { person: $auth, story: type::record('story', $id) }`,
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
         statusLog: (SELECT VALUE id FROM storyStatusLog WHERE string::starts_with(record::id(story), $who)),
         hearts: (SELECT VALUE id FROM favourite WHERE string::starts_with(record::id(story), $who)),
         grants: (SELECT VALUE id FROM storyFile WHERE person = type::record('user', $who)),
         user: (SELECT VALUE [clerkUserId, status = 'deleted'] FROM ONLY type::record('user', $who)),
         agreements: (SELECT VALUE [termsOfUse, termsOfUseAgreedAt, testimonyConsent,
           testimonyConsentAgreedAt].filter(|$v| $v != NONE).len()
           FROM ONLY type::record('user', $who)),
         rowsForClerkId: (SELECT VALUE id FROM user WHERE clerkUserId = $clerkUserId),
         queued: (SELECT VALUE id FROM pendingDeletion WHERE kind != 'image'),
         folders: (SELECT VALUE ref FROM pendingDeletion WHERE kind = 'image'
           AND string::starts_with(ref, 'stories/' + $who + '_') ORDER BY ref)
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
    LOG_SINKS.splice(0, LOG_SINKS.length, sink);
    app.use(wideEvents('api-user'));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await createPeople(t, { admin: 'user_admin', bob: 'user_bob' });
    await agreeAll(await t.person('user_bob'));
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
    LOG_SINKS.splice(0, LOG_SINKS.length, ...sinksBefore);
  });

  it('deletes my account: stories, hearts, video, picture, agreements and Clerk account go; my token is refused', async () => {
    const { video } = await personWithStories('ann');
    expect((await left('ann')).agreements).toBe(4);
    const folders = ['stories/ann_live/', 'stories/ann_video/'];
    expect((await call('GET', '/v1/account', 'ann')).status).toBe(200);

    expect(await call('DELETE', '/v1/account', 'ann')).toEqual({
      status: 202,
      body: undefined,
    });
    expect(await left('ann')).toEqual({
      stories: [],
      statusLog: [],
      hearts: [],
      grants: [],
      user: [undefined, true],
      // Deleting the account withdraws every consent: nothing kept says what they agreed to.
      agreements: 0,
      rowsForClerkId: [],
      queued: [],
      // Deleted straight away, and kept for their final pass: a PUT link signed before the
      // erasure may still put a picture there for 10 minutes (housekeeping's next run).
      folders,
    });
    expect(bunny.deleted).toContain(video);
    expect([...images.deleted].sort()).toEqual(folders);
    expect(
      await rows(
        migrator,
        `SELECT VALUE [attempts, nextAttemptAt = finalPassAt, finalPassAt > time::now() + 14m]
         FROM pendingDeletion WHERE kind = 'image'`,
      ),
    ).toEqual([
      [0, true, true],
      [0, true, true],
    ]);
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
        `SELECT attempts, nextAttemptAt > time::now() + 50m AS later FROM pendingDeletion
         WHERE kind = 'clerk_user'`,
      ),
    ).toEqual([{ attempts: 1, later: true }]);
    expect((await call('GET', '/v1/account', 'cat')).status).toBe(401);

    clerkApi.failing = false;
    await personWithStories('dan');
    expect((await call('DELETE', '/v1/account', 'dan')).status).toBe(202);
    expect(clerkApi.deleted).toContain('user_dan');
    expect(clerkApi.deleted).not.toContain('user_cat');
    expect(
      await rows(
        migrator,
        `SELECT VALUE ref FROM pendingDeletion WHERE kind != 'image'`,
      ),
    ).toEqual(['user_cat']);
    await run(migrator, `DELETE pendingDeletion`);
  });

  it('answers 202 once the account is erased, even if the deletion queue then fails: the deletions wait', async () => {
    const { video } = await personWithStories('ida');
    const folders = ['stories/ida_live/', 'stories/ida_video/'];
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
    });
    expect(
      await rows(
        migrator,
        `SELECT VALUE ref FROM pendingDeletion ORDER BY ref`,
      ),
    ).toEqual([...folders, video, 'user_ida'].sort());
    expect(bunny.deleted).not.toContain(video);
    expect(images.deleted).not.toContain(folders[1]);
    expect((await call('GET', '/v1/account', 'ida')).status).toBe(401);
    await run(migrator, `DELETE pendingDeletion`);
  });

  it('logs the erasure record even when the person hangs up before it is done (D40: backups replay from it)', async () => {
    await personWithStories('jo');
    // The whole erasure, both drain passes included, so the test knows when it is done.
    const erasure = app.get(Erasure);
    const erase = erasure.erase.bind(erasure);
    let finished!: Promise<void>;
    const spy = vi
      .spyOn(erasure, 'erase')
      .mockImplementationOnce((...args) => (finished = erase(...args)));
    let reached!: () => void;
    let release!: () => void;
    const committed = new Promise<void>((r) => (reached = r));
    breaks.holding = {
      sql: 'fn::account::erase',
      reached,
      release: new Promise<void>((r) => (release = r)),
    };
    const hangUp = new AbortController();
    const asked = fetch(`${url}/v1/account`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${clerk.token('user_jo')}`,
        ...traced(1),
      },
      signal: hangUp.signal,
    }).catch(() => undefined);
    // The database half has committed; the person hangs up before the answer.
    await committed;
    hangUp.abort();
    await asked;
    const event = await requestEvent(1);
    expect(event['erasure']).toBeUndefined();
    release();
    const [line] = await written(
      (e) => e['ref'] === ref(1) && e['message'] === 'Account erased',
    );
    expect(line).toMatchObject({
      ref: ref(1),
      service: { name: 'api-user' },
      action: 'account.erase',
      erasure: {
        user_record: expect.stringContaining('jo'),
        reason: 'account_deleted',
        queued_count: 4,
      },
    });
    // The rest of the erasure carries on without the caller.
    await finished;
    spy.mockRestore();
    expect(await left('jo')).toMatchObject({ queued: [] });
    expect(clerkApi.deleted).toContain('user_jo');
    await run(migrator, `DELETE pendingDeletion`);
  });

  it('logs every failed deletion from both of an erasure’s passes, and those before a database error', async () => {
    clerkApi.failing = true;
    try {
      await personWithStories('kim');
      expect(
        (await call('DELETE', '/v1/account', 'kim', traced(2))).status,
      ).toBe(202);
      // Kim's Clerk deletion is due again when Lee is erased: Lee's pass, then the others'.
      await run(
        migrator,
        `UPDATE pendingDeletion SET nextAttemptAt = time::now() - 1s WHERE ref = 'user_kim'`,
      );
      await personWithStories('lee');
      expect(
        (await call('DELETE', '/v1/account', 'lee', traced(3))).status,
      ).toBe(202);
      const failedClerk = {
        kind: 'clerk_user',
        key: expect.any(String),
        reason: 'Error',
      };
      expect((await requestEvent(3))['erasure']).toMatchObject({
        reason: 'account_deleted',
        deletions_failed: [failedClerk, failedClerk],
      });

      // Mia's own pass fails at Clerk; the database then fails the second pass.
      await personWithStories('mia');
      breaks.failing = 'nextAttemptAt <= time::now()';
      breaks.skip = 1;
      expect(
        (await call('DELETE', '/v1/account', 'mia', traced(4))).status,
      ).toBe(202);
      expect((await requestEvent(4))['erasure']).toMatchObject({
        drain_failed: 'DatabaseQueryError',
        deletions_failed: [failedClerk],
      });
    } finally {
      clerkApi.failing = false;
      breaks.failing = null;
      breaks.skip = 0;
    }
    await run(migrator, `DELETE pendingDeletion`);
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
        queued: [],
      });
      expect(bunny.deleted).toContain(video);
      expect(clerkApi.deleted).not.toContain('user_gus');
      // Svix redelivers: acknowledged, nothing more.
      expect(await webhook(event, { id })).toBe(204);
      expect((await left('gus')).user).toEqual([undefined, true]);
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

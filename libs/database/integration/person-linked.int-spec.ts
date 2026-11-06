import { randomUUID } from 'node:crypto';
import type { Surreal, SurrealQueryable } from 'surrealdb';
import {
  agree,
  agreeAll,
  createPeople,
  outcome,
  publishVersion,
  rows,
  run,
  shareStory,
  TestDatabase,
} from './support/harness';
import {
  approve,
  draft,
  ERASE,
  grantUpload,
  submit,
} from './support/world';

/**
 * Review round 3: every table that holds or links person data, directly or through `story`, is
 * classified here and in docs/db-permissions.md ("Person-linked tables"). A new table fails the
 * first test until it's classified, so the next one can't slip through.
 *
 *   linked → a new/changed row needs an existing, non-erased person (fn::person::live) and bumps
 *            their fence: refused after erasure, and a write racing erasure loses at commit.
 *   root   → the person record itself (user): erasure turns it into a stub (D37); fenced.
 *   kept   → deliberately kept after erasure, and written by erasure itself: no person link.
 *   none   → no person data.
 */
const CLASSIFICATION: Record<string, 'linked' | 'root' | 'kept' | 'none'> = {
  user: 'root',
  story: 'linked', // submitter
  storyStatusLog: 'linked', // story → submitter (R6)
  idempotencyKey: 'linked', // id[1] = user record
  favourite: 'linked', // person (hearts, M2); deleted at erasure
  submitterLimits: 'linked', // user (D112: limits, trusted mark)
  submissionLog: 'linked', // person (D113: recent submissions)
  storyFile: 'linked', // person, story (D80, R12: the files api-user made for them)
  submissionSettings: 'none', // the limits an admin sets (W3, D112)
  // D82: the sha256 of an erased Clerk id, so it never gets a row again; no link, no date.
  erasedIdentity: 'kept',
  // D40: Bunny ids and image paths (and, until Clerk confirms, the Clerk id) erasure still has
  // to delete outside the database; written by erasure itself, gone once done. No person link.
  pendingDeletion: 'kept',
  // R5: one table of counters, keyed by what they guard (a user id, a Clerk id's fingerprint, a
  // theme id); events only.
  fence: 'none',
  themeCategory: 'none', // admin-managed theme categories: names only
  theme: 'none',
  themeCatalog: 'none', // the themes' version and who saved them last, like submissionSettings
  // Plan 4e: the legal texts' versions: text, date and (R3) the admin who published it, like
  // themeCatalog's changedBy. The person's agreements are pointers on their user row and story
  // (POINTERS below).
  termsOfUseAgreement: 'none',
  testimonyConsent: 'none',
  socialMediaSharingConsent: 'none',
  privacyNotice: 'none',
  service: 'none',
  _migration: 'none',
  _migrationRun: 'none', // the migration fencing token
  _migrationReset: 'none', // the dev database resets carried out (names only)
  _migrationPending: 'none', // a migration step in progress
  _identity: 'none', // the identity config SurrealDB started with
  _setting: 'none', // settings from OpenTofu (the environment's name)
};

type Ctx = {
  t: TestDatabase;
  person: Surreal; // the person's own session, opened BEFORE erasure
  admin: Surreal;
  apiUser: Surreal;
  workflow: Surreal;
  migrator: Surreal;
  p: string; // user id, e.g. 'story_seq'
};
type LinkedCase = {
  /** Run before the write, while the person is live (the state the write needs). */
  setup?: (c: Ctx) => Promise<unknown>;
  /** The write, linked to person `p`, on the session that would make it in production. */
  write: (c: Ctx, db: (c: Ctx) => SurrealQueryable) => Promise<unknown>;
  writer: (c: Ctx) => Surreal;
  /** What would be stored if the write had landed (empty = nothing landed). */
  landed: (c: Ctx) => string;
};

const LINKED: Record<string, LinkedCase> = {
  favourite: {
    writer: (c) => c.person,
    write: (c, db) =>
      run(
        db(c),
        `CREATE favourite:ulid() SET person = $auth, story = story:${c.p}_s`,
      ),
    landed: (c) => `SELECT VALUE id FROM favourite WHERE person = user:${c.p}`,
  },
  story: {
    writer: (c) => c.person,
    write: (c, db) => draft(db(c), `${c.p}_new`),
    landed: (c) => `SELECT VALUE id FROM story:${c.p}_new`,
  },
  storyStatusLog: {
    // A moderator hides the approved story (R6).
    writer: (c) => c.admin,
    write: (c, db) =>
      run(
        db(c),
        `CREATE storyStatusLog CONTENT { story: story:${c.p}_s, status: 'hidden', by: user:moderator }`,
      ),
    landed: (c) =>
      `SELECT VALUE id FROM storyStatusLog WHERE story = story:${c.p}_s AND status = 'hidden'`,
  },
  idempotencyKey: {
    writer: (c) => c.apiUser,
    write: (c, db) =>
      run(
        db(c),
        `CREATE idempotencyKey:['api-user', user:${c.p}, 'k-new'] CONTENT {
           requestHash: 'h', status: 201, response: { id: story:${c.p}_s, version: 1 } }`,
      ),
    landed: (c) =>
      `SELECT VALUE id FROM idempotencyKey WHERE record::id(id)[1] = user:${c.p}`,
  },
  submitterLimits: {
    writer: (c) => c.admin,
    write: (c, db) =>
      run(
        db(c),
        `UPSERT submitterLimits:${c.p} SET user = user:${c.p}, trusted = true,
           changedBy = user:moderator`,
      ),
    landed: (c) => `SELECT VALUE id FROM submitterLimits:${c.p}`,
  },
  storyFile: {
    // RequestUpload's row (D80, R12), on api-user's login, for the person's video draft.
    setup: (c) =>
      draft(c.person, `${c.p}_v`, { primaryFormat: 'video', body: undefined }),
    writer: (c) => c.apiUser,
    write: (c, db) =>
      grantUpload(db(c), {
        video: randomUUID(),
        story: `${c.p}_v`,
        person: c.p,
        version: 1,
      }).then((o) => {
        if (!o.ok) throw new Error(o.error);
      }),
    landed: (c) =>
      `SELECT VALUE id FROM storyFile WHERE person = user:${c.p}`,
  },
  submissionLog: {
    // Written by story_limits when the person first submits a story. livePerson's own
    // submission is the first row; trusted, so a second one is allowed (and still logged).
    setup: async (c) => {
      await run(
        c.migrator,
        `UPSERT submitterLimits:${c.p} SET user = user:${c.p}, trusted = true`,
      );
      await draft(c.person, `${c.p}_log`);
    },
    writer: (c) => c.person,
    write: (c, db) => submit(db(c), `${c.p}_log`),
    landed: (c) =>
      `RETURN (SELECT VALUE id FROM submissionLog WHERE person = user:${c.p} ORDER BY at ASC)[1..]`,
  },
};

/**
 * Plan 4e: a person's agreements are pointers on rows that are already linked (their user row and
 * their story), written in their own session. The same three checks: agreeing, or ticking a
 * story's sharing box, after or racing the erasure that clears them never lands.
 */
const POINTERS: Record<string, LinkedCase> = {
  user_termsOfUse: {
    // Newer terms to agree to (they had agreed to the latest when they started).
    setup: (c) => publishVersion(c.t, 'termsOfUseAgreement'),
    writer: (c) => c.person,
    write: (c, db) =>
      agree(db(c), 'termsOfUse').then((r) => {
        if (r.length !== 1) throw new Error('not agreed');
      }),
    landed: (c) =>
      `SELECT VALUE id FROM user:${c.p}
         WHERE termsOfUse != NONE AND termsOfUse = fn::legal::latest('termsOfUseAgreement')`,
  },
  story_socialMediaSharingConsent: {
    setup: (c) => draft(c.person, `${c.p}_d`),
    writer: (c) => c.person,
    write: (c, db) =>
      shareStory(db(c), `story:${c.p}_d`).then((r) => {
        if (r.length !== 1) throw new Error('not shared');
      }),
    landed: (c) =>
      `SELECT VALUE id FROM story:${c.p}_d WHERE socialMediaSharingConsent != NONE`,
  },
};

const CONFLICT = /Transaction conflict.*can be retried/s;

describe('person-linked tables (round 3 sweep)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;

  /** A live person who agreed to everything, with an approved (public) story. */
  async function livePerson(p: string): Promise<Ctx> {
    await createPeople(t, { [p]: `user_${p}` });
    const person = await t.person(`user_${p}`);
    await agreeAll(person);
    await draft(person, `${p}_s`);
    await submit(person, `${p}_s`);
    await approve(admin, `${p}_s`);
    return { t, person, admin, apiUser, workflow, migrator, p };
  }
  const erase = (p: string) =>
    run(apiUser, ERASE, {
      clerkUserId: `user_${p}`,
      reason: 'clerk_user_deleted',
    });

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    apiUser = await t.service('api_user');
    workflow = await t.service('workflow');
    await createPeople(t, { moderator: 'user_mod' });
  });
  afterAll(() => t?.close());

  it('every table in the schema is classified', async () => {
    const [info] = await rows<{ tables: Record<string, unknown> }>(
      migrator,
      'INFO FOR DB',
    );
    expect(Object.keys(info.tables).sort()).toEqual(
      Object.keys(CLASSIFICATION).sort(),
    );
    const linked = Object.entries(CLASSIFICATION)
      .filter(([, c]) => c === 'linked')
      .map(([n]) => n)
      .sort();
    expect(Object.keys(LINKED).sort()).toEqual(linked);
  });

  const CASES = { ...LINKED, ...POINTERS };
  describe.each(Object.keys(CASES))('%s', (table) => {
    const c = CASES[table];

    it('the write works for a live person (control)', async () => {
      const ctx = await livePerson(`${table}_ok`);
      await c.setup?.(ctx);
      await c.write(ctx, c.writer);
      expect(await rows(migrator, c.landed(ctx))).toHaveLength(1);
    });

    it('refuses the write after erasure, from a session opened before it', async () => {
      const ctx = await livePerson(`${table}_seq`);
      await c.setup?.(ctx);
      await erase(ctx.p);
      await c.write(ctx, c.writer).catch(() => undefined); // refused: error or empty result
      expect(await rows(migrator, c.landed(ctx))).toEqual([]);
    });

    it('a write racing erasure loses at commit and leaves nothing behind', async () => {
      const ctx = await livePerson(`${table}_race`);
      await c.setup?.(ctx);
      const tx = await c.writer(ctx).beginTransaction();
      await c.write(ctx, () => tx);
      await erase(ctx.p);
      await expect(tx.commit()).rejects.toThrow(CONFLICT);
      expect(await rows(migrator, c.landed(ctx))).toEqual([]);
    });
  });

  it('root (user): two erasures racing (webhook + in-app, D39): one wins, the retry is a no-op', async () => {
    const ctx = await livePerson('root_race');
    const tx = await apiUser.beginTransaction();
    await tx
      .query(
        ERASE.replace('BEGIN TRANSACTION;', '').replace(
          'COMMIT TRANSACTION;',
          '',
        ),
        {
          clerkUserId: `user_${ctx.p}`,
          reason: 'account_deleted',
        },
      )
      .collect();
    await erase(ctx.p); // the webhook's erasure commits first
    await expect(tx.commit()).rejects.toThrow(CONFLICT);
    // The retry finds the person already erased: nothing more happens.
    expect(
      await outcome(apiUser, ERASE, {
        clerkUserId: `user_${ctx.p}`,
        reason: 'account_deleted',
      }),
    ).toMatchObject({ ok: true });
    // The webhook's erasure won: Clerk had already deleted the account, so none is queued.
    expect(
      await rows(
        migrator,
        `SELECT VALUE ref FROM pendingDeletion WHERE kind = 'clerk_user' AND ref = $ref`,
        { ref: `user_${ctx.p}` },
      ),
    ).toEqual([]);
    expect(
      await rows(migrator, `SELECT VALUE status FROM user:${ctx.p}`),
    ).toEqual(['deleted']);
  });

  it('a status entry can’t be created for a story that no longer exists', async () => {
    expect(
      await outcome(
        admin,
        `CREATE storyStatusLog CONTENT { story: story:never_existed, status: 'rejected',
           by: user:moderator }`,
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('needs an existing story'),
    });
  });

  it('idempotency keys can’t carry a Clerk id or any other free value', async () => {
    expect(
      await outcome(
        apiUser,
        `CREATE idempotencyKey:['api-user', 'user_clerk_id', 'k'] SET requestHash = 'h', status = 201`,
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('scoped to a user record'),
    });
    expect(
      (
        await outcome(
          apiUser,
          `CREATE idempotencyKey:['api-user', 'svix', 'k'] SET requestHash = 'h', status = 200,
             response = { id: story:x, version: 1, body: 'testimony text' }`,
        )
      ).ok,
    ).toBe(false); // response is typed: no free fields
  });

  it.each([
    [
      'CREATE',
      `CREATE user:pre_erased SET clerkUserId = 'clerk_retained', status = 'deleted'`,
    ],
    [
      'INSERT',
      `INSERT INTO user { id: user:pre_erased, clerkUserId: 'clerk_retained', status: 'deleted' }`,
    ],
  ])(
    'D37 holds on %s: an erased row can never carry a Clerk id (round 4)',
    async (_, sql) => {
      for (const db of [apiUser, migrator]) {
        expect(await outcome(db, sql)).toEqual({
          ok: false,
          error: expect.stringContaining('without a clerkUserId'),
        });
      }
      // api_admin can't create users at all: the permission gives an empty result.
      expect(await outcome(admin, sql)).toEqual({ ok: true, result: [] });
      expect(await rows(migrator, 'SELECT * FROM user:pre_erased')).toEqual([]);
    },
  );

  it('deleting a person-scoped key also bumps the fence (round 4)', async () => {
    const ctx = await livePerson('del_fence');
    await run(
      apiUser,
      `CREATE idempotencyKey:['api-user', user:del_fence, 'k'] SET requestHash = 'h', status = 201`,
    );
    const fence = async () =>
      (
        await rows<number>(
          migrator,
          `SELECT VALUE n FROM type::record('fence', 'person-${ctx.p}')`,
        )
      )[0];
    const before = await fence();
    await run(
      apiUser,
      `DELETE idempotencyKey:['api-user', user:del_fence, 'k']`,
    );
    expect(await fence()).toBe(before + 1);
  });
});

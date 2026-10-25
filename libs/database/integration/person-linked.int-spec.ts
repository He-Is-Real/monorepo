import type { Surreal, SurrealQueryable } from 'surrealdb';
import {
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { draft, ERASE, submit } from './support/world';

/**
 * Review round 3: every table that holds or links person data, directly or through `story`, is
 * classified here and in docs/db-permissions.md ("Person-linked tables"). A new table fails the
 * first test until it's classified, so the next one can't slip through.
 *
 *   linked → a new/changed row needs an existing, non-erased person (fn::person::live) and bumps
 *            their fence: refused after erasure, and a write racing erasure loses at commit.
 *   root   → the person record itself (user): erasure turns it into a stub (D37); fenced.
 *   kept   → deliberately kept after erasure (D38 audit): typed fields only, so even a write that
 *            races erasure carries ids and codes, never testimony text.
 *   none   → no person data.
 */
const CLASSIFICATION: Record<string, 'linked' | 'root' | 'kept' | 'none'> = {
  user: 'root',
  story: 'linked', // submitter
  publicStory: 'linked', // same id as the story → submitter
  hiddenStory: 'linked', // same id as the story → submitter
  consent: 'linked', // subject (kept after erasure as proof; pruned after 6 years)
  moderationReview: 'linked', // story → submitter
  idempotencyKey: 'linked', // id[1] = user record
  auditLog: 'kept', // actor/entity ids, typed fields (D38)
  personFence: 'none', // a counter keyed by user id; events only
  legalFence: 'none', // one counter for the consent forms, grants, new drafts and submissions; events only
  tag: 'none',
  dpaVersion: 'none',
  signupFormVersion: 'none', // consent form versions (D84): text and features only
  testimonyFormVersion: 'none',
  socialSharingFormVersion: 'none',
  service: 'none',
  _migration: 'none',
  _migrationRun: 'none', // the migration fencing token
  _migrationPending: 'none', // a migration step in progress
  _identity: 'none', // the identity config SurrealDB started with
  _setting: 'none', // settings from OpenTofu (D48's dev-only switch)
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
  story: {
    writer: (c) => c.person,
    write: (c, db) => draft(db(c), `${c.p}_new`),
    landed: (c) => `SELECT VALUE id FROM story:${c.p}_new`,
  },
  publicStory: {
    writer: (c) => c.admin,
    write: (c, db) =>
      run(
        db(c),
        `LET $s = (SELECT * FROM ONLY story:${c.p}_s);
         CREATE publicStory:${c.p}_s CONTENT {
           version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
           body: $s.body, primaryFormat: $s.primaryFormat, tagRefs: $s.tagRefs, media: [],
           publishedAt: time::now() };`,
      ),
    landed: (c) => `SELECT VALUE id FROM publicStory:${c.p}_s`,
  },
  hiddenStory: {
    // Written by story_media_availability when workflow finds a public story's image broken.
    setup: async (c) => {
      await run(
        c.migrator,
        `UPDATE story:${c.p}_s SET image = {
           path: 'images/x.webp', width: 10, height: 10, processing: 'ready' }`,
      );
      await run(
        c.admin,
        `LET $s = (SELECT * FROM ONLY story:${c.p}_s);
         CREATE publicStory:${c.p}_s CONTENT {
           version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
           body: $s.body, primaryFormat: $s.primaryFormat, tagRefs: $s.tagRefs, media: [],
           image: { path: $s.image.path, width: $s.image.width, height: $s.image.height },
           publishedAt: time::now() };`,
      );
    },
    writer: (c) => c.workflow,
    write: (c, db) =>
      run(db(c), `UPDATE story:${c.p}_s SET image.processing = 'failed'`),
    landed: (c) => `SELECT VALUE id FROM hiddenStory:${c.p}_s`,
  },
  consent: {
    writer: (c) => c.person,
    write: (c, db) =>
      run(
        db(c),
        `CREATE consent CONTENT { subject: $auth, type: 'share_socials', event: 'granted',
           dpaVersion: dpaVersion:v1, form: socialSharingFormVersion:v1,
           mechanism: 'account_settings', evidenceHash: $h }`,
        { h: 'd'.repeat(64) },
      ),
    landed: (c) =>
      `SELECT VALUE id FROM consent WHERE subject = user:${c.p} AND mechanism = 'account_settings'`,
  },
  moderationReview: {
    writer: (c) => c.admin,
    write: (c, db) =>
      run(
        db(c),
        `CREATE moderationReview CONTENT { story: story:${c.p}_s, moderator: user:moderator,
           decision: 'request_changes', storyVersion: 1,
           feedbackToSubmitter: 'Please say more about your conversion' }`,
      ),
    landed: (c) =>
      `SELECT VALUE id FROM moderationReview WHERE record::id(story) = '${c.p}_s'`,
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
};

const CONFLICT = /Transaction conflict.*can be retried/s;

describe('person-linked tables (round 3 sweep)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;

  /** A live person with full consent and an approved story (no publicStory yet). */
  async function livePerson(p: string): Promise<Ctx> {
    await createPeople(t, { [p]: `user_${p}` });
    const person = await t.person(`user_${p}`);
    await grantAll(person);
    await draft(person, `${p}_s`);
    await submit(person, `${p}_s`);
    await run(
      admin,
      `UPDATE story:${p}_s SET status = 'approved', approvedAt = time::now()`,
    );
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
    await publishDpa(t, 'v1');
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

  describe.each(Object.keys(LINKED))('%s', (table) => {
    const c = LINKED[table];

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

  it('kept (auditLog): a write racing erasure commits, with typed fields only (D38)', async () => {
    const ctx = await livePerson('audit_race');
    const tx = await apiUser.beginTransaction();
    await tx
      .query(
        `CREATE auditLog:race CONTENT { service: 'api-user', action: 'EditStory',
           entity: story:audit_race_s, storyVersion: 2 }`,
      )
      .collect();
    await erase(ctx.p);
    await tx.commit(); // no person-state dependency: nothing to fence
    const [row] = await rows<Record<string, unknown>>(
      migrator,
      'SELECT * FROM auditLog:race',
    );
    expect(Object.keys(row).sort()).toEqual([
      'action',
      'createdAt',
      'entity',
      'id',
      'service',
      'storyVersion',
    ]);
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
    expect(
      await outcome(apiUser, ERASE, {
        clerkUserId: `user_${ctx.p}`,
        reason: 'account_deleted',
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('unknown or already erased'),
    });
    expect(
      await rows(
        migrator,
        `SELECT VALUE reason FROM auditLog WHERE entity = user:${ctx.p}`,
      ),
    ).toEqual(['clerk_user_deleted']);
  });

  it('a moderation review can’t be created for a story that no longer exists', async () => {
    expect(
      await outcome(
        admin,
        `CREATE moderationReview CONTENT { story: story:never_existed, moderator: user:moderator,
           decision: 'reject', storyVersion: 1 }`,
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
      `CREATE user:pre_erased SET clerkUserId = 'clerk_retained', gdprDeletedAt = time::now()`,
    ],
    [
      'INSERT',
      `INSERT INTO user { id: user:pre_erased, clerkUserId: 'clerk_retained', gdprDeletedAt: time::now() }`,
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

  it('deleting a review or a person-scoped key also bumps the fence (round 4)', async () => {
    const ctx = await livePerson('del_fence');
    await run(
      admin,
      `CREATE moderationReview:del_r CONTENT { story: story:del_fence_s, moderator: user:moderator,
         decision: 'escalate', storyVersion: 1 }`,
    );
    await run(
      apiUser,
      `CREATE idempotencyKey:['api-user', user:del_fence, 'k'] SET requestHash = 'h', status = 201`,
    );
    const fence = async () =>
      (
        await rows<number>(migrator, `SELECT VALUE n FROM personFence:${ctx.p}`)
      )[0];
    const before = await fence();
    await run(admin, 'DELETE moderationReview:del_r');
    expect(await fence()).toBe(before + 1);
    await run(
      apiUser,
      `DELETE idempotencyKey:['api-user', user:del_fence, 'k']`,
    );
    expect(await fence()).toBe(before + 2);
  });
});

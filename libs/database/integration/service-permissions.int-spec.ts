import type { Surreal } from 'surrealdb';
import { outcome, rows, run, sha256, TestDatabase } from './support/harness';
import { buildWorld } from './support/world';

/**
 * D13 B: each service signs in as its own `service` record through DEFINE ACCESS svc, and
 * table/row/field PERMISSIONS give it only what the matrix allows.
 *
 * SurrealDB returns an EMPTY RESULT, not an error, for a write the permissions deny. So every
 * denial below asserts both the empty result and, through the migrator, that the row really
 * is unchanged or absent.
 */
describe('service identities (D13 B)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let svc: Record<'publicRead' | 'apiUser' | 'admin' | 'workflow', Surreal>;

  /** What the migrator (bypassing permissions) sees: the ground truth. */
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);
  const ids = async (db: Surreal, sql: string) =>
    (await rows<{ id: string }>(db, sql)).map((r) => r.id).sort();

  beforeAll(async () => {
    t = await TestDatabase.create();
    await buildWorld(t);
    migrator = await t.migrator();
    svc = {
      publicRead: await t.service('api_public_read'),
      apiUser: await t.service('api_user'),
      admin: await t.service('api_admin'),
      workflow: await t.service('workflow'),
    };
  });
  afterAll(() => t?.close());

  describe('signing in through DEFINE ACCESS svc', () => {
    it('signs a service in as its own record', async () => {
      // `$auth.id` reads the service row, which is PERMISSIONS NONE, so query `$auth` itself.
      expect(await rows(svc.apiUser, 'RETURN [$auth, $access]')).toEqual([
        'service:api_user',
        'svc',
      ]);
    });

    it('rejects a wrong password, another service’s password and an unknown name', async () => {
      await expect(
        t.service('api_admin', t.servicePasswords.get('api_user')),
      ).rejects.toThrow();
      await expect(t.service('api_admin', 'wrong')).rejects.toThrow();
      const nobody = await t.connect();
      await expect(
        nobody.signin({
          namespace: t.namespace,
          database: t.database,
          access: 'svc',
          variables: { name: 'migrator', secret: 'x' },
        }),
      ).rejects.toThrow();
    });

    it('stores only argon2 hashes, which no service can read or rewrite', async () => {
      const [hash] = await truth(
        'SELECT VALUE secretHash FROM service:api_user',
      );
      expect(hash).toMatch(/^\$argon2id\$/);
      for (const db of Object.values(svc)) {
        expect(await rows(db, 'SELECT * FROM service')).toEqual([]);
        expect(
          await rows(
            db,
            `UPDATE service:api_admin SET secretHash = crypto::argon2::generate('pwned')`,
          ),
        ).toEqual([]);
        expect(
          await rows(
            db,
            `CREATE service:evil SET secretHash = crypto::argon2::generate('x')`,
          ),
        ).toEqual([]);
      }
      expect(
        await truth('SELECT VALUE secretHash FROM service:api_admin'),
      ).not.toEqual([hash]);
      expect(await truth('SELECT * FROM service:evil')).toEqual([]);
      await expect(t.service('api_admin', 'pwned')).rejects.toThrow();
    });
  });

  describe('api_public_read', () => {
    it('reads publicStory and published DPA versions only', async () => {
      const db = svc.publicRead;
      expect(await ids(db, 'SELECT id FROM publicStory')).toEqual([
        'publicStory:bob_live',
      ]);
      expect(await ids(db, 'SELECT id FROM dpaVersion')).toEqual([
        'dpaVersion:v1', // published by the world; the draft seed of v1 is the same row
      ]);
    });

    it.each([
      'story',
      'consent',
      'user',
      'moderationReview',
      'auditLog',
      'idempotencyKey',
      '_migration',
      '_migrationRun',
      '_migrationPending',
      '_identity',
    ])(
      'sees nothing in %s (not even approved stories in the write model)',
      async (table) => {
        expect(await rows(svc.publicRead, `SELECT * FROM ${table}`)).toEqual(
          [],
        );
        expect(
          (await truth(`SELECT count() FROM ${table} GROUP ALL`)).length,
        ).toBe(1);
      },
    );

    it('cannot read a draft or pending story by id', async () => {
      expect(
        await rows(
          svc.publicRead,
          'SELECT * FROM story:ann_draft, story:ann_pending',
        ),
      ).toEqual([]);
    });

    it('cannot write anything: every write returns an empty result and changes nothing', async () => {
      const db = svc.publicRead;
      expect(
        await rows(db, `UPDATE publicStory:bob_live SET title = 'defaced'`),
      ).toEqual([]);
      expect(
        await rows(db, 'DELETE publicStory:bob_live RETURN BEFORE'),
      ).toEqual([]);
      expect(
        await rows(db, `CREATE user:sneak SET clerkUserId = 'user_sneak'`),
      ).toEqual([]);
      expect(
        await truth('SELECT VALUE title FROM publicStory:bob_live'),
      ).toEqual(['Story bob_live']);
      expect(await truth('SELECT * FROM user:sneak')).toEqual([]);
    });
  });

  describe('api_user (its own login, not a person session)', () => {
    it('cannot read, create or edit stories', async () => {
      const db = svc.apiUser;
      expect(await rows(db, 'SELECT * FROM story')).toEqual([]);
      expect(
        await rows(
          db,
          `CREATE story:forged CONTENT { submitter: user:ann, slug: 'forged', title: 'x',
             description: 'x', primaryFormat: 'written' }`,
        ),
      ).toEqual([]);
      expect(await truth('SELECT * FROM story:forged')).toEqual([]);
      expect(
        await rows(db, `UPDATE story:ann_draft SET title = 'edited'`),
      ).toEqual([]);
      expect(
        await rows(db, `UPDATE story:ann_draft SET submitter = user:bob`),
      ).toEqual([]);
      expect(
        await truth('SELECT title, submitter FROM story:ann_draft'),
      ).toEqual([{ title: 'Story ann_draft', submitter: 'user:ann' }]);
    });

    it('can delete a story (erasure) without being able to read it', async () => {
      await run(
        migrator,
        `CREATE story:throwaway CONTENT { submitter: user:ann, slug: 'throwaway', title: 'x',
           description: 'x', primaryFormat: 'written', body: 'x' }`,
      );
      await run(svc.apiUser, 'DELETE story:throwaway');
      expect(await truth('SELECT * FROM story:throwaway')).toEqual([]);
    });

    it('cannot read or forge consent', async () => {
      const db = svc.apiUser;
      const before = await truth('SELECT count() AS n FROM consent GROUP ALL');
      expect(await rows(db, 'SELECT * FROM consent')).toEqual([]);
      expect(
        await rows(
          db,
          `CREATE consent CONTENT { subject: user:ann, type: 'publish', event: 'granted',
             dpaVersion: dpaVersion:v1, mechanism: 'web_form_submission', evidenceHash: $h }`,
          { h: sha256('forged') },
        ),
      ).toEqual([]);
      expect(await truth('SELECT count() AS n FROM consent GROUP ALL')).toEqual(
        before,
      );
    });

    it('creates and updates user records, but cannot rebind clerkUserId', async () => {
      const db = svc.apiUser;
      expect(await ids(db, 'SELECT id FROM user')).toEqual([
        'user:ann',
        'user:bob',
        'user:moderator',
      ]);
      // Rebinding is refused by the user_clerk_binding event (D37: api_user may only clear it,
      // once, at erasure, in the same update that sets gdprDeletedAt).
      expect(
        await outcome(db, `UPDATE user:ann SET clerkUserId = 'user_attacker'`),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('clerkUserId can only be'),
      });
      expect(
        await outcome(db, 'UPDATE user:ann SET clerkUserId = NONE'),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('clerkUserId can only be'),
      });
      expect(
        await outcome(db, 'UPDATE user:ann SET gdprDeletedAt = time::now()'),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('without a clerkUserId'),
      });
      expect(
        await truth('SELECT clerkUserId, gdprDeletedAt FROM user:ann'),
      ).toEqual([{ clerkUserId: 'user_ann' }]);
      expect(await rows(db, 'DELETE user:bob RETURN BEFORE')).toEqual([]);
      expect(await truth('SELECT id FROM user:bob')).toHaveLength(1);
    });

    it('can create but not read audit rows; owns idempotency keys; cannot moderate', async () => {
      const db = svc.apiUser;
      // GOTCHA: an ALLOWED create on a table the caller can't select also returns an empty
      // result. Here the row was written; only the migrator's view shows it.
      expect(
        await rows(
          db,
          `CREATE auditLog CONTENT { service: 'api-user', action: 'CreateDraftStory', entity: story:ann_draft }`,
        ),
      ).toEqual([]);
      expect(
        await truth(
          `SELECT VALUE action FROM auditLog WHERE service = 'api-user'`,
        ),
      ).toEqual(['CreateDraftStory']);
      expect(await rows(db, 'SELECT * FROM auditLog')).toEqual([]);
      expect(
        await rows(
          db,
          `CREATE idempotencyKey:['api-user', user:ann, 'k1'] SET requestHash = 'h', status = 201`,
        ),
      ).toHaveLength(1);
      expect(await rows(db, 'SELECT * FROM idempotencyKey')).toHaveLength(1);
      expect(
        await rows(db, `UPDATE story:bob_pending SET status = 'approved'`),
      ).toEqual([]);
      expect(
        await rows(
          db,
          `CREATE publicStory:ann_pending CONTENT { version: 1, slug: 'x', title: 'x',
             description: 'x', primaryFormat: 'written', themeRefs: [], media: [], publishedAt: time::now() }`,
        ),
      ).toEqual([]);
      expect(await rows(db, 'SELECT * FROM moderationReview')).toEqual([]);
      expect(await truth('SELECT VALUE status FROM story:bob_pending')).toEqual(
        ['pending'],
      );
      expect(await truth('SELECT * FROM publicStory:ann_pending')).toEqual([]);
    });
  });

  describe('api_admin', () => {
    it('reads every story, the consent ledger, reviews and the audit log', async () => {
      const db = svc.admin;
      expect(await ids(db, 'SELECT id FROM story')).toEqual([
        'story:ann_draft',
        'story:ann_pending',
        'story:bob_draft',
        'story:bob_live',
        'story:bob_pending',
      ]);
      expect((await rows(db, 'SELECT * FROM consent')).length).toBe(8);
      expect(await rows(db, 'SELECT * FROM moderationReview')).toHaveLength(1);
      expect((await rows(db, 'SELECT * FROM auditLog')).length).toBeGreaterThan(
        0,
      );
    });

    it('moderates: request changes on a pending story', async () => {
      const [after] = await rows(
        svc.admin,
        `UPDATE story:ann_pending SET status = 'changes_requested',
           rejectionFeedback = 'Please add more detail' RETURN status, rejectionFeedback`,
      );
      expect(after).toEqual({
        status: 'changes_requested',
        rejectionFeedback: 'Please add more detail',
      });
      // Put it back for the other tests.
      await run(svc.admin, `UPDATE story:ann_pending SET status = 'pending'`);
    });

    it('cannot write consent for a person', async () => {
      expect(
        await rows(
          svc.admin,
          `CREATE consent CONTENT { subject: user:ann, type: 'publish', event: 'withdrawn',
             dpaVersion: dpaVersion:v1, mechanism: 'account_settings', evidenceHash: $h }`,
          { h: sha256('admin forged') },
        ),
      ).toEqual([]);
      expect(
        await truth(
          `SELECT * FROM consent WHERE subject = user:ann AND event = 'withdrawn'`,
        ),
      ).toEqual([]);
    });

    it('manages DPA versions; published ones are frozen, none can be deleted', async () => {
      const db = svc.admin;
      expect(await ids(db, 'SELECT id FROM dpaVersion')).toContain(
        'dpaVersion:v2_draft',
      );
      const edit = await outcome(
        db,
        `UPDATE dpaVersion:v1 SET changeSummary = 'rewritten'`,
      );
      expect(edit).toEqual({
        ok: false,
        error: expect.stringContaining(
          'published privacy policy versions are kept for ever',
        ),
      });
      expect(
        await rows(db, 'DELETE dpaVersion:v2_draft RETURN BEFORE'),
      ).toEqual([]);
      expect(await truth('SELECT id FROM dpaVersion:v2_draft')).toHaveLength(1);
    });

    it('links a legacy person to a Clerk account once; the binding never changes after', async () => {
      const db = svc.admin;
      await run(migrator, 'CREATE user:legacy1');
      await run(db, `UPDATE user:legacy1 SET clerkUserId = 'user_legacy1'`);
      expect(await truth('SELECT VALUE clerkUserId FROM user:legacy1')).toEqual(
        ['user_legacy1'],
      );
      expect(
        await outcome(db, `UPDATE user:legacy1 SET clerkUserId = 'user_other'`),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('clerkUserId can only be linked once'),
      });
    });
  });

  describe('workflow', () => {
    it('reads and updates stories (M7 media), but cannot create, delete or publish them', async () => {
      const db = svc.workflow;
      expect((await ids(db, 'SELECT id FROM story')).length).toBe(5);
      // A video story (D53: only video and audio stories have media), as its upload left it.
      await run(
        migrator,
        `UPDATE story:bob_pending SET primaryFormat = 'video',
           media = [{ format: 'video', bunnyVideoId: 'vid-0' }]`,
      );
      const [updated] = await rows(
        db,
        `UPDATE story:bob_pending SET media[0].processing = 'processing' RETURN media`,
      );
      expect(updated).toEqual({
        media: [
          { format: 'video', bunnyVideoId: 'vid-0', processing: 'processing' },
        ],
      });
      expect(
        await rows(
          db,
          `CREATE story:wf CONTENT { submitter: user:ann, slug: 'wf', title: 'x',
             description: 'x', primaryFormat: 'written' }`,
        ),
      ).toEqual([]);
      expect(await rows(db, 'DELETE story:bob_draft RETURN BEFORE')).toEqual(
        [],
      );
      expect(
        await rows(
          db,
          `CREATE publicStory:bob_pending CONTENT { version: 1, slug: 'x', title: 'x',
             description: 'x', primaryFormat: 'written', themeRefs: [], media: [], publishedAt: time::now() }`,
        ),
      ).toEqual([]);
      expect(
        await truth('SELECT * FROM story:wf, publicStory:bob_pending'),
      ).toEqual([]);
      expect(await truth('SELECT id FROM story:bob_draft')).toHaveLength(1);
    });

    it('reads consent (fresh ledger check before processing, D21) but cannot write it', async () => {
      const db = svc.workflow;
      expect((await rows(db, 'SELECT * FROM consent')).length).toBe(8);
      expect(
        await rows(
          db,
          `CREATE consent CONTENT { subject: user:bob, type: 'publish', event: 'granted',
             dpaVersion: dpaVersion:v1, mechanism: 'web_form_submission', evidenceHash: $h }`,
          { h: sha256('wf forged') },
        ),
      ).toEqual([]);
    });

    it('writes audit rows but cannot read them; cannot see drafts DPA or reviews', async () => {
      const db = svc.workflow;
      expect(
        await rows(
          db,
          `CREATE auditLog CONTENT { service: 'workflow', action: 'ProcessMedia' }`,
        ),
      ).toEqual([]); // written, but not readable back (see the api_user audit test)
      expect(
        await truth(
          `SELECT VALUE action FROM auditLog WHERE service = 'workflow'`,
        ),
      ).toEqual(['ProcessMedia']);
      expect(await rows(db, 'SELECT * FROM auditLog')).toEqual([]);
      expect(await rows(db, 'SELECT * FROM moderationReview')).toEqual([]);
      expect(await ids(db, 'SELECT id FROM dpaVersion')).not.toContain(
        'dpaVersion:v2_draft',
      );
    });
  });

  describe('the consent ledger is append-only for every identity', () => {
    it.each(['publicRead', 'apiUser', 'admin', 'workflow'] as const)(
      '%s cannot update or delete consent rows',
      async (name) => {
        const db = svc[name];
        const before = await truth('SELECT * FROM consent ORDER BY id');
        expect(
          await rows(db, `UPDATE consent SET event = 'withdrawn'`),
        ).toEqual([]);
        expect(await rows(db, 'DELETE consent RETURN BEFORE')).toEqual([]);
        expect(await truth('SELECT * FROM consent ORDER BY id')).toEqual(
          before,
        );
      },
    );

    it('even the migrator (OWNER) is stopped by the append-only event', async () => {
      const [first] = await truth<{ id: string }>(
        'SELECT id FROM consent LIMIT 1',
      );
      expect(
        await outcome(
          migrator,
          `UPDATE type::record($id) SET event = 'withdrawn'`,
          {
            id: first.id,
          },
        ),
      ).toEqual({ ok: false, error: expect.stringContaining('append-only') });
      expect(
        await outcome(migrator, `DELETE type::record($id)`, { id: first.id }),
      ).toEqual({ ok: false, error: expect.stringContaining('append-only') });
    });
  });
});

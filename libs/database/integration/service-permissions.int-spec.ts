import type { Surreal } from 'surrealdb';
import {
  LEGAL_TABLES,
  outcome,
  publishVersion,
  rows,
  run,
  SERVICES,
  TestDatabase,
} from './support/harness';
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
    it('reads publicStory, and the four legal texts with every version', async () => {
      const db = svc.publicRead;
      expect(await ids(db, 'SELECT id FROM publicStory')).toEqual([
        'publicStory:bob_live',
      ]);
      for (const table of LEGAL_TABLES) {
        expect(
          await rows(db, `SELECT VALUE id FROM type::table($table)`, { table }),
        ).toEqual([`${table}:0`]); // version 0, seeded by the migration (data/0009)
      }
    });

    it('never learns who published a legal text: a version is its text and date only', async () => {
      const version = await publishVersion(t, 'privacyNotice', 'Version one');
      // api-admin's publish writes this audit row in the same transaction (PublishLegalVersion).
      await run(
        svc.admin,
        `CREATE auditLog CONTENT { service: 'api-admin', action: 'PublishLegalVersion',
           actor: user:moderator, actorRole: 'Admin', entity: type::record('privacyNotice', $version) }`,
        { version },
      );
      const read = await rows<Record<string, unknown>>(
        svc.publicRead,
        `SELECT * FROM privacyNotice ORDER BY id`,
      );
      expect(read.map((r) => Object.keys(r).sort())).toEqual([
        ['content', 'id', 'release_date'],
        ['content', 'id', 'release_date'],
      ]);
      expect(read[1]).toMatchObject({ content: 'Version one' });
      expect(
        await rows(
          svc.publicRead,
          `SELECT * FROM auditLog WHERE action = 'PublishLegalVersion'`,
        ),
      ).toEqual([]);
      expect(
        await truth(
          `SELECT VALUE actor FROM auditLog WHERE action = 'PublishLegalVersion'`,
        ),
      ).toEqual(['user:moderator']);
    });

    it.each([
      'story',
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
        // Erasure is one command: the Clerk id and the agreements go with it (fn::account::erase).
        error: expect.stringMatching(/without a clerkUserId|agreement_kept/),
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
    it('reads every story, reviews and the audit log', async () => {
      const db = svc.admin;
      expect(await ids(db, 'SELECT id FROM story')).toEqual([
        'story:ann_draft',
        'story:ann_pending',
        'story:bob_draft',
        'story:bob_live',
        'story:bob_pending',
      ]);
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

    it('writes audit rows but cannot read them; cannot see reviews', async () => {
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
    });
  });

  // Plan 4e: the legal texts and the pointers to them (agreements.int-spec.ts has the rules).
  describe('the legal texts and agreements, for every service', () => {
    it.each(LEGAL_TABLES)(
      '%s: only api_admin creates a version; no service changes or deletes one',
      async (table) => {
        const before = await truth(`SELECT * FROM type::table($table)`, {
          table,
        });
        const next = before.length;
        for (const name of SERVICES) {
          const db = await t.service(name);
          if (name !== 'api_admin') {
            await outcome(
              db,
              `CREATE type::record($table, $next) CONTENT { content: 'Forged' }`,
              { table, next },
            );
          }
          for (const sql of [
            `UPDATE type::record($table, 0) SET content = 'Changed'`,
            `UPSERT type::record($table, 0) CONTENT { content: 'Changed' }`,
            `DELETE type::record($table, 0)`,
          ]) {
            await outcome(db, sql, { table });
          }
        }
        expect(await truth(`SELECT * FROM type::table($table)`, { table })).toEqual(
          before,
        );
        if (table !== 'privacyNotice') {
          expect(await publishVersion(t, table)).toBe(next);
        }
      },
    );

    it('no service sets or moves a person’s agreements, or a story’s sharing consent', async () => {
      // The moderator's record has agreed to nothing, and Ann's draft isn't shared.
      for (const name of SERVICES) {
        const db = await t.service(name);
        await outcome(
          db,
          `UPDATE user:moderator SET
             termsOfUse = fn::legal::latest('termsOfUseAgreement'), termsOfUseAgreedAt = time::now(),
             testimonyConsent = fn::legal::latest('testimonyConsent'),
             testimonyConsentAgreedAt = time::now()`,
        );
        await outcome(
          db,
          `UPDATE user:ann SET termsOfUse = NONE, termsOfUseAgreedAt = NONE`,
        );
        await outcome(
          db,
          `UPDATE story:ann_draft SET
             socialMediaSharingConsent = fn::legal::latest('socialMediaSharingConsent'),
             socialMediaSharingConsentAgreedAt = time::now()`,
        );
      }
      expect(
        await truth(
          `SELECT termsOfUse, testimonyConsent FROM ONLY user:moderator`,
        ),
      ).toEqual([{}]);
      expect(
        await truth(`SELECT VALUE termsOfUse != NONE FROM ONLY user:ann`),
      ).toEqual([true]);
      expect(
        await truth(
          `SELECT VALUE socialMediaSharingConsent FROM ONLY story:ann_draft`,
        ),
      ).toEqual([]);
    });
  });
});

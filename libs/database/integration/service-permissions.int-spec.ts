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
import {
  buildWorld,
  draft,
  grantImage,
  statusOf,
  step,
  submit,
} from './support/world';

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
    it('reads approved stories, and the four legal texts with every version', async () => {
      const db = svc.publicRead;
      expect(await ids(db, 'SELECT id FROM story')).toEqual(['story:bob_live']);
      for (const table of LEGAL_TABLES) {
        expect(
          await rows(db, `SELECT VALUE id FROM type::table($table)`, { table }),
        ).toEqual([`${table}:0`]); // version 0, seeded by the migration (data/0009)
      }
    });

    it('never learns who published a legal text: a version is its text and date only', async () => {
      const version = await publishVersion(t, 'privacyNotice', 'Version one');
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
          `SELECT VALUE publishedBy FROM type::record('privacyNotice', $version)`,
          { version },
        ),
      ).toEqual([undefined]);
      // R3: api-admin (and the migrator) see who published it.
      for (const db of [svc.admin, migrator]) {
        expect(
          await rows(
            db,
            `SELECT VALUE publishedBy FROM type::record('privacyNotice', $version)`,
            { version },
          ),
        ).toEqual(['user:legal_admin']);
      }
    });

    it.each([
      'user',
      'hiddenStory',
      'idempotencyKey',
      '_migration',
      '_migrationRun',
      '_migrationPending',
      '_identity',
    ])('sees nothing in %s', async (table) => {
      expect(await rows(svc.publicRead, `SELECT * FROM ${table}`)).toEqual([]);
      expect(
        (await truth(`SELECT count() FROM ${table} GROUP ALL`)).length,
      ).toBe(1);
    });

    it('cannot write anything: every write returns an empty result and changes nothing', async () => {
      const db = svc.publicRead;
      expect(
        await rows(db, `UPDATE story:bob_live SET title = 'defaced'`),
      ).toEqual([]);
      expect(await rows(db, 'DELETE story:bob_live RETURN BEFORE')).toEqual([]);
      expect(
        await rows(
          db,
          `CREATE storyStatusLog CONTENT { story: story:bob_pending, status: 'approved' }`,
        ),
      ).toEqual([]);
      expect(
        await rows(db, `CREATE user:sneak SET clerkUserId = 'user_sneak'`),
      ).toEqual([]);
      expect(await truth('SELECT VALUE title FROM story:bob_live')).toEqual([
        'Story bob_live',
      ]);
      expect(await statusOf(migrator, 'bob_pending')).toBe('pending');
      expect(await truth('SELECT * FROM user:sneak')).toEqual([]);
    });
  });

  describe('api_user (its own login, not a person session)', () => {
    it('reads only what everyone reads; cannot create or edit stories', async () => {
      const db = svc.apiUser;
      expect(await ids(db, 'SELECT id FROM story')).toEqual(['story:bob_live']);
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
      // once, at erasure, in the same update that sets the status to deleted).
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
        await outcome(db, `UPDATE user:ann SET status = 'deleted'`),
      ).toEqual({
        ok: false,
        // Erasure is one command: the Clerk id and the agreements go with it (fn::account::erase).
        error: expect.stringMatching(/without a clerkUserId|agreement_kept/),
      });
      expect(await truth('SELECT clerkUserId, status FROM user:ann')).toEqual([
        { clerkUserId: 'user_ann', status: 'active' },
      ]);
      expect(await rows(db, 'DELETE user:bob RETURN BEFORE')).toEqual([]);
      expect(await truth('SELECT id FROM user:bob')).toHaveLength(1);
    });

    it('owns idempotency keys; cannot moderate', async () => {
      const db = svc.apiUser;
      expect(
        await rows(
          db,
          `CREATE idempotencyKey:['api-user', user:ann, 'k1'] SET requestHash = 'h', status = 201`,
        ),
      ).toHaveLength(1);
      expect(await rows(db, 'SELECT * FROM idempotencyKey')).toHaveLength(1);
      expect(
        await rows(
          db,
          `CREATE storyStatusLog CONTENT { story: story:bob_pending, status: 'in_review' }`,
        ),
      ).toEqual([]);
      expect(
        await rows(
          db,
          'SELECT * FROM storyStatusLog WHERE status != "approved"',
        ),
      ).toEqual([]);
      expect(await statusOf(migrator, 'bob_pending')).toBe('pending');
    });
  });

  describe('api_admin', () => {
    it('reads every story and status entry', async () => {
      const db = svc.admin;
      expect(await ids(db, 'SELECT id FROM story')).toEqual([
        'story:ann_draft',
        'story:ann_pending',
        'story:bob_draft',
        'story:bob_live',
        'story:bob_pending',
      ]);
      expect(await rows(db, 'SELECT * FROM storyStatusLog')).toHaveLength(5);
    });

    // R7 (Joel, 2026-11-04): erasure runs on api-user's login, so api-admin deletes none of these.
    it('cannot delete upload grants, submission log rows or status entries', async () => {
      const [version] = await truth<number>(
        'SELECT VALUE version FROM ONLY story:ann_draft',
      );
      expect(
        await grantImage(svc.apiUser, {
          story: 'ann_draft',
          person: 'ann',
          version: version as number,
        }),
      ).toMatchObject({ ok: true });
      await run(
        migrator,
        'CREATE submissionLog:r7 CONTENT { person: user:ann }',
      );
      const before = await truth<string[]>(
        'RETURN [(SELECT VALUE id FROM uploadGrant), (SELECT VALUE id FROM submissionLog), (SELECT VALUE id FROM storyStatusLog)]',
      );
      expect(before.map((ids) => ids.length > 0)).toEqual([true, true, true]);
      for (const table of ['uploadGrant', 'submissionLog', 'storyStatusLog']) {
        expect(await rows(svc.admin, `DELETE ${table} RETURN BEFORE`)).toEqual(
          [],
        );
      }
      expect(
        await truth(
          'RETURN [(SELECT VALUE id FROM uploadGrant), (SELECT VALUE id FROM submissionLog), (SELECT VALUE id FROM storyStatusLog)]',
        ),
      ).toEqual(before);
    });

    it('moderates through the status log only, naming the moderator (R6)', async () => {
      await draft(await t.person('user_ann'), 'ann_mod');
      await submit(await t.person('user_ann'), 'ann_mod');
      // Not straight from pending to a decision: a moderator picks it up first.
      expect(
        await outcome(
          svc.admin,
          `CREATE storyStatusLog CONTENT { story: story:ann_mod, status: 'approved', by: user:moderator }`,
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('status_step'),
      });
      // Every moderator entry names the moderator.
      expect(
        await outcome(
          svc.admin,
          `CREATE storyStatusLog CONTENT { story: story:ann_mod, status: 'in_review' }`,
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('names the moderator'),
      });
      expect(await step(svc.admin, 'ann_mod', 'in_review')).toHaveLength(1);
      const [entry] = await step(svc.admin, 'ann_mod', 'changes_requested', {
        comment: 'Please add more detail',
        actor: 'person',
      });
      expect(entry).toMatchObject({
        status: 'changes_requested',
        actor: 'moderator',
        by: 'user:moderator',
        comment: 'Please add more detail',
      });
      expect(await statusOf(migrator, 'ann_mod')).toBe('changes_requested');
      // The story itself: api-admin can't write its words or its status pointer.
      await run(
        svc.admin,
        `UPDATE story:ann_mod SET title = 'moderator words', currentStatus = NONE`,
      );
      expect(
        await truth(
          'SELECT title, fn::story::status_of($this) AS status FROM story:ann_mod',
        ),
      ).toEqual([{ title: 'Story ann_mod', status: 'changes_requested' }]);
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
      expect(
        (await ids(db, 'SELECT id FROM story')).length,
      ).toBeGreaterThanOrEqual(5);
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
          `CREATE storyStatusLog CONTENT { story: story:bob_pending, status: 'in_review' }`,
        ),
      ).toEqual([]);
      expect(await truth('SELECT * FROM story:wf')).toEqual([]);
      expect(await statusOf(migrator, 'bob_pending')).toBe('pending');
      expect(await truth('SELECT id FROM story:bob_draft')).toHaveLength(1);
    });

    it('sees only the status entries everyone sees', async () => {
      const db = svc.workflow;
      expect(
        await rows(
          db,
          `SELECT * FROM storyStatusLog WHERE status != 'approved'`,
        ),
      ).toEqual([]);
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
        expect(
          await truth(`SELECT * FROM type::table($table)`, { table }),
        ).toEqual(before);
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

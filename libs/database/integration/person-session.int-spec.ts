import { RecordId, type Surreal } from 'surrealdb';
import {
  createPeople,
  LEGAL_TABLES,
  outcome,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import {
  newSigningKeys,
  signHs256WithPublicKey,
  signRs256,
  clerkClaims,
} from './support/jwt';
import {
  approve,
  buildWorld,
  draft,
  ERASE,
  grantImage,
  statusOf,
  step,
  submit,
  edit,
} from './support/world';

/**
 * D27 B: a person's reads and commands run in a SurrealDB session opened with their Clerk
 * session token (DEFINE ACCESS clerk, RS256, pinned PEM key), so the database itself
 * enforces ownership.
 */
describe('person sessions via Clerk JWT (D27 B)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let ann: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);
  const ids = async (db: Surreal, sql: string) =>
    (await rows<{ id: string }>(db, sql)).map((r) => r.id).sort();

  beforeAll(async () => {
    t = await TestDatabase.create();
    ({ admin, ann } = await buildWorld(t));
    migrator = await t.migrator();
    await createPeople(t, { cara: 'user_cara', erased: 'user_erased' });
  });
  afterAll(() => t?.close());

  describe('token checks', () => {
    const claims = (sub: string, extra: Record<string, unknown> = {}) =>
      clerkClaims(sub, {
        namespace: t.namespace,
        database: t.database,
        claims: extra,
      });
    const authenticateWith = async (token: string) => {
      const db = await t.connect();
      await db.authenticate(token);
      return rows(db, 'RETURN [$auth, $access, $token.sub]');
    };

    it('maps a valid token’s sub to the user record', async () => {
      expect(await authenticateWith(t.token('user_ann'))).toEqual([
        'user:ann',
        'clerk',
        'user_ann',
      ]);
    });

    it.each<[string, () => string]>([
      ['an expired token', () => t.token('user_ann', { expiresIn: -10 })],
      [
        'a token signed with another key',
        () => signRs256(claims('user_ann'), newSigningKeys().privateKey),
      ],
      ['ac = svc', () => t.token('user_ann', { claims: { ac: 'svc' } })],
      ['an unknown ac', () => t.token('user_ann', { claims: { ac: 'nope' } })],
      ['an unknown sub', () => t.token('user_nobody')],
      [
        'another database',
        () => t.token('user_ann', { claims: { db: 'other' } }),
      ],
      [
        'no exp claim',
        () =>
          signRs256(
            { ...claims('user_ann'), exp: undefined },
            t.keys.privateKey,
          ),
      ],
      [
        'HS256 signed with the public key (algorithm confusion)',
        () => signHs256WithPublicKey(claims('user_ann'), t.keys.publicKeyPem),
      ],
      [
        'a tampered payload (sub changed after signing)',
        () => {
          const [h, , s] = t.token('user_ann').split('.');
          const p = Buffer.from(JSON.stringify(claims('user_bob'))).toString(
            'base64url',
          );
          return `${h}.${p}.${s}`;
        },
      ],
    ])('rejects %s', async (_, token) => {
      await expect(authenticateWith(token())).rejects.toThrow();
    });

    it('rejects an erased person (status deleted)', async () => {
      await run(
        await t.service('api_user'),
        `UPDATE user:erased SET status = 'deleted', clerkUserId = NONE`,
      );
      await expect(authenticateWith(t.token('user_erased'))).rejects.toThrow();
    });

    it('does not check iss or azp: the pinned key is what ties tokens to the Clerk instance', async () => {
      expect(
        await authenticateWith(
          t.token('user_ann', {
            claims: {
              iss: 'https://other.example',
              azp: 'https://evil.example',
            },
          }),
        ),
      ).toEqual(['user:ann', 'clerk', 'user_ann']);
    });

    it('ignores an id claim: AUTHENTICATE decides the record', async () => {
      expect(
        await authenticateWith(
          t.token('user_ann', { claims: { id: 'user:bob' } }),
        ),
      ).toEqual(['user:ann', 'clerk', 'user_ann']);
    });
  });

  describe('reads', () => {
    it('sees their own stories, drafts and pending included, and others’ approved ones', async () => {
      expect(await ids(ann, 'SELECT id FROM story')).toEqual([
        'story:ann_draft',
        'story:ann_pending',
        'story:bob_live',
      ]);
    });

    it('sees someone else’s story only while it is approved, and only its published fields (R11)', async () => {
      expect(
        await rows(ann, 'SELECT * FROM story:bob_draft, story:bob_pending'),
      ).toEqual([]);
      const [live] = await rows<Record<string, unknown>>(
        ann,
        'SELECT * FROM story:bob_live',
      );
      expect(live).toMatchObject({
        id: 'story:bob_live',
        title: 'Story bob_live',
      });
      for (const field of [
        'submitter',
        'createdAt',
        'socialMediaSharingConsent',
        'socialMediaSharingConsentAgreedAt',
      ]) {
        expect(live).not.toHaveProperty(field);
      }
      // Of Bob's log, only the story's current approved entry, and only its public fields.
      expect(
        await rows(
          ann,
          'SELECT * FROM storyStatusLog WHERE story = story:bob_live',
        ),
      ).toEqual([
        {
          id: expect.stringMatching(/^storyStatusLog:/),
          story: 'story:bob_live',
          status: 'approved',
          publishedAt: expect.any(String),
        },
      ]);
    });

    it('sees their own user record with their agreements, and the legal texts', async () => {
      const mine = await rows<Record<string, unknown>>(
        ann,
        'SELECT * FROM user',
      );
      expect(mine.map((r) => r['id'])).toEqual(['user:ann']); // never another person's
      expect(mine[0]).toMatchObject({
        termsOfUse: 'termsOfUseAgreement:0',
        testimonyConsent: 'testimonyConsent:0',
      });
      for (const table of LEGAL_TABLES) {
        expect(
          await rows(ann, `SELECT VALUE id FROM type::table($table)`, {
            table,
          }),
        ).toEqual([`${table}:0`]);
      }
      for (const table of ['pendingDeletion', 'idempotencyKey', 'service']) {
        expect(await rows(ann, `SELECT * FROM ${table}`)).toEqual([]);
      }
    });

    it('sees their own story’s status log, never who wrote an entry (R6, Art 15)', async () => {
      const bob = await t.person('user_bob');
      expect(
        (
          await rows<Record<string, unknown>>(
            bob,
            `SELECT action, status, actor, storyVersion, by, at, id FROM storyStatusLog
               WHERE story = story:bob_live ORDER BY at, id`,
          )
        ).map(({ at: _at, id: _id, ...entry }) => entry),
      ).toEqual([
        { action: 'sent', status: 'pending', actor: 'person', storyVersion: 1 },
        {
          action: 'approved',
          status: 'approved',
          actor: 'moderator',
          storyVersion: 2,
        },
      ]);
      // Bob's pending story's entries aren't Ann's to see.
      expect(
        await rows(
          ann,
          'SELECT * FROM storyStatusLog WHERE story = story:bob_pending',
        ),
      ).toEqual([]);
    });
  });

  describe('creating a draft', () => {
    it('creates a draft for themselves, with server-controlled fields', async () => {
      const [created] = await draft(ann, 'ann_new', {
        version: 99,
        createdAt: new Date('2020-01-01T00:00:00Z'),
        slugHistory: ['someone-elses-slug'],
      });
      expect(created).toMatchObject({
        id: 'story:ann_new',
        submitter: 'user:ann',
        version: 1,
        slugHistory: [],
      });
      expect(created['currentStatus']).toBeUndefined(); // a draft
      expect(Date.parse(String(created['createdAt']))).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });

    it('cannot create a story for someone else', async () => {
      expect(
        await rows(
          ann,
          `CREATE story:for_bob CONTENT { submitter: user:bob, slug: 'for_bob', title: 'x',
             description: 'x', primaryFormat: 'written' }`,
        ),
      ).toEqual([]);
      expect(await truth('SELECT * FROM story:for_bob')).toEqual([]);
    });

    it('cannot create a story with a status: its pointer is dropped, it is a draft being edited (R6)', async () => {
      const [created] = await draft(ann, 'ann_prefilled', {
        currentStatus: new RecordId('storyStatusLog', 'forged'),
      });
      expect(created).toBeDefined();
      expect(await statusOf(migrator, 'ann_prefilled')).toBe('editing');
    });
  });

  describe('editing', () => {
    it('edits their own draft; version increments', async () => {
      const [after] = await rows<{ title: string; version: number }>(
        ann,
        `UPDATE story:ann_draft SET title = 'Edited title' RETURN title, version`,
      );
      expect(after).toEqual({ title: 'Edited title', version: 2 });
    });

    it('cannot edit someone else’s story', async () => {
      expect(
        await rows(ann, `UPDATE story:bob_draft SET title = 'hijacked'`),
      ).toEqual([]);
      expect(await truth('SELECT VALUE title FROM story:bob_draft')).toEqual([
        'Story bob_draft',
      ]);
    });

    it('cannot reassign the submitter', async () => {
      const result = await outcome(
        ann,
        'UPDATE story:ann_draft SET submitter = user:bob',
      );
      expect(result.ok).toBe(false);
      expect(
        await truth('SELECT VALUE submitter FROM story:ann_draft'),
      ).toEqual(['user:ann']);
    });

    it('cannot move their story’s status pointer themselves (R6)', async () => {
      await run(
        ann,
        `UPDATE story:ann_draft SET currentStatus =
           (SELECT VALUE id FROM storyStatusLog WHERE story = story:ann_pending)[0]`,
      );
      expect(await statusOf(migrator, 'ann_draft')).toBe('editing');
    });

    it.each([
      'approved',
      'rejected',
      'changesRequested',
      'hiddenBySystem',
      'hiddenByModerator',
      'shownBySystem',
      'fileUnusable',
      'editStarted',
    ])('cannot add a %s entry to their own draft', async (action) => {
      const result = await outcome(
        ann,
        `CREATE storyStatusLog CONTENT { story: story:ann_draft, action: $action }`,
        { action },
      );
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('status_step'),
      });
      expect(await statusOf(migrator, 'ann_draft')).toBe('editing');
    });

    it('submits with a server-set time, version and actor (no backdating, no forging)', async () => {
      await draft(ann, 'ann_submit');
      const [entry] = await step(ann, 'ann_submit', 'sent', {
        at: new Date('2020-01-01T00:00:00Z'),
        actor: 'moderator',
        storyVersion: 99,
        by: new RecordId('user', 'bob'),
      });
      expect(entry).toMatchObject({
        action: 'sent',
        status: 'pending',
        actor: 'person',
        storyVersion: 1,
      });
      expect(Date.parse(String(entry['at']))).toBeGreaterThan(
        Date.now() - 60_000,
      );
      expect(
        await truth(
          'SELECT VALUE by FROM storyStatusLog WHERE story = story:ann_submit',
        ),
      ).toEqual(['user:ann']);
      expect(await statusOf(migrator, 'ann_submit')).toBe('pending');
    });

    it('cannot change or delete an entry, even their own (append-only)', async () => {
      await run(
        ann,
        `UPDATE storyStatusLog SET status = 'approved' WHERE story = story:ann_submit`,
      );
      await run(ann, `DELETE storyStatusLog WHERE story = story:ann_submit`);
      expect(
        await truth(
          'SELECT VALUE status FROM storyStatusLog WHERE story = story:ann_submit',
        ),
      ).toEqual(['pending']);
    });

    it('cannot edit content once submitted (content lock)', async () => {
      for (const set of [
        `title = 'changed after review'`,
        `body = 'changed'`,
        `themeRefs = [theme:doubt]`,
        `bylineName = 'Someone'`,
      ]) {
        const result = await outcome(
          ann,
          `UPDATE story:ann_pending SET ${set}`,
        );
        expect(result).toEqual({
          ok: false,
          error: expect.stringContaining('story content is locked'),
        });
      }
      expect(await truth('SELECT VALUE title FROM story:ann_pending')).toEqual([
        'Story ann_pending',
      ]);
    });

    it('can edit again after changes are requested, then resubmit', async () => {
      await step(admin, 'ann_submit', 'changesRequested', {
        comment: 'Please trim the start',
      });
      await run(ann, `UPDATE story:ann_submit SET title = 'Revised'`);
      expect(await submit(ann, 'ann_submit')).toHaveLength(1);
      expect(
        await truth(
          'SELECT title, fn::story::status_of($this) AS status FROM story:ann_submit',
        ),
      ).toEqual([{ title: 'Revised', status: 'pending' }]);
    });

    it('deletes their own story in every state, straight away (ED-3)', async () => {
      const statuses = [
        'draft',
        'pending',
        'approved',
        'hidden',
        'sentBack',
        'editing',
        'rejected',
      ];
      // The steps to each state, each by whoever may take it (R6).
      const path: Record<string, [Surreal | 'ann', string][]> = {
        draft: [],
        pending: [['ann', 'sent']],
        approved: [
          ['ann', 'sent'],
          [admin, 'approved'],
        ],
        hidden: [
          ['ann', 'sent'],
          [admin, 'approved'],
          [admin, 'hiddenByModerator'],
        ],
        sentBack: [
          ['ann', 'sent'],
          [admin, 'changesRequested'],
        ],
        editing: [
          ['ann', 'sent'],
          ['ann', 'editStarted'],
        ],
        rejected: [
          ['ann', 'sent'],
          [admin, 'rejected'],
        ],
      };
      for (const status of statuses) {
        await draft(ann, `ann_del_${status}`);
        for (const [who, to] of path[status]) {
          await step(who === 'ann' ? ann : who, `ann_del_${status}`, to);
        }
      }
      for (const status of statuses) {
        await rows(ann, `DELETE type::record('story', $id)`, {
          id: `ann_del_${status}`,
        });
      }
      expect(
        (
          await truth<string>(
            `SELECT VALUE fn::story::status_of($this) FROM story WHERE string::starts_with(record::id(id), 'ann_del_')`,
          )
        ).sort(),
      ).toEqual([]);
      // Someone else's story, never.
      expect(await rows(ann, 'DELETE story:bob_draft RETURN BEFORE')).toEqual(
        [],
      );
      expect(await truth('SELECT id FROM story:bob_draft')).toHaveLength(1);
    });
  });

  describe('editing a published story (Edit, ED-1)', () => {
    beforeAll(async () => {
      await draft(ann, 'ann_live');
      await submit(ann, 'ann_live');
      await approve(admin, 'ann_live');
    });

    it('cannot change a published story’s words without pressing Edit', async () => {
      const result = await outcome(
        ann,
        `UPDATE story:ann_live SET title = 'edited live'`,
      );
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('story content is locked'),
      });
      expect(await truth('SELECT VALUE title FROM story:ann_live')).toEqual([
        'Story ann_live',
      ]);
    });

    it('cannot take someone else’s story down to edit', async () => {
      expect(await edit(ann, 'bob_live')).toEqual([]);
      expect(await statusOf(migrator, 'bob_live')).toBe('approved');
    });

    it('Edit takes it off the site at once; it changes, goes back for review and keeps its first publication date', async () => {
      const reader = await t.service('api_public_read');
      const firstPublished = await truth(
        'SELECT VALUE currentStatus.publishedAt FROM story:ann_live',
      );
      expect(await rows(reader, 'SELECT id FROM story:ann_live')).toHaveLength(
        1,
      );
      const [entry] = await edit(ann, 'ann_live');
      expect(entry).toMatchObject({
        action: 'editStarted',
        status: 'editing',
        actor: 'person',
      });
      expect(await statusOf(migrator, 'ann_live')).toBe('editing');
      expect(await rows(reader, 'SELECT id FROM story:ann_live')).toEqual([]);
      // Its old approved entry is no longer anyone else's to read.
      expect(
        await rows(
          reader,
          'SELECT * FROM storyStatusLog WHERE story = story:ann_live',
        ),
      ).toEqual([]);
      // Pressing Edit again is refused: it is being edited already.
      expect(
        await outcome(
          ann,
          `CREATE storyStatusLog CONTENT { story: story:ann_live, action: 'editStarted' }`,
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('status_step'),
      });
      // Everything may change while editing (M3-6 A), and it goes back for review.
      await run(
        ann,
        `UPDATE story:ann_live SET title = 'Edited live', themeRefs = [theme:doubt]`,
      );
      expect(await submit(ann, 'ann_live')).toHaveLength(1);
      expect(await statusOf(migrator, 'ann_live')).toBe('pending');
      await approve(admin, 'ann_live');
      expect(
        await truth(
          'SELECT VALUE [title, currentStatus.publishedAt] FROM story:ann_live',
        ),
      ).toEqual([['Edited live', firstPublished[0]]]);
    });

    it('Edit works on a story waiting for review too (ED-4), and its log records a new picture without moving it', async () => {
      const apiUser = await t.service('api_user');
      const version = async () =>
        (await truth<number>('SELECT VALUE version FROM story:ann_hist'))[0];
      const log = () =>
        truth<{ action: string; status: string; actor: string }>(
          `SELECT action, status, actor, at FROM storyStatusLog WHERE story = story:ann_hist
             ORDER BY at`,
        ).then((r) =>
          r.map(({ action, status, actor }) => ({ action, status, actor })),
        );
      await draft(ann, 'ann_hist');
      // A draft's pictures are no history: it was never sent.
      expect(
        await grantImage(apiUser, {
          story: 'ann_hist',
          person: 'ann',
          version: await version(),
          name: '1'.repeat(32),
        }),
      ).toMatchObject({ ok: true });
      expect(await log()).toEqual([]);
      await submit(ann, 'ann_hist');
      expect(await edit(ann, 'ann_hist')).toHaveLength(1);
      expect(
        await grantImage(apiUser, {
          story: 'ann_hist',
          person: 'ann',
          version: await version(),
          name: '2'.repeat(32),
          expectedImage: `stories/ann_hist/${'1'.repeat(32)}.webp`,
        }),
      ).toMatchObject({ ok: true });
      expect(await log()).toEqual([
        { action: 'sent', status: 'pending', actor: 'person' },
        { action: 'editStarted', status: 'editing', actor: 'person' },
        { action: 'pictureReplaced', status: 'editing', actor: 'system' },
      ]);
      // The story's status is still the entry that moved it.
      expect(
        await truth('SELECT VALUE currentStatus.action FROM story:ann_hist'),
      ).toEqual(['editStarted']);
      // Nobody points a story at a history entry.
      expect(
        await outcome(
          migrator,
          `UPDATE story:ann_hist SET currentStatus = (SELECT VALUE id FROM storyStatusLog
             WHERE story = story:ann_hist AND action = 'pictureReplaced')[0]`,
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('moved it'),
      });
    });

    it('a rejected story can only be deleted: no Edit, no send', async () => {
      await draft(ann, 'ann_rejected');
      await submit(ann, 'ann_rejected');
      await step(admin, 'ann_rejected', 'rejected');
      for (const action of ['editStarted', 'sent']) {
        expect(
          await outcome(
            ann,
            `CREATE storyStatusLog CONTENT { story: story:ann_rejected, action: $action }`,
            { action },
          ),
        ).toMatchObject({
          ok: false,
          error: expect.stringContaining('status_step'),
        });
      }
      expect(await statusOf(migrator, 'ann_rejected')).toBe('rejected');
    });
  });

  describe('their own idempotency keys (D29; PR #41 review round 1)', () => {
    // A person's command commits its Idempotency-Key in the same transaction, in their session.
    const KEY = `idempotencyKey:['api-user', user:ann, 'ann-key-1']`;
    const create = (db: Surreal, id: string) =>
      rows(
        db,
        `CREATE ${id} CONTENT { requestHash: 'h', status: 201,
           response: { id: story:x, version: NONE } } RETURN id`,
      );

    it('creates and reads their own api-user key', async () => {
      expect(await create(ann, KEY)).toHaveLength(1);
      expect(await ids(ann, 'SELECT id FROM idempotencyKey')).toEqual([
        'idempotencyKey:[ s"api-user", r"user:ann", s"ann-key-1" ]',
      ]);
    });

    it('can’t create a key for someone else, another service or a webhook', async () => {
      for (const id of [
        `idempotencyKey:['api-user', user:bob, 'ann-forged']`,
        `idempotencyKey:['api-admin', user:ann, 'ann-admin']`,
        `idempotencyKey:['api-user', 'svix', 'ann-webhook']`,
      ]) {
        expect(await create(ann, id)).toEqual([]);
        expect(await truth(`SELECT * FROM ${id}`)).toEqual([]);
      }
    });

    it('can’t read other people’s keys', async () => {
      const bobKey = `idempotencyKey:['api-user', user:bob, 'bob-key-1']`;
      expect(await create(await t.service('api_user'), bobKey)).toHaveLength(1);
      expect(await rows(ann, `SELECT * FROM ${bobKey}`)).toEqual([]);
      expect(
        await rows(
          ann,
          `SELECT * FROM idempotencyKey WHERE record::id(id)[1] = user:bob`,
        ),
      ).toEqual([]);
    });

    it('can’t update or delete a key, even their own', async () => {
      await run(ann, `UPDATE ${KEY} SET requestHash = 'forged', status = 200`);
      await run(ann, `DELETE ${KEY}`);
      expect(await truth(`SELECT requestHash, status FROM ${KEY}`)).toEqual([
        { requestHash: 'h', status: 201 },
      ]);
    });

    it('can’t create one after erasure, from a session opened before it', async () => {
      const cara = await t.person('user_cara');
      await run(await t.service('api_user'), ERASE, {
        clerkUserId: 'user_cara',
        reason: 'account_deleted',
      });
      const id = `idempotencyKey:['api-user', user:cara, 'late']`;
      expect(
        (
          await outcome(
            cara,
            `CREATE ${id} SET requestHash = 'h', status = 201`,
          )
        ).ok
          ? await truth(`SELECT * FROM ${id}`)
          : [],
      ).toEqual([]);
    });
  });
});

import { RecordId, type Surreal } from 'surrealdb';
import {
  consentEvent,
  createPeople,
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
import { approve, buildWorld, draft, submit } from './support/world';

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

    it('rejects an erased person (gdprDeletedAt set)', async () => {
      await run(
        await t.service('api_user'),
        'UPDATE user:erased SET gdprDeletedAt = time::now(), clerkUserId = NONE',
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
    it('sees only their own stories, drafts and pending included', async () => {
      expect(await ids(ann, 'SELECT id FROM story')).toEqual([
        'story:ann_draft',
        'story:ann_pending',
      ]);
    });

    it('never sees anyone else’s stories in the write model, approved or not', async () => {
      expect(
        await rows(
          ann,
          'SELECT * FROM story:bob_draft, story:bob_pending, story:bob_live',
        ),
      ).toEqual([]);
      // Published stories are read through the read model instead.
      expect(await ids(ann, 'SELECT id FROM publicStory')).toEqual([
        'publicStory:bob_live',
      ]);
    });

    it('sees their own consent, user record and published DPAs only', async () => {
      expect(
        (
          await rows<{ subject: string }>(ann, 'SELECT subject FROM consent')
        ).map((r) => r.subject),
      ).toEqual(Array(4).fill('user:ann'));
      expect(await ids(ann, 'SELECT id FROM user')).toEqual(['user:ann']);
      expect(await ids(ann, 'SELECT id FROM dpaVersion')).not.toContain(
        'dpaVersion:v2_draft',
      );
      for (const table of [
        'moderationReview',
        'auditLog',
        'idempotencyKey',
        'service',
      ]) {
        expect(await rows(ann, `SELECT * FROM ${table}`)).toEqual([]);
      }
    });

    it('cannot read someone else’s consent through fn::consent::current', async () => {
      expect(
        await rows(ann, `RETURN fn::consent::current(user:bob, 'publish')`),
      ).toEqual([]);
      expect(
        await rows(
          ann,
          `RETURN fn::consent::current(user:ann, 'publish').event`,
        ),
      ).toEqual(['granted']);
    });

    it('sees the consent derived on their own story (D17)', async () => {
      const [story] = await rows<{
        consent: Record<string, { event: string }>;
      }>(ann, 'SELECT consent FROM story:ann_draft');
      expect(story.consent['religious'].event).toBe('granted');
      expect(story.consent['age18plus'].event).toBe('granted');
    });
  });

  describe('creating a draft', () => {
    it('creates a draft for themselves, with server-controlled fields', async () => {
      const [created] = await draft(ann, 'ann_new', {
        version: 99,
        createdAt: new Date('2020-01-01T00:00:00Z'),
        submittedAt: new Date('2020-01-01T00:00:00Z'),
      });
      expect(created).toMatchObject({
        id: 'story:ann_new',
        submitter: 'user:ann',
        status: 'draft',
        version: 1,
      });
      expect(created['submittedAt']).toBeUndefined();
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

    it.each(['pending', 'approved'])(
      'cannot create a story already %s',
      async (status) => {
        expect(await draft(ann, `ann_${status}_direct`, { status })).toEqual(
          [],
        );
        expect(await truth(`SELECT * FROM story:ann_${status}_direct`)).toEqual(
          [],
        );
      },
    );

    it('cannot pre-fill moderation fields', async () => {
      const [created] = await draft(ann, 'ann_prefilled', {
        approvedAt: new Date('2026-01-01T00:00:00Z'),
        rejectionFeedback: 'looks great',
        lockedBy: new RecordId('user', 'ann'),
        lockedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(created).toBeDefined();
      const [stored] = await truth<Record<string, unknown>>(
        'SELECT approvedAt, rejectionFeedback, lockedBy, lockedAt FROM story:ann_prefilled',
      );
      expect(stored).toEqual({});
    });

    it('needs current Art 9 consent (special_category_religious)', async () => {
      const cara = await t.person('user_cara');
      expect(await draft(cara, 'cara_no_consent')).toEqual([]);
      expect(await truth('SELECT * FROM story:cara_no_consent')).toEqual([]);

      expect(
        await consentEvent(cara, 'special_category_religious', 'granted'),
      ).toHaveLength(1);
      expect(await draft(cara, 'cara_consented')).toHaveLength(1);

      expect(
        await consentEvent(cara, 'special_category_religious', 'withdrawn'),
      ).toHaveLength(1);
      expect(await draft(cara, 'cara_withdrawn')).toEqual([]);
      expect(await truth('SELECT * FROM story:cara_withdrawn')).toEqual([]);
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

    it('cannot set moderation fields on their own story', async () => {
      await run(
        ann,
        `UPDATE story:ann_draft SET approvedAt = time::now(), rejectionFeedback = 'self-approved'`,
      );
      expect(
        await truth(
          'SELECT approvedAt, rejectionFeedback FROM story:ann_draft',
        ),
      ).toEqual([{}]);
    });

    it.each(['approved', 'in_review', 'rejected'])(
      'cannot move their own story to %s',
      async (status) => {
        const result = await outcome(
          ann,
          `UPDATE story:ann_draft SET status = $status`,
          { status },
        );
        expect(result).toEqual({
          ok: false,
          error: expect.stringContaining('status change not allowed'),
        });
        expect(await truth('SELECT VALUE status FROM story:ann_draft')).toEqual(
          ['draft'],
        );
      },
    );

    it('submits with a server-set submittedAt (no backdating)', async () => {
      await draft(ann, 'ann_submit');
      const [after] = await rows<{ status: string; submittedAt: string }>(
        ann,
        `UPDATE story:ann_submit SET status = 'pending', submittedAt = d'2020-01-01T00:00:00Z'
           RETURN status, submittedAt`,
      );
      expect(after.status).toBe('pending');
      expect(Date.parse(after.submittedAt)).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });

    it('cannot edit content once submitted (content lock)', async () => {
      for (const set of [
        `title = 'changed after review'`,
        `body = 'changed'`,
        `tagRefs = [tag:doubt]`,
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
      await run(
        admin,
        `UPDATE story:ann_submit SET status = 'changes_requested'`,
      );
      await run(ann, `UPDATE story:ann_submit SET title = 'Revised'`);
      await submit(ann, 'ann_submit');
      expect(await truth('SELECT title, status FROM story:ann_submit')).toEqual(
        [{ title: 'Revised', status: 'pending' }],
      );
    });

    it('cannot delete their own story (erasure runs on api_user’s login)', async () => {
      expect(await rows(ann, 'DELETE story:ann_draft RETURN BEFORE')).toEqual(
        [],
      );
      expect(await truth('SELECT id FROM story:ann_draft')).toHaveLength(1);
    });
  });

  describe('withdrawing a published story', () => {
    beforeAll(async () => {
      await draft(ann, 'ann_live');
      await submit(ann, 'ann_live');
      await approve(admin, 'ann_live');
    });

    it('cannot write the read model directly', async () => {
      expect(
        await rows(
          ann,
          `UPDATE publicStory:ann_live SET title = 'edited live'`,
        ),
      ).toEqual([]);
      expect(
        await rows(
          ann,
          `CREATE publicStory:ann_draft CONTENT { version: 1, slug: 'x', title: 'x',
             description: 'x', primaryFormat: 'written', tagRefs: [], media: [], publishedAt: time::now() }`,
        ),
      ).toEqual([]);
      expect(
        await truth('SELECT VALUE title FROM publicStory:ann_live'),
      ).toEqual(['Story ann_live']);
    });

    it('cannot unpublish someone else’s story', async () => {
      await run(ann, 'DELETE publicStory:bob_live');
      expect(await truth('SELECT id FROM publicStory:bob_live')).toHaveLength(
        1,
      );
    });

    it('withdraws their own: status withdrawn and the publicStory row deleted together', async () => {
      await run(
        ann,
        `BEGIN TRANSACTION;
         UPDATE story:ann_live SET status = 'withdrawn';
         DELETE publicStory:ann_live;
         COMMIT TRANSACTION;`,
      );
      expect(await truth('SELECT VALUE status FROM story:ann_live')).toEqual([
        'withdrawn',
      ]);
      expect(await truth('SELECT * FROM publicStory:ann_live')).toEqual([]);
    });
  });
});

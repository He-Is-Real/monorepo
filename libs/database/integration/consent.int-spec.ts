import type { Surreal } from 'surrealdb';
import {
  CONSENT_TYPES,
  consentEvent,
  createPeople,
  grantAll,
  LEGACY_SHA256,
  seedLegacyDpaFixture,
  outcome,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { draft } from './support/world';

type Consent = { event: string; dpaVersion: string } | null;
type StoryConsent = { id: string; publish: Consent; religious: Consent };

/**
 * D17: consent is per person; each story derives it (COMPUTED `story.consent` →
 * fn::consent::current over the append-only ledger). Plus the D20/D22 ledger rules.
 */
describe('consent ledger and derived story consent (D17, D20, D22)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let ann: Surreal;
  let bob: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);

  const summary = (c: Consent) => (c ? `${c.event}@${c.dpaVersion}` : 'none');
  /** Every story's derived publish consent, read in ONE multi-row query (the LIMIT-bug shape). */
  const derivedByStory = async (db: Surreal) =>
    Object.fromEntries(
      (
        await rows<StoryConsent>(
          db,
          'SELECT id, consent.publish AS publish FROM story ORDER BY id',
        )
      ).map((s) => [s.id, summary(s.publish)]),
    );
  /** The same, but with the stories read inside a subquery (the $parent-bug shape). */
  const derivedViaSubquery = async (db: Surreal) =>
    Object.fromEntries(
      (
        await rows<{ id: string; stories: Consent[] }>(
          db,
          `SELECT id, (SELECT VALUE consent.publish FROM story WHERE submitter = $parent.id) AS stories
             FROM user WHERE id IN [user:ann, user:bob] ORDER BY id`,
        )
      ).map((u) => [u.id, u.stories.map(summary)]),
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    await seedLegacyDpaFixture(t); // the D22 rules below; seed 0002 is gone (D44)
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cara: 'user_cara',
    });
    await publishDpa(t, 'v1');
    await publishDpa(t, 'v2');
    ann = await t.person('user_ann');
    bob = await t.person('user_bob');
    await grantAll(ann, 'v1');
    await grantAll(bob, 'v1');
    for (const id of ['a1', 'a2', 'a3']) await draft(ann, id);
    for (const id of ['b1', 'b2']) await draft(bob, id);
  });
  afterAll(() => t?.close());

  describe('derivation across people and stories (pins the working pattern)', () => {
    it('after grant: every story derives its own submitter’s consent', async () => {
      const expected = {
        'story:a1': 'granted@dpaVersion:v1',
        'story:a2': 'granted@dpaVersion:v1',
        'story:a3': 'granted@dpaVersion:v1',
        'story:b1': 'granted@dpaVersion:v1',
        'story:b2': 'granted@dpaVersion:v1',
      };
      expect(await derivedByStory(admin)).toEqual(expected);
      expect(await derivedByStory(await t.service('workflow'))).toEqual(
        expected,
      );
    });

    it('re-grant to a newer DPA moves every one of that person’s stories, immediately', async () => {
      await consentEvent(ann, 'publish', 'granted', 'v2');
      expect(await derivedByStory(admin)).toEqual({
        'story:a1': 'granted@dpaVersion:v2',
        'story:a2': 'granted@dpaVersion:v2',
        'story:a3': 'granted@dpaVersion:v2',
        'story:b1': 'granted@dpaVersion:v1',
        'story:b2': 'granted@dpaVersion:v1',
      });
    });

    it('withdrawal affects every one of that person’s stories, and only theirs', async () => {
      await consentEvent(bob, 'publish', 'withdrawn', 'v1');
      expect(await derivedByStory(admin)).toEqual({
        'story:a1': 'granted@dpaVersion:v2',
        'story:a2': 'granted@dpaVersion:v2',
        'story:a3': 'granted@dpaVersion:v2',
        'story:b1': 'withdrawn@dpaVersion:v1',
        'story:b2': 'withdrawn@dpaVersion:v1',
      });
      // Other consent types are independent.
      const [b1] = await rows<{ religious: Consent }>(
        admin,
        'SELECT consent.religious AS religious FROM story:b1',
      );
      expect(summary(b1.religious)).toBe('granted@dpaVersion:v1');
    });

    it('derives the same when stories are read inside a subquery', async () => {
      expect(await derivedViaSubquery(admin)).toEqual({
        'user:ann': Array(3).fill('granted@dpaVersion:v2'),
        'user:bob': Array(2).fill('withdrawn@dpaVersion:v1'),
      });
    });

    it('re-consent after withdrawal restores it', async () => {
      await consentEvent(bob, 'publish', 'granted', 'v2');
      expect((await derivedByStory(admin))['story:b2']).toBe(
        'granted@dpaVersion:v2',
      );
    });

    it('each person sees the derivation on their own stories', async () => {
      expect(await derivedByStory(ann)).toEqual({
        'story:a1': 'granted@dpaVersion:v2',
        'story:a2': 'granted@dpaVersion:v2',
        'story:a3': 'granted@dpaVersion:v2',
      });
    });
  });

  describe('SurrealDB 3.2.4 bugs (D17). If one of these fails after an upgrade, the bug is fixed: update docs/db-permissions.md and the schema.surql header', () => {
    it('a correlated subquery with ORDER BY … LIMIT 1 answers only the first row', async () => {
      const buggy = await rows<{ id: string; v?: string }>(
        migrator,
        `SELECT id, (SELECT VALUE dpaVersion FROM consent
             WHERE subject = $parent.submitter AND type = 'publish'
             ORDER BY occurredAt DESC LIMIT 1)[0] AS v
           FROM story ORDER BY id`,
      );
      // Correct is v2 for all five. 3.2.4 answers some rows with nothing and others with a
      // stale version, and which ones varies with the data, so pin only "wrong".
      expect(buggy.map((r) => r.v ?? null)).not.toEqual(
        Array(5).fill('dpaVersion:v2'),
      );
      expect(buggy.filter((r) => r.v === undefined).length).toBeGreaterThan(0);
      // The schema's workaround, array::last over ASC, is right for every row.
      const fixed = await rows<{ id: string; v?: string }>(
        migrator,
        `SELECT id, array::last((SELECT VALUE dpaVersion FROM consent
             WHERE subject = $parent.submitter AND type = 'publish'
             ORDER BY occurredAt ASC)) AS v
           FROM story ORDER BY id`,
      );
      expect(fixed.map((r) => r.v)).toEqual(Array(5).fill('dpaVersion:v2'));
    });

    it('inside a subquery, a COMPUTED field’s $parent is the outer record', async () => {
      await run(
        migrator,
        `DEFINE TABLE bugOwner SCHEMALESS; DEFINE TABLE bugItem SCHEMALESS;
         DEFINE FIELD viaParent ON bugItem COMPUTED $parent.owner;
         DEFINE FIELD viaField  ON bugItem COMPUTED owner;
         CREATE bugOwner:o1; CREATE bugItem:i1 SET owner = bugOwner:o1;`,
      );
      expect(
        await rows(migrator, 'SELECT viaParent, viaField FROM bugItem:i1'),
      ).toEqual([{ viaParent: 'bugOwner:o1', viaField: 'bugOwner:o1' }]);
      expect(
        await rows(
          migrator,
          `SELECT (SELECT VALUE viaParent FROM bugItem WHERE owner = $parent.id) AS viaParent,
                  (SELECT VALUE viaField FROM bugItem WHERE owner = $parent.id) AS viaField
             FROM bugOwner:o1`,
        ),
      ).toEqual([{ viaParent: [undefined], viaField: ['bugOwner:o1'] }]); // viaParent should be o1
      await run(migrator, 'REMOVE TABLE bugOwner; REMOVE TABLE bugItem;');
    });
  });

  describe('ledger rules', () => {
    it('is append-only for the person too (empty result, nothing changed)', async () => {
      const before = await truth(
        'SELECT * FROM consent WHERE subject = user:ann ORDER BY id',
      );
      expect(await rows(ann, `UPDATE consent SET event = 'withdrawn'`)).toEqual(
        [],
      );
      expect(await rows(ann, 'DELETE consent RETURN BEFORE')).toEqual([]);
      expect(
        await truth(
          'SELECT * FROM consent WHERE subject = user:ann ORDER BY id',
        ),
      ).toEqual(before);
    });

    it('records consent only for the person in session, at server time', async () => {
      expect(
        await rows(
          ann,
          `CREATE consent CONTENT { subject: user:bob, type: 'publish', event: 'withdrawn',
             dpaVersion: dpaVersion:v2, mechanism: 'account_settings', evidenceHash: $h }`,
          { h: LEGACY_SHA256 },
        ),
      ).toEqual([]);
      const [own] = await consentEvent(ann, 'share_socials', 'granted', 'v2', {
        occurredAt: new Date('2020-01-01T00:00:00Z'),
      });
      expect(Date.parse(String(own['occurredAt']))).toBeGreaterThan(
        Date.now() - 60_000,
      );
    });

    it('refuses consent against a draft DPA; accepts it once published (D20)', async () => {
      const cara = await t.person('user_cara');
      // dpaVersion:v1 in the seed is a draft; here the published v1/v2 exist, so make a v3 draft.
      await run(
        admin,
        `CREATE dpaVersion:v3 CONTENT { materiality: 'material', documentPath: 'v3.md', contentHash: $h }`,
        { h: LEGACY_SHA256 },
      );
      expect(
        await outcome(
          cara,
          `CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'granted',
             dpaVersion: dpaVersion:v3, mechanism: 'web_form_submission', evidenceHash: $h }`,
          { h: LEGACY_SHA256 },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('published DPA version'),
      });
      await publishDpa(t, 'v3');
      expect(await consentEvent(cara, 'publish', 'granted', 'v3')).toHaveLength(
        1,
      );
    });

    it.each<[string, string, Record<string, unknown>]>([
      ['mechanism legacy_import', 'v2', { mechanism: 'legacy_import' }],
      ['the legacy DPA', 'legacy-squarespace', {}],
      [
        'a legacyGivenAt date',
        'v2',
        { legacyGivenAt: new Date('2023-05-01T00:00:00Z') },
      ],
    ])(
      'refuses a person recording legacy consent: %s (D22)',
      async (_, dpa, rest) => {
        const result = await outcome(
          ann,
          `CREATE consent CONTENT object::extend({
           subject: $auth, type: 'publish', event: 'granted',
           dpaVersion: type::record('dpaVersion', $dpa),
           mechanism: 'web_form_submission', evidenceHash: $h }, $rest)`,
          { dpa, rest, h: LEGACY_SHA256 },
        );
        expect(result).toEqual({
          ok: false,
          error: expect.stringContaining('only be imported by the migrator'),
        });
      },
    );

    it('lets the migrator import a legacy person (the 0003 pattern) whose story derives it', async () => {
      await run(
        migrator,
        `CREATE user:legacy_1;
         FOR $t IN $types {
           CREATE consent CONTENT { subject: user:legacy_1, type: $t, event: 'granted',
             dpaVersion: dpaVersion:\`legacy-squarespace\`, mechanism: 'legacy_import',
             evidenceHash: $h, legacyGivenAt: d'2024-03-01T00:00:00Z' };
         };
         CREATE story:legacy_story CONTENT { submitter: user:legacy_1, slug: 'legacy-story',
           title: 'Legacy', description: 'From the prototype', primaryFormat: 'video', status: 'approved',
           media: [{ format: 'video', bunnyVideoId: 'legacy-video', width: 1080, height: 1920,
             durationSeconds: 90, processing: 'ready' }] };`,
        { types: [...CONSENT_TYPES], h: LEGACY_SHA256 },
      );
      const [story] = await rows<{ consent: Record<string, Consent> }>(
        admin,
        'SELECT consent FROM story:legacy_story',
      );
      expect(Object.values(story.consent).map(summary)).toEqual(
        Array(4).fill('granted@dpaVersion:⟨legacy-squarespace⟩'),
      );
    });
  });
});

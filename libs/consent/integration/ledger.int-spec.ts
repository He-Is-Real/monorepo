import {
  approve,
  createPeople,
  DPA_V1_SHA256,
  draft,
  publishDpa,
  rows,
  run,
  submit,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import {
  PersonSessionRefusedError,
  withPersonSession,
} from '@heisreal/database';
import { createHash } from 'node:crypto';
import type { Surreal, SurrealSession } from 'surrealdb';
import { ConsentChecker } from '../src/lib/consent-checker';
import {
  ConsentConflictError,
  ConsentLedger,
  evidenceHash,
} from '../src/lib/consent-ledger';
import {
  CONSENT_REQUIRED,
  CONSENT_TYPES,
  type ConsentMechanism,
  type ConsentType,
} from '../src/lib/consent.types';

/** sha256 of ["heisreal-consent-evidence/v1","v1","bbb…","publish","granted","web_form_submission"]. */
const FIXED_VECTOR =
  '742fa2d7efa880025031ba5410d3e85f63e1179b49f8680fe126e34001db62e0';

/**
 * The ledger service, the consent checks and person sessions against SurrealDB 3.2.4, on the
 * connections production uses: api-user's one service connection with a session per person
 * (D27), and api-admin's own login for submitter checks.
 */
describe('consent ledger (D17–D20) on SurrealDB', () => {
  let t: TestDatabase;
  let apiUser: Surreal;
  let admin: Surreal;
  const ledger = new ConsentLedger();
  let asAdmin: ConsentChecker;
  let asApiUser: ConsentChecker;

  /** Like a request in api-user: a fresh session as the person on the shared connection. */
  const as = <T>(
    clerkUserId: string,
    work: (s: SurrealSession) => Promise<T>,
  ) => withPersonSession(apiUser, t.token(clerkUserId), work);

  const ART9 = CONSENT_REQUIRED.createDraft.types;
  const PUBLISHABLE = CONSENT_REQUIRED.submitStory.types;

  beforeAll(async () => {
    t = await TestDatabase.create();
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cat: 'user_cat',
      moderator: 'user_mod',
    });
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    asAdmin = new ConsentChecker(admin);
    asApiUser = new ConsentChecker(apiUser);
  });
  afterAll(() => t?.close());

  describe('while DPA v1 is a draft (D20)', () => {
    it('refuses every grant, and nothing reaches the ledger', async () => {
      const err = await as('user_ann', (s) =>
        ledger.grant(s, {
          type: 'special_category_religious',
          dpaVersion: 'v1',
          mechanism: 'web_form_submission',
        }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsentConflictError);
      expect((err as ConsentConflictError).code).toBe(
        'dpa_version_not_in_force',
      );
      expect(await rows(await t.migrator(), 'SELECT * FROM consent')).toEqual(
        [],
      );
    });

    it('shows nothing granted, and every check fails', async () => {
      const state = await as('user_ann', (s) => ledger.state(s));
      expect(state.history).toEqual([]);
      expect(state.current.map((c) => [c.type, c.granted])).toEqual(
        CONSENT_TYPES.map((type) => [type, false]),
      );
      expect(await as('user_ann', (s) => asAdmin.callerHas(s, ART9))).toBe(
        false,
      );
    });
  });

  describe('once v1 is published', () => {
    beforeAll(() => publishDpa(t, 'v1'));

    it('grants each type in the person’s own session, with a reproducible evidence hash and no IP', async () => {
      for (const type of CONSENT_TYPES) {
        const outcome = await as('user_ann', (s) =>
          ledger.grant(s, {
            type,
            dpaVersion: 'v1',
            mechanism: 'web_form_submission',
          }),
        );
        expect(outcome).toEqual({
          id: expect.stringMatching(/^\w+$/),
          status: 201,
          replayed: false,
        });
      }
      const [v1] = await rows<{ contentHash: string }>(
        await t.migrator(),
        'SELECT contentHash FROM dpaVersion:v1',
      );
      const stored = await rows<Record<string, unknown>>(
        await t.migrator(),
        `SELECT * FROM consent WHERE subject = user:ann ORDER BY occurredAt`,
      );
      expect(stored).toHaveLength(4);
      for (const row of stored) {
        expect(Object.keys(row).sort()).toEqual([
          'dpaVersion',
          'event',
          'evidenceHash',
          'id',
          'mechanism',
          'occurredAt',
          'subject',
          'type',
        ]); // D19: no ipAddress, nothing else
        expect(row['evidenceHash']).toBe(
          evidenceHash({
            dpaVersion: 'v1',
            dpaContentHash: v1.contentHash,
            type: String(row['type']),
            event: 'granted',
            mechanism: 'web_form_submission',
          }),
        );
      }
    });

    it('derives the current state from the latest event (D17, D18)', async () => {
      const state = await as('user_ann', (s) => ledger.state(s));
      expect(state.current).toEqual(
        CONSENT_TYPES.map((type) => ({
          type,
          granted: true,
          dpaVersion: 'v1',
          occurredAt: expect.any(String),
          reconsentRequired: false,
        })),
      );
      expect(
        state.history.map((e) => [e.type, e.event, e.dpaVersion, e.mechanism]),
      ).toEqual(
        CONSENT_TYPES.map((type) => [
          type,
          'granted',
          'v1',
          'web_form_submission',
        ]),
      );
    });

    it('shows a person only their own ledger', async () => {
      const bob = await as('user_bob', (s) => ledger.state(s));
      expect(bob.history).toEqual([]);
      expect(bob.current.every((c) => !c.granted)).toBe(true);
    });

    it('checks the caller’s consent in their session: Ann yes, Bob no', async () => {
      expect(
        await as('user_ann', (s) => asAdmin.callerHas(s, PUBLISHABLE)),
      ).toBe(true);
      expect(await as('user_bob', (s) => asAdmin.callerHas(s, ART9))).toBe(
        false,
      );
    });

    it('refuses a grant against a version that isn’t in force', async () => {
      await run(
        admin,
        `CREATE dpaVersion:v9 CONTENT { materiality: 'material', documentPath: 'libs/legal/dpa/v9.md', contentHash: $h }`,
        { h: 'f'.repeat(64) },
      ); // a draft
      for (const dpaVersion of ['v9', 'nope']) {
        await expect(
          as('user_bob', (s) =>
            ledger.grant(s, {
              type: 'publish',
              dpaVersion,
              mechanism: 'account_settings',
            }),
          ),
        ).rejects.toBeInstanceOf(ConsentConflictError);
      }
    });
  });

  describe('a published story (submitter checks, withdrawal)', () => {
    beforeAll(async () => {
      const ann = await t.person('user_ann');
      expect(await draft(ann, 'ann_live', { tagRefs: [] })).toHaveLength(1);
      await submit(ann, 'ann_live');
      await approve(admin, 'ann_live');
      expect(
        await rows(admin, 'SELECT id FROM publicStory:ann_live'),
      ).toHaveLength(1);
    });

    it('checks the submitter’s current consent on api-admin’s login (approve, D21)', async () => {
      expect(await asAdmin.submitterHas('ann_live', PUBLISHABLE)).toBe(true);
      expect(await asAdmin.submitterHas('no_such_story', ART9)).toBe(false);
    });

    it('fails closed on api-user’s login, which can’t read stories or the ledger', async () => {
      expect(await asApiUser.submitterHas('ann_live', ART9)).toBe(false);
    });

    it('withdrawing publish unpublishes every story of the person in the same transaction', async () => {
      const { id, status } = await as('user_ann', (s) =>
        ledger.withdraw(s, 'publish'),
      );
      expect(id).toMatch(/^\w+$/);
      expect(status).toBe(202);
      expect(await rows(admin, 'SELECT id FROM publicStory:ann_live')).toEqual(
        [],
      );
      // The story itself stays (re-consent + re-approval brings it back; erasure is D39).
      expect(await rows(admin, 'SELECT status FROM story:ann_live')).toEqual([
        { status: 'approved' },
      ]);
      const state = await as('user_ann', (s) => ledger.state(s));
      const publish = state.current.find((c) => c.type === 'publish');
      expect(publish).toMatchObject({ granted: false, dpaVersion: 'v1' });
      expect(state.history.at(-1)).toMatchObject({
        type: 'publish',
        event: 'withdrawn',
        mechanism: 'account_settings',
      });
      expect(await asAdmin.submitterHas('ann_live', PUBLISHABLE)).toBe(false);
      expect(await asAdmin.submitterHas('ann_live', ART9)).toBe(true);
    });

    it('re-publishing is refused by the database while publish is withdrawn', async () => {
      await expect(approve(admin, 'ann_live')).rejects.toThrow();
    });

    it('withdrawing again re-affirms it; never-granted consent can’t be withdrawn', async () => {
      await expect(
        as('user_ann', (s) => ledger.withdraw(s, 'publish')),
      ).resolves.toMatchObject({ id: expect.stringMatching(/^\w+$/) });
      const err = await as('user_bob', (s) =>
        ledger.withdraw(s, 'share_socials'),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsentConflictError);
      expect((err as ConsentConflictError).code).toBe('consent_not_granted');
    });

    it('re-consent restores the grant (each story follows the person, D17)', async () => {
      await as('user_ann', (s) =>
        ledger.grant(s, {
          type: 'publish',
          dpaVersion: 'v1',
          mechanism: 'reconsent_prompt',
        }),
      );
      expect(await asAdmin.submitterHas('ann_live', PUBLISHABLE)).toBe(true);
    });
  });

  describe('a material DPA change (gdpr-consent.md rule 5)', () => {
    beforeAll(() => publishDpa(t, 'v2')); // material, in effect now

    it('flags re-consent on every grant to the older version', async () => {
      const state = await as('user_ann', (s) => ledger.state(s));
      for (const c of state.current) {
        expect(c).toMatchObject({
          granted: true,
          dpaVersion: 'v1',
          reconsentRequired: true,
        });
      }
    });

    it('refuses new grants against v1, accepts v2 and clears the flag', async () => {
      await expect(
        as('user_cat', (s) =>
          ledger.grant(s, {
            type: 'publish',
            dpaVersion: 'v1',
            mechanism: 'web_form_submission',
          }),
        ),
      ).rejects.toBeInstanceOf(ConsentConflictError);
      await as('user_ann', (s) =>
        ledger.grant(s, {
          type: 'publish',
          dpaVersion: 'v2',
          mechanism: 'reconsent_prompt',
        }),
      );
      const state = await as('user_ann', (s) => ledger.state(s));
      expect(state.current.find((c) => c.type === 'publish')).toMatchObject({
        dpaVersion: 'v2',
        reconsentRequired: false,
      });
      expect(state.current.find((c) => c.type === 'age_18plus')).toMatchObject({
        reconsentRequired: true,
      });
    });
  });

  // GDPR Art 9 evidence (D19): the recorded hash binds what was presented and chosen. The
  // expected values are computed here, independently of the ledger's evidenceHash() (Codex
  // review of #72: a constant hash passed every test).
  describe('evidence binds the DPA text, type, event and mechanism (D19)', () => {
    const independent = (r: {
      dpa: string;
      dpaText: string;
      type: string;
      event: string;
      mechanism: string;
    }) =>
      createHash('sha256')
        .update(
          JSON.stringify([
            'heisreal-consent-evidence/v1',
            r.dpa,
            r.dpaText,
            r.type,
            r.event,
            r.mechanism,
          ]),
        )
        .digest('hex');
    type Evidence = {
      who: string;
      type: string;
      event: string;
      mechanism: string;
      dpa: string;
      dpaText: string;
      evidenceHash: string;
    };
    let rowsByKey: Evidence[];
    const find = (
      who: string,
      type: string,
      event: string,
      dpa: string,
      mechanism: string,
    ) => {
      const row = rowsByKey.find(
        (r) =>
          r.who === who &&
          r.type === type &&
          r.event === event &&
          r.dpa === dpa &&
          r.mechanism === mechanism,
      );
      if (!row)
        throw new Error(`no ${who} ${type} ${event} ${dpa} ${mechanism}`);
      return row.evidenceHash;
    };

    beforeAll(async () => {
      // Pairs that differ in one input only (v2 is in force now).
      const grant = (
        who: string,
        type: ConsentType,
        mechanism: ConsentMechanism,
      ) =>
        as(who, (s) => ledger.grant(s, { type, dpaVersion: 'v2', mechanism }));
      await grant('user_bob', 'share_socials', 'web_form_submission');
      await grant('user_cat', 'share_socials', 'account_settings');
      await as('user_cat', (s) => ledger.withdraw(s, 'share_socials'));
      rowsByKey = await rows<Evidence>(
        await t.migrator(),
        `SELECT record::id(subject) AS who, type, event, mechanism,
           record::id(dpaVersion) AS dpa, dpaVersion.contentHash AS dpaText, evidenceHash
         FROM consent`,
      );
    });

    it('every recorded hash is the sha256 of exactly what was presented and chosen', () => {
      expect(rowsByKey.length).toBeGreaterThan(5);
      for (const r of rowsByKey) expect(r.evidenceHash).toBe(independent(r));
    });

    it('matches a fixed vector (the format can’t drift unnoticed)', () => {
      expect(
        find('ann', 'publish', 'granted', 'v1', 'web_form_submission'),
      ).toBe(
        independent({
          dpa: 'v1',
          dpaText: DPA_V1_SHA256,
          type: 'publish',
          event: 'granted',
          mechanism: 'web_form_submission',
        }),
      );
      expect(
        independent({
          dpa: 'v1',
          dpaText: 'b'.repeat(64),
          type: 'publish',
          event: 'granted',
          mechanism: 'web_form_submission',
        }),
      ).toBe(FIXED_VECTOR);
    });

    it('changes with the DPA text, the type, the event and the mechanism', () => {
      const base = find(
        'bob',
        'share_socials',
        'granted',
        'v2',
        'web_form_submission',
      );
      // The DPA (version and text): the same grant under v1.
      expect(
        find('ann', 'share_socials', 'granted', 'v1', 'web_form_submission'),
      ).not.toBe(base);
      // The type.
      expect(
        find('ann', 'publish', 'granted', 'v1', 'web_form_submission'),
      ).not.toBe(
        find('ann', 'share_socials', 'granted', 'v1', 'web_form_submission'),
      );
      // The mechanism.
      const viaSettings = find(
        'cat',
        'share_socials',
        'granted',
        'v2',
        'account_settings',
      );
      expect(viaSettings).not.toBe(base);
      // The event.
      expect(
        find('cat', 'share_socials', 'withdrawn', 'v2', 'account_settings'),
      ).not.toBe(viaSettings);
    });
  });

  describe('person sessions (D27)', () => {
    it('refuses a token for someone the database doesn’t know, and leaks no session', async () => {
      const baseline = (await apiUser.sessions()).length;
      await expect(as('user_nobody', async () => 1)).rejects.toBeInstanceOf(
        PersonSessionRefusedError,
      );
      await as('user_ann', async () => 1);
      expect((await apiUser.sessions()).length).toBe(baseline);
    });
  });
});

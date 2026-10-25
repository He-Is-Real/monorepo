import {
  approve,
  createPeople,
  draft,
  publishDpa,
  publishForm,
  rows,
  run,
  sha256,
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
  type GrantConsentInput,
} from '../src/lib/consent-ledger';
import { evidenceHash } from '../src/lib/evidence';
import {
  CONSENT_REQUIRED,
  CONSENT_TYPES,
  type ConsentType,
  STATEMENT_FORM,
} from '../src/lib/consent.types';

/**
 * sha256 of ["heisreal-consent-evidence/v2","testimony","v1","aaa…","v1","bbb…","publish",
 * "granted","web_form_submission"]: the format can't drift unnoticed.
 */
const FIXED_VECTOR_V2 =
  '07c2cf2c8265cbe8de2d4536ff90c35b0a4fa2b0bd96053981ebeef7b64684a7';
/** The v1 format's fixed vector (rows from before forms keep verifying against it). */
const FIXED_VECTOR_V1 =
  '742fa2d7efa880025031ba5410d3e85f63e1179b49f8680fe126e34001db62e0';

/** The evidence formats, computed here independently of the ledger's evidenceHash(). */
const independentV2 = (r: {
  form: string;
  formVersion: string;
  formHash: string;
  dpa: string;
  dpaHash: string;
  type: string;
  event: string;
  mechanism: string;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'heisreal-consent-evidence/v2',
        r.form,
        r.formVersion,
        r.formHash,
        r.dpa,
        r.dpaHash,
        r.type,
        r.event,
        r.mechanism,
      ]),
    )
    .digest('hex');
const independentV1 = (r: {
  dpa: string;
  dpaHash: string;
  type: string;
  event: string;
  mechanism: string;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'heisreal-consent-evidence/v1',
        r.dpa,
        r.dpaHash,
        r.type,
        r.event,
        r.mechanism,
      ]),
    )
    .digest('hex');

/** Where each statement is ticked (D73, D67, D93). */
const FORM_OF = STATEMENT_FORM;
const FORM_TABLE: Record<GrantConsentInput['form'], string> = {
  signup: 'signupFormVersion',
  testimony: 'testimonyFormVersion',
  social: 'socialSharingFormVersion',
};

/**
 * The ledger service, the consent checks and person sessions against SurrealDB 3.2.4, on the
 * connections production uses: api-user's one service connection with a session per person
 * (D27), and api-admin's own login for submitter checks. Grants name the form version shown and
 * the statement ticked (D84).
 */
describe('consent ledger (D17–D20, D84) on SurrealDB', () => {
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
  const grant = (
    who: string,
    statement: ConsentType,
    formVersion = 'v1',
    mechanism: GrantConsentInput['mechanism'] = 'web_form_submission',
  ) =>
    as(who, (s) =>
      ledger.grant(s, {
        form: FORM_OF[statement],
        formVersion,
        statement,
        mechanism,
      }),
    );
  const conflict = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentConflictError);
    return (err as ConsentConflictError).code;
  };

  const ART9 = CONSENT_REQUIRED.createDraft.types;
  const PUBLISHABLE = CONSENT_REQUIRED.submitStory.types;

  beforeAll(async () => {
    t = await TestDatabase.create();
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cat: 'user_cat',
      vee: 'user_vee',
      moderator: 'user_mod',
    });
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    asAdmin = new ConsentChecker(admin);
    asApiUser = new ConsentChecker(apiUser);
  });
  afterAll(() => t?.close());

  describe('while no form is published (D20, D84)', () => {
    it('refuses every grant, and nothing reaches the ledger', async () => {
      expect(
        await conflict(grant('user_ann', 'special_category_religious')),
      ).toBe('form_version_not_in_force');
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
      expect(state.signup).toEqual({ accepted: false, latestVersion: null });
      expect(await as('user_ann', (s) => asAdmin.callerHas(s, ART9))).toBe(
        false,
      );
    });
  });

  describe('once v1 of the DPA and the three forms are published', () => {
    beforeAll(() => publishDpa(t, 'v1'));

    it('grants each statement on its form in the person’s own session, with evidence v2 and no IP', async () => {
      for (const type of CONSENT_TYPES) {
        expect(await grant('user_ann', type)).toEqual({
          id: expect.stringMatching(/^\w+$/),
          status: 201,
          replayed: false,
        });
      }
      const stored = await rows<Record<string, unknown>>(
        await t.migrator(),
        `SELECT *, dpaVersion.contentHash AS dpaHash, form.textHash AS formHash
           FROM consent WHERE subject = user:ann ORDER BY occurredAt`,
      );
      expect(stored).toHaveLength(CONSENT_TYPES.length);
      for (const row of stored) {
        const { dpaHash, formHash, ...fields } = row;
        expect(Object.keys(fields).sort()).toEqual([
          'dpaVersion',
          'event',
          'evidenceHash',
          'form',
          'id',
          'mechanism',
          'occurredAt',
          'subject',
          'type',
        ]); // D19: no ipAddress, nothing else
        const type = String(row['type']) as ConsentType;
        expect(row['form']).toBe(`${FORM_TABLE[FORM_OF[type]]}:v1`);
        expect(row['evidenceHash']).toBe(
          independentV2({
            form: FORM_OF[type],
            formVersion: 'v1',
            formHash: String(formHash),
            dpa: 'v1',
            dpaHash: String(dpaHash),
            type,
            event: 'granted',
            mechanism: 'web_form_submission',
          }),
        );
      }
    });

    it('evidence v2 matches a fixed vector, and binds the form and its text', () => {
      const base = {
        form: 'testimony',
        formVersion: 'v1',
        formHash: 'a'.repeat(64),
        dpa: 'v1',
        dpaHash: 'b'.repeat(64),
        type: 'publish',
        event: 'granted',
        mechanism: 'web_form_submission',
      };
      expect(independentV2(base)).toBe(FIXED_VECTOR_V2);
      // The ledger's own function, both formats.
      expect(
        evidenceHash({
          form: { kind: 'testimony', version: 'v1', textHash: base.formHash },
          dpaVersion: 'v1',
          dpaContentHash: base.dpaHash,
          type: 'publish',
          event: 'granted',
          mechanism: 'web_form_submission',
        }),
      ).toBe(FIXED_VECTOR_V2);
      expect(
        evidenceHash({
          dpaVersion: 'v1',
          dpaContentHash: base.dpaHash,
          type: 'publish',
          event: 'granted',
          mechanism: 'web_form_submission',
        }),
      ).toBe(FIXED_VECTOR_V1);
      for (const change of [
        { form: 'signup' },
        { formVersion: 'v2' },
        { formHash: 'c'.repeat(64) },
        { dpaHash: 'c'.repeat(64) },
        { type: 'share_socials' },
        { event: 'withdrawn' },
        { mechanism: 'account_settings' },
      ]) {
        expect(independentV2({ ...base, ...change })).not.toBe(FIXED_VECTOR_V2);
      }
      expect(
        independentV1({
          dpa: 'v1',
          dpaHash: 'b'.repeat(64),
          type: 'publish',
          event: 'granted',
          mechanism: 'web_form_submission',
        }),
      ).toBe(FIXED_VECTOR_V1);
    });

    it('derives the current state, the sign-up and testimony status from the latest events (D17, D73, D85)', async () => {
      const state = await as('user_ann', (s) => ledger.state(s));
      expect(state.current).toEqual(
        CONSENT_TYPES.map((type) => ({
          type,
          granted: true,
          form: FORM_OF[type],
          formVersion: 'v1',
          dpaVersion: 'v1',
          occurredAt: expect.any(String),
          counts: true,
        })),
      );
      expect(state.signup).toEqual({ accepted: true, latestVersion: 'v1' });
      expect(state.testimony).toEqual({
        version: 'v1',
        latestVersion: 'v1',
        updateAvailable: false,
        acceptanceRequired: false,
      });
      expect(await as('user_ann', (s) => asAdmin.callerAcceptedSignup(s))).toBe(
        true,
      );
      expect(await as('user_bob', (s) => asAdmin.callerAcceptedSignup(s))).toBe(
        false,
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

    it('refuses a statement the form version doesn’t have', async () => {
      for (const [form, statement] of [
        ['signup', 'publish'],
        ['testimony', 'account_data'],
        ['testimony', 'age_18plus'], // D93: 18+ is on the sign-up form only
        ['testimony', 'share_socials'],
        ['social', 'publish'],
      ] as const) {
        expect(
          await conflict(
            as('user_bob', (s) =>
              ledger.grant(s, {
                form,
                formVersion: 'v1',
                statement,
                mechanism: 'web_form_submission',
              }),
            ),
          ),
        ).toBe('statement_not_on_form');
      }
    });
  });

  describe('a v1 ledger row from before forms', () => {
    beforeAll(async () => {
      // As 0.8's ledger wrote it: no form, evidence v1. Only the migrator can write one now.
      const [dpaHash] = await rows<string>(
        await t.migrator(),
        'SELECT VALUE contentHash FROM dpaVersion:v1',
      );
      await run(
        await t.migrator(),
        `CREATE consent CONTENT { subject: user:vee, type: 'special_category_religious',
           event: 'granted', dpaVersion: dpaVersion:v1, mechanism: 'legacy_import',
           evidenceHash: $h }`,
        {
          h: independentV1({
            dpa: 'v1',
            dpaHash,
            type: 'special_category_religious',
            event: 'granted',
            mechanism: 'legacy_import',
          }),
        },
      );
    });

    it('still counts, can be withdrawn, and the whole history verifies (v1 and v2 rows)', async () => {
      expect(await as('user_vee', (s) => asAdmin.callerHas(s, ART9))).toBe(
        true,
      );
      await as('user_vee', (s) =>
        ledger.withdraw(s, 'special_category_religious'),
      );
      await grant('user_vee', 'special_category_religious');
      const checks = await as('user_vee', (s) => ledger.verifyEvidence(s));
      expect(checks.map((c) => [c.format, c.verified])).toEqual([
        ['v1', true],
        ['v1', true], // the withdrawal binds to the v1 grant it follows
        ['v2', true],
      ]);
      const ann = await as('user_ann', (s) => ledger.verifyEvidence(s));
      expect(ann.every((c) => c.format === 'v2' && c.verified)).toBe(true);
    });

    it('a tampered hash doesn’t verify', async () => {
      await run(
        await t.migrator(),
        `CREATE consent CONTENT { subject: user:vee, type: 'publish', event: 'granted',
           dpaVersion: dpaVersion:v1, form: testimonyFormVersion:v1,
           mechanism: 'web_form_submission', evidenceHash: $h }`,
        { h: sha256('not the evidence') },
      );
      const checks = await as('user_vee', (s) => ledger.verifyEvidence(s));
      expect(checks.at(-1)).toMatchObject({ format: 'v2', verified: false });
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
      expect(state.current.find((c) => c.type === 'publish')).toMatchObject({
        granted: false,
        form: 'testimony',
        formVersion: 'v1',
      });
      expect(state.history.at(-1)).toMatchObject({
        type: 'publish',
        event: 'withdrawn',
        form: 'testimony',
        formVersion: 'v1',
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
      expect(
        await conflict(
          as('user_bob', (s) => ledger.withdraw(s, 'share_socials')),
        ),
      ).toBe('consent_not_granted');
    });

    it('re-consent restores the grant (each story follows the person, D17)', async () => {
      await grant('user_ann', 'publish', 'v1', 'reconsent_prompt');
      expect(await asAdmin.submitterHas('ann_live', PUBLISHABLE)).toBe(true);
    });
  });

  describe('newer form versions (D73, D84, D85, D93)', () => {
    it('refuses a grant on a stale version once a newer one is published; accepts the new one', async () => {
      await publishForm(t, 'testimony', 'v2', { dpa: 'v1' });
      expect(await conflict(grant('user_cat', 'publish', 'v1'))).toBe(
        'form_version_not_in_force',
      );
      // Ann's v1 grants still count, and the banner offers v2.
      const before = await as('user_ann', (s) => ledger.state(s));
      expect(before.current.every((c) => c.counts)).toBe(true);
      expect(before.testimony).toMatchObject({
        version: 'v1',
        latestVersion: 'v2',
        updateAvailable: true,
        acceptanceRequired: false,
      });
      await grant('user_ann', 'special_category_religious', 'v2');
      expect((await as('user_ann', (s) => ledger.state(s))).testimony).toEqual({
        version: 'v2',
        latestVersion: 'v2',
        updateAvailable: false,
        acceptanceRequired: false,
      });
    });

    it('a testimony version requiring acceptance gates only new submissions: older grants keep counting', async () => {
      await publishForm(t, 'testimony', 'v3', {
        dpa: 'v1',
        requiresAcceptanceForNewSubmissions: true,
      });
      const state = await as('user_ann', (s) => ledger.state(s));
      for (const type of ['special_category_religious', 'publish'] as const) {
        expect(state.current.find((c) => c.type === type)).toMatchObject({
          granted: true,
          counts: true,
        });
      }
      expect(state.testimony.acceptanceRequired).toBe(true);
      // Approving and publishing her stories needs nothing new (D93)...
      expect(await asAdmin.submitterHas('ann_live', PUBLISHABLE)).toBe(true);
      // ...but a new draft or a submission does: the guard asks for the forms in force.
      expect(
        await as('user_ann', (s) => asAdmin.callerHas(s, ART9, true)),
      ).toBe(false);
      expect(await as('user_ann', (s) => asAdmin.callerHas(s, ART9))).toBe(
        true,
      );
      await grant(
        'user_ann',
        'special_category_religious',
        'v3',
        'reconsent_prompt',
      );
      expect(
        await as('user_ann', (s) => asAdmin.callerHas(s, ART9, true)),
      ).toBe(true);
    });

    it('a newer sign-up version: not accepted until she ticks it, while her v1 grants still count', async () => {
      await publishForm(t, 'signup', 'v2', { dpa: 'v1' });
      const state = await as('user_ann', (s) => ledger.state(s));
      expect(state.signup).toEqual({ accepted: false, latestVersion: 'v2' });
      expect(state.current.find((c) => c.type === 'age_18plus')).toMatchObject({
        formVersion: 'v1',
        counts: true,
      });
      expect(
        await as('user_ann', (s) => asAdmin.callerHas(s, ART9, true)),
      ).toBe(false);
      await grant('user_ann', 'account_data', 'v2', 'reconsent_prompt');
      await grant('user_ann', 'age_18plus', 'v2', 'reconsent_prompt');
      expect((await as('user_ann', (s) => ledger.state(s))).signup).toEqual({
        accepted: true,
        latestVersion: 'v2',
      });
    });
  });

  describe('a form version published while a grant is in flight (Codex, #101)', () => {
    it('the grant’s own transaction refuses the stale version: 409, and nothing reaches the ledger', async () => {
      // Deterministic: the session publishes v4 after the grant has checked the version in
      // force and before its transaction runs.
      let published = false;
      const between = (s: SurrealSession) =>
        new Proxy(s, {
          get(target, prop, receiver) {
            if (prop !== 'query') return Reflect.get(target, prop, receiver);
            return (sql: string, vars?: Record<string, unknown>) =>
              sql.includes('BEGIN TRANSACTION') && !published
                ? {
                    json: () => ({
                      responses: async () => {
                        published = true;
                        await publishForm(t, 'testimony', 'v4', {
                          dpa: 'v1',
                          requiresAcceptanceForNewSubmissions: true,
                        });
                        return target.query(sql, vars).json().responses();
                      },
                    }),
                  }
                : target.query(sql, vars);
          },
        });
      const err = await as('user_bob', (s) =>
        ledger.grant(between(s), {
          form: 'testimony',
          formVersion: 'v3',
          statement: 'publish',
          mechanism: 'reconsent_prompt',
        }),
      ).catch((e: unknown) => e);
      expect(published).toBe(true);
      expect(err).toBeInstanceOf(ConsentConflictError);
      expect((err as ConsentConflictError).code).toBe(
        'form_version_not_in_force',
      );
      const state = await as('user_bob', (s) => ledger.state(s));
      expect(state.history.filter((e) => e.formVersion === 'v3')).toEqual([]);
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

import type { Surreal, SurrealTransaction } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  trustSubmitters,
  grantAll,
  legalParams,
  MIGRATION_TIMEOUT_MS,
  outcome,
  publishDpa,
  publishForm,
  rows,
  run,
  sha256,
  TestDatabase,
} from './support/harness';
import { approve, draft, storyText, submit } from './support/world';

/**
 * D84, D93: the consent ledger is bound to versioned consent forms (sign-up, testimony and the
 * optional social sharing form), and the database's gate rules read the form version each
 * grant was given on:
 *   - a grant counts on any published or retired version that has its statement: a newer
 *     version never stops it counting, and never takes a story off the site (D93.1);
 *   - a new draft or a submission needs the sign-up version in force (18+ is there only,
 *     D93.2) and no newer testimony version requiring acceptance for new submissions;
 *   - sharing beyond heisreal.today: the person's social sharing version's columns (D93.3).
 * D75: dev's placeholder privacy document and forms, refused and not counted outside dev.
 */

const CONFLICT = /Transaction conflict.*can be retried/s;

const accepted = (db: Surreal, user: string) =>
  rows(db, `RETURN fn::consent::signup_accepted(type::record('user', $user))`, {
    user,
  });
const granted = (db: Surreal, user: string, types: string[]) =>
  rows(db, `RETURN fn::consent::granted(type::record('user', $user), $types)`, {
    user,
    types,
  });
const mayShare = (db: Surreal, user: string, use: string) =>
  rows(db, `RETURN fn::consent::may_share(type::record('user', $user), $use)`, {
    user,
    use,
  });
/** The person ticks `types` on form version `form` (e.g. testimonyFormVersion:v3), linking DPA v1. */
const grantOn = (db: Surreal, form: string, types: string[]) =>
  run(
    db,
    `FOR $type IN $types {
       CREATE consent CONTENT { subject: $auth, type: $type, event: 'granted',
         dpaVersion: dpaVersion:v1, form: <record> $form,
         mechanism: 'reconsent_prompt', evidenceHash: $h };
     }`,
    { types, form, h: sha256(`${form} ${types.join()}`) },
  );
/** The person withdraws `type`, bound to form version `form`, as WithdrawConsent records it. */
const withdrawOn = (db: Surreal, form: string, type: string) =>
  run(
    db,
    `CREATE consent CONTENT { subject: $auth, type: $type, event: 'withdrawn',
       dpaVersion: dpaVersion:v1, form: <record> $form,
       mechanism: 'account_settings', evidenceHash: $h }`,
    { type, form, h: sha256(`${form} ${type} withdrawn`) },
  );
/** Commits a transaction; its error message if it fails. */
const commit = async (tx: SurrealTransaction) => {
  try {
    await tx.commit();
    return 'committed';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe('consent forms (D84)', () => {
  let t: TestDatabase;
  let admin: Surreal;
  let migrator: Surreal;
  beforeAll(async () => {
    t = await TestDatabase.create();
    admin = await t.service('api_admin');
    migrator = await t.migrator();
    await createPeople(t, { ann: 'user_ann', vee: 'user_vee' });
    // These suites test consent, with more stories per person than D94 lets one start.
    await trustSubmitters(t, 'ann', 'vee');
    await publishDpa(t, 'v1'); // and v1 of the three forms, linked to it
  });
  afterAll(() => t?.close());

  describe('form versions', () => {
    it('a published version is frozen; it can only be retired, and never deleted', async () => {
      await publishForm(t, 'testimony', 'frozen');
      for (const change of [
        `textHash = $h`,
        `coversPublicPublishing = false`,
        `draftRetentionMonths = 12`,
        `status = 'draft'`,
      ]) {
        expect(
          await outcome(
            admin,
            `UPDATE testimonyFormVersion:frozen SET ${change}`,
            { h: sha256('other') },
          ),
        ).toEqual({
          ok: false,
          error: expect.stringMatching(/frozen|retired/),
        });
      }
      expect(
        (await outcome(admin, `DELETE testimonyFormVersion:frozen`)).ok,
      ).toBe(false);
      expect(
        await rows(
          admin,
          `UPDATE testimonyFormVersion:frozen SET status = 'retired' RETURN VALUE status`,
        ),
      ).toEqual(['retired']);
      expect(
        (
          await outcome(
            admin,
            `UPDATE testimonyFormVersion:frozen SET status = 'published'`,
          )
        ).ok,
      ).toBe(false);
    });

    it('is published only with its text matching textHash, linking a published DPA', async () => {
      await run(
        admin,
        `CREATE dpaVersion:draft_dpa CONTENT { materiality: 'material',
           documentPath: 'x.md', contentHash: $h }`,
        { h: sha256('draft') },
      );
      await expect(
        publishForm(t, 'signup', 'on_draft_dpa', { dpa: 'draft_dpa' }),
      ).rejects.toThrow('published privacy document');
      await expect(
        publishForm(t, 'social', 'bad_hash', { textHash: sha256('not it') }),
      ).rejects.toThrow('matching its textHash');
      // Only api-admin (and system users) write form versions; everyone reads published ones.
      for (const db of [
        await t.service('api_user'),
        await t.person('user_ann'),
      ]) {
        for (const table of ['signupFormVersion', 'socialSharingFormVersion']) {
          expect(
            await rows(
              db,
              `CREATE type::record($table, 'sneaky') CONTENT { textRef: 'x', textHash: $h,
                 dpaVersion: dpaVersion:v1 }`,
              { table, h: sha256('x') },
            ),
          ).toEqual([]);
          expect(
            await rows(db, `SELECT VALUE id FROM type::record($table, 'v1')`, {
              table,
            }),
          ).toEqual([`${table}:v1`]);
        }
      }
    });

    it('a sharing column added later reads “no” for every older version, which can still be retired', async () => {
      await publishForm(t, 'social', 'old_platforms', { shareTikTok: true });
      await run(
        migrator,
        `DEFINE FIELD shareMastodon ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false`,
      );
      try {
        expect(
          await rows(
            admin,
            `SELECT VALUE [shareTikTok, shareMastodon] FROM socialSharingFormVersion:old_platforms`,
          ),
        ).toEqual([[true, undefined]]); // NONE: never set
        expect(
          await rows(
            admin,
            `UPDATE socialSharingFormVersion:old_platforms SET status = 'retired'
               RETURN VALUE [status, shareMastodon]`,
          ),
        ).toEqual([['retired', false]]);
      } finally {
        await run(
          migrator,
          `REMOVE FIELD shareMastodon ON socialSharingFormVersion`,
        );
      }
    });
  });

  describe('the ledger names the form version and statement', () => {
    it('refuses a grant without a form, on a draft or retired version, or for a statement the version lacks', async () => {
      const ann = await t.person('user_ann');
      await run(
        admin,
        `CREATE signupFormVersion:unpublished CONTENT { textRef: 'x', textHash: $h,
           dpaVersion: dpaVersion:v1 }`,
        { h: sha256('x') },
      );
      await publishForm(t, 'testimony', 'no_publishing', {
        coversPublicPublishing: false,
      });
      const cases: [string, string, string][] = [
        ['publish', 'NONE', 'consent form version'],
        [
          'account_data',
          'signupFormVersion:unpublished',
          'published form version',
        ],
        [
          'special_category_religious',
          'testimonyFormVersion:frozen',
          'published form version',
        ],
        [
          'account_data',
          'testimonyFormVersion:v1',
          'belongs to another consent form',
        ],
        [
          'special_category_religious',
          'signupFormVersion:v1',
          'belongs to another consent form',
        ],
        [
          'publish',
          'testimonyFormVersion:no_publishing',
          'isn’t on this form version',
        ],
        // D93: 18+ is on the sign-up form only; sharing is on its own form.
        [
          'age_18plus',
          'testimonyFormVersion:v1',
          'belongs to another consent form',
        ],
        [
          'age_18plus',
          'socialSharingFormVersion:v1',
          'belongs to another consent form',
        ],
        [
          'share_socials',
          'testimonyFormVersion:v1',
          'belongs to another consent form',
        ],
        [
          'publish',
          'socialSharingFormVersion:v1',
          'belongs to another consent form',
        ],
      ];
      for (const [type, form, error] of cases) {
        expect([
          type,
          form,
          await outcome(
            ann,
            `CREATE consent CONTENT { subject: $auth, type: $type, event: 'granted',
               dpaVersion: dpaVersion:v1, form: IF $form = 'NONE' { NONE } ELSE { <record> $form },
               mechanism: 'web_form_submission', evidenceHash: $h }`,
            { type, form, h: sha256('e') },
          ),
        ]).toEqual([
          type,
          form,
          { ok: false, error: expect.stringContaining(error) },
        ]);
      }
    });

    it('D122: a grant names the privacy policy in force, which may be newer than its form’s link, never a draft', async () => {
      await publishDpa(t, 'other_dpa');
      const ann = await t.person('user_ann');
      const grant = (dpa: string) =>
        outcome(
          ann,
          `CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'granted',
             dpaVersion: type::record('dpaVersion', $dpa), form: testimonyFormVersion:v1,
             mechanism: 'web_form_submission', evidenceHash: $h }`,
          { dpa, h: sha256(`e ${dpa}`) },
        );
      expect((await grant('other_dpa')).ok).toBe(true);
      await run(
        admin,
        `CREATE dpaVersion:draft_policy CONTENT { materiality: 'minor',
           documentPath: 'x.md', contentHash: $h }`,
        { h: sha256('draft policy') },
      );
      expect((await grant('draft_policy')).ok).toBe(false);
    });

    it('D109: no row ties 18+ to a testimony or social sharing version, grant or withdrawal, whoever writes it', async () => {
      // No version of either form has an 18+ box, whatever its columns say.
      await publishForm(t, 'testimony', 'all_features', {
        coversPublicPublishing: true,
        requiresAcceptanceForNewSubmissions: true,
      });
      await publishForm(t, 'social', 'all_features', {
        shareTikTok: true,
        allowPaidPromotion: true,
      });
      for (const form of [
        'testimonyFormVersion:v1',
        'testimonyFormVersion:all_features',
        'socialSharingFormVersion:v1',
        'socialSharingFormVersion:all_features',
      ]) {
        const [statements] = await rows<string[]>(
          admin,
          'RETURN fn::form::statements(<record> $form)',
          { form },
        );
        expect([form, statements.includes('age_18plus')]).toEqual([
          form,
          false,
        ]);
      }
      // The ledger refuses the pairing for a withdrawal too, and for the migrator (a system
      // user, who skips table permissions but not events).
      const vee = await t.person('user_vee');
      for (const [db, event, subject] of [
        [vee, 'withdrawn', '$auth'],
        [migrator, 'granted', 'user:vee'],
        [migrator, 'withdrawn', 'user:vee'],
      ] as const) {
        for (const form of [
          'testimonyFormVersion:v1',
          'socialSharingFormVersion:v1',
        ]) {
          expect([
            event,
            form,
            await outcome(
              db,
              `CREATE consent CONTENT { subject: ${subject}, type: 'age_18plus', event: $event,
                 dpaVersion: dpaVersion:v1, form: <record> $form,
                 mechanism: 'account_settings', evidenceHash: $h }`,
              { event, form, h: sha256('18+') },
            ),
          ]).toEqual([
            event,
            form,
            {
              ok: false,
              error: expect.stringContaining('belongs to another consent form'),
            },
          ]);
        }
      }
      expect(
        await rows(
          migrator,
          `SELECT VALUE id FROM consent WHERE type = 'age_18plus'
             AND form != NONE AND record::tb(form) != 'signupFormVersion'`,
        ),
      ).toEqual([]);
    });
  });
});

describe('the sign-up form: only the latest version lets something new start (D73, D93)', () => {
  let t: TestDatabase;
  let svc: Surreal;
  let publicRead: Surreal;
  beforeAll(async () => {
    t = await TestDatabase.create();
    svc = await t.service('api_admin');
    publicRead = await t.service('api_public_read');
    await createPeople(t, { ann: 'user_ann', moderator: 'user_mod' });
    // These suites test consent, with more stories per person than D94 lets one start.
    await trustSubmitters(t, 'ann');
    await publishDpa(t, 'v1');
  });
  afterAll(() => t?.close());

  it('needs both boxes, then a newer version asks again before a new draft, while her stories stay public', async () => {
    const ann = await t.person('user_ann');
    expect(await accepted(svc, 'ann')).toEqual([false]);
    await consentEvent(ann, 'account_data', 'granted', 'v1');
    expect(await accepted(svc, 'ann')).toEqual([false]); // 18+ not ticked yet
    await consentEvent(ann, 'age_18plus', 'granted', 'v1');
    expect(await accepted(ann, 'ann')).toEqual([true]);
    for (const type of ['special_category_religious', 'publish'] as const) {
      await consentEvent(ann, type, 'granted', 'v1');
    }
    await draft(ann, 'ann_live');
    await submit(ann, 'ann_live');
    await approve(svc, 'ann_live');

    await publishForm(t, 'signup', 'v2', { dpa: 'v1' });
    expect(await accepted(ann, 'ann')).toEqual([false]);
    // Nothing hides: her 18+ on v1 still counts for publishing (D93).
    expect(
      await rows(publicRead, 'SELECT VALUE id FROM publicStory:ann_live'),
    ).toEqual(['publicStory:ann_live']);
    expect(
      await granted(svc, 'ann', [
        'special_category_religious',
        'publish',
        'age_18plus',
      ]),
    ).toEqual([true]);
    // But no new draft until she accepts v2; re-affirming v1 doesn't help.
    expect(await draft(ann, 'ann_new')).toEqual([]);
    await consentEvent(ann, 'account_data', 'granted', 'v1');
    expect(await accepted(ann, 'ann')).toEqual([false]);
    await grantOn(ann, 'signupFormVersion:v2', ['account_data', 'age_18plus']);
    expect(await accepted(ann, 'ann')).toEqual([true]);
    expect(await draft(ann, 'ann_new')).toHaveLength(1);
    await withdrawOn(ann, 'signupFormVersion:v2', 'account_data');
    expect(await accepted(ann, 'ann')).toEqual([false]);
  });
});

describe('testimony versions: new ones gate new submissions, never published stories (D84, D85, D93)', () => {
  let t: TestDatabase;
  let admin: Surreal;
  let migrator: Surreal;
  let publicRead: Surreal;
  const status = (user: string) =>
    rows(
      admin,
      `RETURN fn::consent::testimony_status(type::record('user', $user))`,
      { user },
    );
  const isPublic = async (id: string) =>
    (
      await rows(
        publicRead,
        'SELECT VALUE id FROM type::record("publicStory", $id)',
        { id },
      )
    ).length === 1;
  const truth = (sql: string, vars?: Record<string, unknown>) =>
    rows(migrator, sql, vars);
  const live = async (user: string, id: string) => {
    const person = await t.person(`user_${user}`);
    await draft(person, id);
    await submit(person, id);
    await approve(admin, id);
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    admin = await t.service('api_admin');
    migrator = await t.migrator();
    publicRead = await t.service('api_public_read');
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cy: 'user_cy',
      vee: 'user_vee',
      moderator: 'user_mod',
    });
    // These suites test consent, with more stories per person than D94 lets one start.
    await trustSubmitters(t, 'ann', 'bob', 'cy', 'vee');
    await publishDpa(t, 'v1');
    for (const user of ['ann', 'bob', 'cy']) {
      await grantAll(await t.person(`user_${user}`), 'v1');
    }
    await live('ann', 'ann_live');
    await live('bob', 'bob_live');
    // Ann has a draft in progress; Bob a story waiting for a moderator.
    await draft(await t.person('user_ann'), 'ann_draft');
    await draft(await t.person('user_bob'), 'bob_pending');
    await submit(await t.person('user_bob'), 'bob_pending');
    // Vee's testimony grants are v1 ledger rows from before forms (evidence v1): no form.
    await run(
      migrator,
      `FOR $type IN ['special_category_religious', 'publish'] {
         CREATE consent CONTENT { subject: user:vee, type: $type, event: 'granted',
           dpaVersion: dpaVersion:v1, mechanism: 'legacy_import', evidenceHash: $h };
       }`,
      { h: sha256('v1 row') },
    );
    await grantOn(await t.person('user_vee'), 'signupFormVersion:v1', [
      'account_data',
      'age_18plus',
    ]);
  });
  afterAll(() => t?.close());

  it('a v1 row from before forms still counts', async () => {
    expect(await granted(admin, 'vee', ['special_category_religious'])).toEqual(
      [true],
    );
    expect(await draft(await t.person('user_vee'), 'vee_story')).toHaveLength(
      1,
    );
  });

  it('a newer version that doesn’t require acceptance changes nothing but offering the update', async () => {
    await publishForm(t, 'testimony', 'v2', { dpa: 'v1' });
    expect([await isPublic('ann_live'), await isPublic('bob_live')]).toEqual([
      true,
      true,
    ]);
    expect(await status('ann')).toEqual([
      {
        version: 'testimonyFormVersion:v1',
        latest: 'testimonyFormVersion:v2',
        updateAvailable: true,
        acceptanceRequired: false,
      },
    ]);
    expect(await draft(await t.person('user_ann'), 'ann_v2')).toHaveLength(1);
  });

  it('a version requiring acceptance leaves every story public and every older grant counting', async () => {
    await publishForm(t, 'testimony', 'v3', {
      dpa: 'v1',
      requiresAcceptanceForNewSubmissions: true,
    });
    expect([await isPublic('ann_live'), await isPublic('bob_live')]).toEqual([
      true,
      true,
    ]);
    expect(await truth('SELECT VALUE id FROM hiddenStory')).toEqual([]);
    expect(
      await truth(`SELECT VALUE id FROM auditLog WHERE action = 'HideStory'`),
    ).toEqual([]);
    for (const user of ['ann', 'bob', 'vee']) {
      expect([
        user,
        await granted(admin, user, ['special_category_religious', 'publish']),
      ]).toEqual([user, [true]]);
    }
    expect(await status('ann')).toEqual([
      expect.objectContaining({
        updateAvailable: true,
        acceptanceRequired: true,
      }),
    ]);
    // A story submitted before it is still approved and published as usual.
    await approve(admin, 'bob_pending');
    expect(await isPublic('bob_pending')).toBe(true);
  });

  it('a person on an older version can still edit a draft, but can’t start one or submit until they accept it', async () => {
    const ann = await t.person('user_ann');
    await run(ann, `UPDATE story:ann_draft SET title = 'Still mine to edit'`);
    expect(await truth('SELECT VALUE title FROM story:ann_draft')).toEqual([
      'Still mine to edit',
    ]);
    expect(await draft(ann, 'ann_blocked')).toEqual([]);
    expect(
      await outcome(ann, `UPDATE story:ann_draft SET status = 'pending'`),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('submitting a story needs'),
    });
    // Grants from before forms are older than any version.
    expect(await draft(await t.person('user_vee'), 'vee_blocked')).toEqual([]);

    // Accepting v3 moves Ann's account to it (D85).
    await grantOn(ann, 'testimonyFormVersion:v3', [
      'special_category_religious',
      'publish',
    ]);
    expect(await status('ann')).toEqual([
      {
        version: 'testimonyFormVersion:v3',
        latest: 'testimonyFormVersion:v3',
        updateAvailable: false,
        acceptanceRequired: false,
      },
    ]);
    expect(await submit(ann, 'ann_draft')).toHaveLength(1);
    expect(await draft(ann, 'ann_after')).toHaveLength(1);
    // Retiring v3 later doesn't undo anything: v3 still counts, and Bob still has to accept.
    await run(admin, `UPDATE testimonyFormVersion:v3 SET status = 'retired'`);
    expect(await granted(admin, 'ann', ['special_category_religious'])).toEqual(
      [true],
    );
    expect(await draft(await t.person('user_bob'), 'bob_blocked')).toEqual([]);
  });

  describe('races: something new can’t commit on a snapshot from before a version (Codex, #101)', () => {
    /** Starts Cy's transaction with `sql` in it, uncommitted. */
    const begin = async (sql: string, vars?: Record<string, unknown>) => {
      const tx = await (await cy()).beginTransaction();
      await tx.query(sql, vars).collect();
      return tx;
    };
    const newDraft = (id: string) =>
      begin(
        `CREATE type::record('story', $id) CONTENT {
           submitter: $auth, slug: $id, title: 'Story', description: 'd',
           body: $body, primaryFormat: 'written' }`,
        { id, body: storyText(id) },
      );
    const cy = () => t.person('user_cy');
    const inForce = async () =>
      String((await rows(admin, `RETURN fn::form::latest('testimony').id`))[0]);
    /** Cy accepts the testimony version in force. */
    const accept = async () =>
      grantOn(await cy(), await inForce(), [
        'special_category_religious',
        'publish',
      ]);
    let version = 3;
    /** Publishes the next testimony version, requiring acceptance for new submissions. */
    const publishNext = async () => {
      version += 1;
      await publishForm(t, 'testimony', `v${version}`, {
        dpa: 'v1',
        requiresAcceptanceForNewSubmissions: true,
      });
      return `v${version}`;
    };

    beforeAll(() => accept());

    it('a new draft racing a publication: the draft fails at commit', async () => {
      const drafting = await newDraft('cy_racing_draft');
      await publishNext();
      expect(await commit(drafting)).toMatch(CONFLICT);
      expect(await truth('SELECT VALUE id FROM story:cy_racing_draft')).toEqual(
        [],
      );
      // Its retry is refused: Cy hasn't accepted the new version.
      expect(await draft(await cy(), 'cy_racing_draft')).toEqual([]);
    });

    it('the other order: the publication commits second and fails, and its retry stands', async () => {
      await accept();
      const publishing = await migrator.beginTransaction();
      await publishing
        .query(
          `CREATE testimonyFormVersion:racing CONTENT {
             status: 'published', textRef: 'libs/legal/forms/testimony/racing.md',
             textHash: $h, text: 'racing', dpaVersion: dpaVersion:v1,
             requiresAcceptanceForNewSubmissions: true, coversPublicPublishing: true,
             draftRetentionMonths: 6 }`,
          { h: sha256('racing') },
        )
        .collect();
      expect(await draft(await cy(), 'cy_before')).toHaveLength(1);
      expect(await commit(publishing)).toMatch(CONFLICT);
    });

    it('a submission racing a publication: the submission fails at commit', async () => {
      const submitting = await begin(
        `UPDATE story:cy_before SET status = 'pending'`,
      );
      await publishNext();
      expect(await commit(submitting)).toMatch(CONFLICT);
      expect(await truth('SELECT VALUE status FROM story:cy_before')).toEqual([
        'draft',
      ]);
    });

    it('a new draft racing a withdrawal: the draft fails at commit', async () => {
      await accept();
      const drafting = await newDraft('cy_after_withdrawal');
      await consentEvent(await cy(), 'special_category_religious', 'withdrawn');
      expect(await commit(drafting)).toMatch(CONFLICT);
      expect(
        await truth('SELECT VALUE id FROM story:cy_after_withdrawal'),
      ).toEqual([]);
    });

    it('a grant racing a publication: the stale grant never commits', async () => {
      const granting = await begin(
        `CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'granted',
           dpaVersion: dpaVersion:v1, form: <record> $v,
           mechanism: 'reconsent_prompt', evidenceHash: $h }`,
        { v: await inForce(), h: sha256('cy stale') },
      );
      const next = await publishNext();
      expect(await commit(granting)).toMatch(CONFLICT);
      expect(
        await truth(
          `SELECT VALUE id FROM consent WHERE subject = user:cy AND evidenceHash = $h`,
          { h: sha256('cy stale') },
        ),
      ).toEqual([]);
      expect(next).toBe(`v${version}`);
    });
  });
});

describe('sharing beyond heisreal.today: the uploader’s social sharing version (D93)', () => {
  let t: TestDatabase;
  let svc: Surreal;
  beforeAll(async () => {
    t = await TestDatabase.create();
    svc = await t.service('workflow');
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      moderator: 'user_mod',
    });
    // These suites test consent, with more stories per person than D94 lets one start.
    await trustSubmitters(t, 'ann', 'bob');
    await publishDpa(t, 'v1'); // social v1 allows nothing
  });
  afterAll(() => t?.close());

  it('needs the share tick on a version listing that platform or use: the early-adopter rule', async () => {
    const ann = await t.person('user_ann');
    await grantAll(ann, 'v1'); // the share tick included, on social v1
    expect(await mayShare(svc, 'ann', 'shareTikTok')).toEqual([false]);

    await publishForm(t, 'social', 'v2', {
      shareTikTok: true,
      allowEditingAndClipping: true,
    });
    // Still on v1: a new platform is a new version people opt into.
    expect(await mayShare(svc, 'ann', 'shareTikTok')).toEqual([false]);
    await grantOn(ann, 'socialSharingFormVersion:v2', ['share_socials']);
    expect(await mayShare(svc, 'ann', 'shareTikTok')).toEqual([true]);
    expect(await mayShare(svc, 'ann', 'allowEditingAndClipping')).toEqual([
      true,
    ]);
    expect(await mayShare(svc, 'ann', 'shareYouTube')).toEqual([false]);
    expect(await mayShare(svc, 'ann', 'allowPaidPromotion')).toEqual([false]);

    // Through a story, as anything that posts one would ask: only once it's public.
    await draft(ann, 'ann_s');
    expect(
      await rows(
        svc,
        `RETURN fn::story::may_share(story:ann_s, 'shareTikTok')`,
      ),
    ).toEqual([false]);
    await submit(ann, 'ann_s');
    await approve(await t.service('api_admin'), 'ann_s');
    expect(
      await rows(
        svc,
        `RETURN fn::story::may_share(story:ann_s, 'shareTikTok')`,
      ),
    ).toEqual([true]);

    // A newer social version changes nothing for her (D93), and withdrawing only stops
    // sharing: the story stays public.
    await publishForm(t, 'social', 'v3', { shareYouTube: true });
    expect(await mayShare(svc, 'ann', 'shareTikTok')).toEqual([true]);
    await withdrawOn(ann, 'socialSharingFormVersion:v2', 'share_socials');
    expect(await mayShare(svc, 'ann', 'shareTikTok')).toEqual([false]);
    expect(
      await rows(
        await t.service('api_public_read'),
        'SELECT VALUE id FROM publicStory:ann_s',
      ),
    ).toEqual(['publicStory:ann_s']);
  });

  it('a column added later, an unknown name or an odd one is a “no”, and so is no publish consent', async () => {
    const bob = await t.person('user_bob');
    await grantAll(bob, 'v1');
    await grantOn(bob, 'socialSharingFormVersion:v2', ['share_socials']);
    await run(
      await t.migrator(),
      `DEFINE FIELD shareMastodon ON socialSharingFormVersion TYPE bool DEFAULT ALWAYS false`,
    );
    try {
      for (const use of [
        'shareMastodon',
        'shareMyspace',
        'shareTikTok OR 1',
        'TikTok',
        'sharetiktok',
        '',
        'textHash',
        'status',
      ]) {
        expect([use, await mayShare(svc, 'bob', use)]).toEqual([use, [false]]);
      }
      expect(await mayShare(svc, 'bob', 'shareTikTok')).toEqual([true]);
    } finally {
      await run(
        await t.migrator(),
        `REMOVE FIELD shareMastodon ON socialSharingFormVersion`,
      );
    }
    await consentEvent(bob, 'publish', 'withdrawn', 'v1');
    expect(await mayShare(svc, 'bob', 'shareTikTok')).toEqual([false]);
  });
});

describe('dev placeholder privacy document and forms (D75)', () => {
  it('outside dev: the migration refuses the switch, and the database refuses a placeholder', async () => {
    const t = await TestDatabase.create();
    try {
      for (const environment of ['prod', null]) {
        const result = await t.runMigration(
          t.params({ dev_legal_placeholders: true, environment }),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain('dev only (D75)');
      }
      expect(
        await outcome(
          await t.migrator(),
          `CREATE dpaVersion:sneaky CONTENT { status: 'published', materiality: 'material',
             documentPath: 'x', contentHash: $h, devPlaceholder: true }`,
          { h: sha256('x') },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('dev only (D75)'),
      });
      expect(
        await rows(
          await t.migrator(),
          'SELECT VALUE id FROM signupFormVersion',
        ),
      ).toEqual([]);
    } finally {
      await t.close();
    }
  });

  describe('in dev', () => {
    let t: TestDatabase;
    const placeholders = (on: boolean) =>
      t.migrate(t.params({ environment: 'dev', dev_legal_placeholders: on }));
    // As the API grants since D122: on dev's v2, under the privacy policy in force and, on the
    // sign-up form, the terms of use in force (evidence v4, D125).
    const devGrant = (db: Surreal, type: string, form: string) =>
      run(
        db,
        `CREATE consent CONTENT { subject: $auth, type: $type, event: 'granted',
           dpaVersion: dpaVersion:dev_policy, form: <record> $form,
           termsVersion: IF string::starts_with($form, 'signupFormVersion') { termsVersion:dev_placeholder } ELSE { NONE },
           mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 4 }`,
        { type, form, h: sha256(`${type} ${form}`) },
      );
    const signUp = async (db: Surreal) => {
      for (const type of ['account_data', 'age_18plus', 'terms_of_use']) {
        await devGrant(db, type, 'signupFormVersion:v2');
      }
    };
    beforeAll(async () => {
      t = await TestDatabase.create({
        params: { environment: 'dev', dev_legal_placeholders: true },
      });
      await createPeople(t, { ann: 'user_ann' });
      // These suites test consent, with more stories per person than D94 lets one start.
      await trustSubmitters(t, 'ann');
    });
    afterAll(() => t?.close());

    it('publishes the privacy policy and terms of use, numbered, and v2 of the three forms: boxes as data, a short introduction', async () => {
      const legal = legalParams();
      const svc = await t.service('api_public_read');
      // D121, D125: dev's placeholder privacy document is the privacy policy's version 1, the
      // words /privacy showed before D125 its version 2, in force (data 0007); the terms of
      // use's version 1 beside them.
      expect(
        await rows(
          svc,
          `RETURN [fn::legal::dpa_in_force(), fn::legal::terms_in_force()]`,
        ),
      ).toEqual(['dpaVersion:dev_policy', 'termsVersion:dev_placeholder']);
      expect(
        await rows(
          svc,
          `SELECT VALUE [record::id(id), number, text = $texts[record::id(id)],
              contentHash = $hashes[record::id(id)], publishedBy]
             FROM dpaVersion WHERE number != NONE ORDER BY number`,
          { texts: legal.dpa_text, hashes: legal.dpa_sha256 },
        ),
      ).toEqual([
        ['dev_placeholder', 1, true, true, undefined],
        ['dev_policy', 2, true, true, undefined],
      ]);
      expect(
        await rows(
          svc,
          `SELECT text, number FROM ONLY termsVersion:dev_placeholder`,
        ),
      ).toEqual([{ text: legal.terms_text['dev_placeholder'], number: 1 }]);
      const table = {
        signup: 'signupFormVersion',
        testimony: 'testimonyFormVersion',
        social: 'socialSharingFormVersion',
      };
      for (const kind of ['signup', 'testimony', 'social'] as const) {
        const [form] = await rows<Record<string, unknown>>(
          svc,
          `RETURN fn::form::latest($kind)`,
          { kind },
        );
        expect(form).toMatchObject({
          id: `${table[kind]}:v2`,
          status: 'published',
          text: legal.form_text[kind]['v2'],
          dpaVersion: 'dpaVersion:dev_policy',
          // D114: its boxes, from its statements file.
          statements: legal.form_statements[kind]['v2'].statements,
          statementsHash: legal.form_statements_sha256[kind]['v2'],
        });
        // D122: a short introduction, never a document listing the boxes: no statement's key
        // (as v1 named them, `publish`) or the words beside its box appear in it.
        const text = String(form['text']);
        expect(text.length).toBeLessThan(800);
        for (const box of legal.form_statements[kind]['v2'].statements) {
          expect([kind, box.key, text.includes(`\`${box.key}\``)]).toEqual([
            kind,
            box.key,
            false,
          ]);
          expect([kind, box.key, text.includes(box.label)]).toEqual([
            kind,
            box.key,
            false,
          ]);
        }
      }
      // D122: Joel's sign-up boxes, the terms box among them.
      const [signup] = await rows<{
        coversTerms: boolean;
        statements: { key: string; label: string }[];
      }>(svc, `SELECT coversTerms, statements FROM ONLY signupFormVersion:v2`);
      expect(signup.coversTerms).toBe(true);
      expect(signup.statements.map((b) => b.label)).toEqual([
        'I am 18 or over.',
        'Store my account activity and preferences. I understand these may show my interest in the Christian faith.',
        'I agree to the terms of use.',
      ]);
      // The testimony form's boxes say where they sit, as data.
      const [{ statements }] = await rows<{
        statements: { key: string; step?: string }[];
      }>(svc, `SELECT statements FROM ONLY testimonyFormVersion:v2`);
      expect(statements.map((b) => [b.key, b.step])).toEqual([
        ['special_category_religious', 'start'],
        ['publish', 'submit'],
      ]);
      // Social v2 allows every platform and use its words name, as v1.
      const [social] = await rows<Record<string, unknown>>(
        svc,
        `SELECT * OMIT id, text, textHash, textRef, dpaVersion, status, publishedAt,
           version, createdAt, statements, statementsHash FROM ONLY socialSharingFormVersion:v2`,
      );
      expect(Object.values(social).every((v) => v === true)).toBe(true);
      expect(Object.keys(social)).toHaveLength(8);
    });

    it('D122: the sign-up form in force needs the terms box too, bound to the terms in force', async () => {
      await createPeople(t, { cy: 'user_cy' });
      const cy = await t.person('user_cy');
      await devGrant(cy, 'account_data', 'signupFormVersion:v2');
      await devGrant(cy, 'age_18plus', 'signupFormVersion:v2');
      expect(await accepted(cy, 'cy')).toEqual([false]);
      // A sign-up grant without the terms in force is refused.
      expect(
        (
          await outcome(
            cy,
            `CREATE consent CONTENT { subject: $auth, type: 'terms_of_use', event: 'granted',
               dpaVersion: dpaVersion:dev_policy, form: signupFormVersion:v2,
               mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 4 }`,
            { h: sha256('no terms') },
          )
        ).ok,
      ).toBe(false);
      await devGrant(cy, 'terms_of_use', 'signupFormVersion:v2');
      expect(await accepted(cy, 'cy')).toEqual([true]);
    });

    // Each test below runs migrations: a test timeout of MIGRATION_TIMEOUT_MS for each one.
    it(
      'real consent works against them; switched off, they and the grants stop counting',
      { timeout: MIGRATION_TIMEOUT_MS },
      async () => {
        const ann = await t.person('user_ann');
        await devGrant(
          ann,
          'special_category_religious',
          'testimonyFormVersion:v2',
        );
        await signUp(ann);
        expect(await accepted(ann, 'ann')).toEqual([true]);
        expect(await draft(ann, 'ann_story')).toHaveLength(1);

        // As if this database were restored somewhere else, or the switch removed.
        await placeholders(false);
        const svc = await t.service('api_public_read');
        // NONE: rows() gives no row.
        expect(await rows(svc, 'RETURN fn::legal::dpa_in_force()')).toEqual([]);
        expect(await rows(svc, `RETURN fn::form::latest('signup')`)).toEqual(
          [],
        );
        expect(await accepted(ann, 'ann')).toEqual([false]);
        expect(await draft(ann, 'ann_second')).toEqual([]);
      },
    );

    it(
      'switched off, a public story is hidden (its consent has no basis left); switched on, it comes back',
      { timeout: 3 * MIGRATION_TIMEOUT_MS },
      async () => {
        await placeholders(true);
        await createPeople(t, { bo: 'user_bo', moderator: 'user_mod' });
        // These suites test consent, with more stories per person than D94 lets one start.
        await trustSubmitters(t, 'bo');
        const bo = await t.person('user_bo');
        await signUp(bo);
        await devGrant(
          bo,
          'special_category_religious',
          'testimonyFormVersion:v2',
        );
        await devGrant(bo, 'publish', 'testimonyFormVersion:v2');
        await draft(bo, 'bo_live');
        await submit(bo, 'bo_live');
        await approve(await t.service('api_admin'), 'bo_live');
        const svc = await t.service('api_public_read');
        const isPublic = async () =>
          (await rows(svc, 'SELECT VALUE id FROM publicStory:bo_live')).length;
        expect(await isPublic()).toBe(1);

        await placeholders(false);
        expect(await isPublic()).toBe(0);
        expect(
          await rows(
            await t.migrator(),
            'SELECT VALUE status FROM story:bo_live',
          ),
        ).toEqual(['approved']);

        await placeholders(true);
        expect(await isPublic()).toBe(1);
      },
    );

    it(
      'leaving dev (a dev backup restored elsewhere) hides a story that stood on dev consent (Codex, #101)',
      { timeout: MIGRATION_TIMEOUT_MS },
      async () => {
        const svc = await t.service('api_public_read');
        expect(
          await rows(svc, 'SELECT VALUE id FROM publicStory:bo_live'),
        ).toHaveLength(1);
        await t.migrate(
          t.params({
            environment: 'prod',
            dev_legal_placeholders: false,
            dev_consent_relaxed: false,
          }),
        );
        expect(
          await rows(svc, 'SELECT VALUE id FROM publicStory:bo_live'),
        ).toEqual([]);
        expect(
          await rows(
            await t.migrator(),
            `SELECT VALUE [status, record::exists(hiddenStory:bo_live)] FROM story:bo_live`,
          ),
        ).toEqual([['approved', true]]);
      },
    );
  });
});

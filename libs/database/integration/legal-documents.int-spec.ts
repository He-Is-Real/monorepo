import type { Surreal } from 'surrealdb';
import {
  createPeople,
  outcome,
  publishDpa,
  publishForm,
  rows,
  run,
  sha256,
  TestDatabase,
} from './support/harness';
import { approve, draft, submit } from './support/world';

/**
 * D121, D122, D125 (Joel, 2026-10-30): the two legal documents, the privacy policy (dpaVersion)
 * and the terms of use (termsVersion), each a line of numbered versions of Markdown the site
 * renders, kept for ever, unchanged. Every grant binds the privacy policy in force and, on a
 * sign-up version asking for them, the terms of use in force (evidence v4); a new version asks
 * nobody to accept again by itself, and nothing ever hides a story.
 */

/** api-admin's publish of a privacy policy version (PublishPrivacyPolicy's row). */
const policy = (words: string) => ({
  kind: 'standard',
  status: 'published',
  contentHash: sha256(words),
  text: words,
  source: 'admin',
});
/** api-admin's publish of a terms of use version (PublishTerms's row). */
const terms = (words: string) => ({
  text: words,
  contentHash: sha256(words),
  source: 'admin',
});

describe('the legal documents (D121, D125)', () => {
  let t: TestDatabase;
  let admin: Surreal;
  let migrator: Surreal;
  let publicRead: Surreal;
  const publish = (table: string, id: string, content: object) =>
    outcome(
      admin,
      `CREATE type::record($table, $id) CONTENT object::extend($content, { publishedBy: user:ada })`,
      { table, id, content },
    );
  const number = async (table: string, id: string) =>
    (
      await rows<number>(
        migrator,
        `SELECT VALUE number FROM type::record($table, $id)`,
        { table, id },
      )
    )[0];

  beforeAll(async () => {
    t = await TestDatabase.create();
    admin = await t.service('api_admin');
    migrator = await t.migrator();
    publicRead = await t.service('api_public_read');
    await createPeople(t, { ada: 'user_ada', ann: 'user_ann', bo: 'user_bo' });
    await publishDpa(t, 'v1'); // the repo's version, and v1 of the three forms
  });
  afterAll(() => t?.close());

  describe('numbered, kept for ever, unchanged', () => {
    it('numbers privacy policy versions in publishing order; the highest is in force', async () => {
      expect(await number('dpaVersion', 'v1')).toBe(1);
      expect((await publish('dpaVersion', 'p2', policy('Policy two'))).ok).toBe(
        true,
      );
      expect(await number('dpaVersion', 'p2')).toBe(2);
      expect(await rows(migrator, `RETURN fn::legal::dpa_in_force()`)).toEqual([
        'dpaVersion:p2',
      ]);
    });

    it('nobody changes or deletes a published privacy policy version, the migration included', async () => {
      for (const change of [
        `text = 'other words', contentHash = '${sha256('other words')}'`,
        `publishedBy = user:ann`,
        `number = 7`,
        `materiality = 'material'`,
      ]) {
        for (const db of [admin, migrator]) {
          expect([
            change,
            (await outcome(db, `UPDATE dpaVersion:p2 SET ${change}`)).ok,
          ]).toEqual([change, false]);
        }
      }
      // A delete the permissions refuse returns nothing (api-admin); the event refuses the
      // migrator's: either way it's still there, unchanged.
      for (const db of [admin, migrator])
        await outcome(db, `DELETE dpaVersion:p2`);
      expect(
        await rows(migrator, `SELECT VALUE [number, text] FROM dpaVersion:p2`),
      ).toEqual([[2, 'Policy two']]);
    });

    it('a terms version: only api-admin creates one, numbered; nobody changes or deletes it', async () => {
      for (const db of [
        await t.service('api_user'),
        publicRead,
        await t.person('user_ann'),
      ]) {
        expect(
          await rows(
            db,
            `CREATE termsVersion:sneaky CONTENT object::extend($c, { publishedBy: user:ada })`,
            { c: terms('Sneaky') },
          ),
        ).toEqual([]);
      }
      expect((await publish('termsVersion', 't1', terms('Terms one'))).ok).toBe(
        true,
      );
      expect(await number('termsVersion', 't1')).toBe(1);
      for (const db of [admin, migrator]) {
        await outcome(db, `UPDATE termsVersion:t1 SET text = 'x'`);
        await outcome(db, `DELETE termsVersion:t1`);
      }
      expect(
        await rows(
          migrator,
          `SELECT VALUE [text, number] FROM termsVersion:t1`,
        ),
      ).toEqual([['Terms one', 1]]);
    });

    it('an admin version comes whole: its words, their hash and who published it', async () => {
      for (const [what, content] of [
        ['words that aren’t its hash', { ...policy('Words'), text: 'not it' }],
        ['a draft', { ...policy('Words'), status: 'draft' }],
      ] as const) {
        expect([what, (await publish('dpaVersion', 'p9', content)).ok]).toEqual(
          [what, false],
        );
      }
      expect(
        (
          await outcome(admin, `CREATE termsVersion:t9 CONTENT $c`, {
            c: terms('No publisher'),
          })
        ).ok,
      ).toBe(false);
    });

    it('only the migration numbers a repo version published before numbers, once', async () => {
      // As a published version from before D125 is: no number (the field didn't exist). Made
      // without the field's rules, which the next migration puts back.
      await run(
        migrator,
        `REMOVE FIELD number ON dpaVersion;
         CREATE dpaVersion:old CONTENT object::extend($c, { publishedBy: user:ada,
           effectiveFrom: d'2026-01-01' });`,
        { c: policy('Old') },
      );
      await t.migrate(t.params());
      expect(await number('dpaVersion', 'old')).toBeUndefined();
      const give = `UPDATE dpaVersion:old SET number = NONE WHERE number = NONE`;
      expect((await outcome(admin, give)).ok).toBe(false);
      expect((await outcome(migrator, give)).ok).toBe(true);
      expect(await number('dpaVersion', 'old')).toBe(3);
      expect(
        (await outcome(migrator, `UPDATE dpaVersion:old SET text = 'New'`)).ok,
      ).toBe(false);
    });

    it('the public reads the documents, but never who published them', async () => {
      expect(
        await rows(
          publicRead,
          `SELECT VALUE [number, publishedBy] FROM dpaVersion:p2`,
        ),
      ).toEqual([[2, undefined]]);
      expect(
        await rows(
          publicRead,
          `SELECT VALUE [number, publishedBy] FROM termsVersion:t1`,
        ),
      ).toEqual([[1, undefined]]);
      expect(
        await rows(
          admin,
          `SELECT VALUE record::id(publishedBy) FROM termsVersion:t1`,
        ),
      ).toEqual(['ada']);
    });
  });

  describe('consent binds the documents in force (D122)', () => {
    const person = (id: string) => t.person(`user_${id}`);
    /** A grant as the API makes it: the documents in force, evidence v4. */
    const grant = async (who: string, type: string, form: string) =>
      run(
        await person(who),
        `CREATE consent CONTENT { subject: $auth, type: $type, event: 'granted',
           form: <record> $form, dpaVersion: fn::legal::dpa_in_force(),
           termsVersion: IF string::starts_with($form, 'signupFormVersion:withterms') { fn::legal::terms_in_force() } ELSE { NONE },
           mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 4 }`,
        { type, form, h: sha256(`${who} ${type} ${form}`) },
      );
    const state = async (who: string) => {
      const [s] = await rows<{
        signup: boolean;
        testimony: boolean;
        public: boolean;
      }>(
        await person(who),
        `RETURN {
           signup: fn::consent::signup_accepted($auth),
           testimony: fn::consent::testimony_status($auth).acceptanceRequired,
           public: fn::consent::publishable($auth)
         }`,
      );
      return s;
    };

    beforeAll(async () => {
      await publishForm(t, 'signup', 'withterms', { coversTerms: true });
      for (const type of ['age_18plus', 'account_data', 'terms_of_use']) {
        await grant('ann', type, 'signupFormVersion:withterms');
      }
      for (const type of ['special_category_religious', 'publish']) {
        await grant('ann', type, 'testimonyFormVersion:v1');
      }
      await draft(await person('ann'), 'ann_live');
      await submit(await person('ann'), 'ann_live');
      await approve(admin, 'ann_live');
    });

    it('grants bind the privacy policy and terms in force', async () => {
      expect(
        await rows(
          migrator,
          `SELECT VALUE [type, record::id(dpaVersion), record::id(termsVersion) ?? NONE]
             FROM consent WHERE subject = user:ann AND form = signupFormVersion:withterms
             ORDER BY type`,
        ),
      ).toEqual([
        ['account_data', 'old', 't1'],
        ['age_18plus', 'old', 't1'],
        ['terms_of_use', 'old', 't1'],
      ]);
      expect(await state('ann')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
    });

    it('a sign-up grant must name the terms in force; another form’s grant names none', async () => {
      const ann = await person('ann');
      expect(
        (
          await outcome(
            ann,
            `CREATE consent CONTENT { subject: $auth, type: 'terms_of_use', event: 'granted',
               form: signupFormVersion:withterms, dpaVersion: fn::legal::dpa_in_force(),
               mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 4 }`,
            { h: sha256('x') },
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await outcome(
            ann,
            `CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'granted',
               form: testimonyFormVersion:v1, dpaVersion: fn::legal::dpa_in_force(),
               termsVersion: termsVersion:t1,
               mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 4 }`,
            { h: sha256('y') },
          )
        ).ok,
      ).toBe(false);
    });

    it('naming the terms needs evidence v4, which covers them', async () => {
      expect(
        await outcome(
          await person('ann'),
          `CREATE consent CONTENT { subject: $auth, type: 'terms_of_use', event: 'granted',
             form: signupFormVersion:withterms, dpaVersion: fn::legal::dpa_in_force(),
             termsVersion: fn::legal::terms_in_force(),
             mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 3 }`,
          { h: sha256('v3') },
        ),
      ).toEqual({ ok: false, error: expect.stringContaining('evidence v4') });
    });

    it('a new version asks nobody again; stories stay public; new grants bind it', async () => {
      expect(
        (await publish('dpaVersion', 'p4', policy('Policy four'))).ok,
      ).toBe(true);
      expect((await publish('termsVersion', 't2', terms('Terms two'))).ok).toBe(
        true,
      );
      expect(await state('ann')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
      expect(
        await rows(publicRead, 'SELECT VALUE id FROM publicStory:ann_live'),
      ).toEqual(['publicStory:ann_live']);
      for (const type of ['age_18plus', 'account_data', 'terms_of_use']) {
        await grant('bo', type, 'signupFormVersion:withterms');
      }
      expect(
        await rows(
          migrator,
          `SELECT VALUE [record::id(dpaVersion), record::id(termsVersion)]
             FROM consent WHERE subject = user:bo AND type = 'terms_of_use'`,
        ),
      ).toEqual([['p4', 't2']]);
      expect(await state('bo')).toMatchObject({ signup: true });
    });
  });
});

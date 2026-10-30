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
 * D121–D123 (Joel, 2026-10-30): the two legal documents, the privacy policy (dpaVersion) and the
 * terms of use (termsVersion), each a line of versions with a PDF of record (the cleaned copy)
 * beside the web text, kept for ever. Every grant binds the privacy policy in force and, on a
 * sign-up version asking for them, the terms of use in force; a version requiring re-acceptance
 * asks again under D93's rules, and nothing ever hides a story. Evidence v4 covers the PDFs.
 */

const pdf = (c: string) => c.repeat(64);

/** api-admin's publish of a privacy policy version (PublishPrivacyPolicy's row). */
const policy = (id: string, material: boolean, c: string) => ({
  kind: 'standard',
  status: 'published',
  materiality: material ? 'material' : 'minor',
  documentPath: `legal/privacy/${id}/${pdf(c)}.pdf`,
  contentHash: sha256(`policy ${id}`),
  text: `policy ${id}`,
  changeSummary: `Policy ${id}`,
  effectiveFrom: new Date(),
  pdfSha256: pdf(c),
  pdfSize: 1000,
  pdfPath: `legal/privacy/${id}/${pdf(c)}.pdf`,
  originalSha256: pdf('e'),
  originalSize: 1200,
  originalPath: `originals/privacy/${id}/${pdf('e')}.pdf`,
  source: 'admin',
});
/** api-admin's publish of a terms of use version (PublishTerms's row). */
const terms = (id: string, requires: boolean, c: string) => ({
  text: `terms ${id}`,
  textHash: sha256(`terms ${id}`),
  changeNote: `Terms ${id}`,
  requiresReacceptance: requires,
  pdfSha256: pdf(c),
  pdfSize: 900,
  pdfPath: `legal/terms/${id}/${pdf(c)}.pdf`,
  originalSha256: pdf('d'),
  originalSize: 950,
  originalPath: `originals/terms/${id}/${pdf('d')}.pdf`,
  source: 'admin',
});

describe('the legal documents (D121–D123)', () => {
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

  beforeAll(async () => {
    t = await TestDatabase.create();
    admin = await t.service('api_admin');
    migrator = await t.migrator();
    publicRead = await t.service('api_public_read');
    await createPeople(t, { ada: 'user_ada', ann: 'user_ann', bo: 'user_bo' });
    await publishDpa(t, 'v1'); // the repo's version, and v1 of the three forms
  });
  afterAll(() => t?.close());

  describe('kept for ever, unchanged', () => {
    it('api-admin publishes a privacy policy version with its PDF; nobody changes or deletes it', async () => {
      expect(
        await publish('dpaVersion', 'p2', policy('p2', false, 'a')),
      ).toEqual({ ok: true, result: expect.anything() });
      for (const change of [
        `pdfSha256 = '${pdf('b')}'`,
        `text = 'other words'`,
        `changeSummary = 'rewritten'`,
        `publishedBy = user:ann`,
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
        await rows(
          migrator,
          `SELECT VALUE [pdfSha256, text] FROM dpaVersion:p2`,
        ),
      ).toEqual([[pdf('a'), 'policy p2']]);
    });

    it('a terms version: only api-admin creates one, and nobody changes or deletes it', async () => {
      for (const db of [
        await t.service('api_user'),
        publicRead,
        await t.person('user_ann'),
      ]) {
        expect(
          await rows(
            db,
            `CREATE termsVersion:sneaky CONTENT object::extend($c, { publishedBy: user:ada })`,
            { c: terms('sneaky', false, 'c') },
          ),
        ).toEqual([]);
      }
      expect(
        (await publish('termsVersion', 't1', terms('t1', false, 'c'))).ok,
      ).toBe(true);
      for (const db of [admin, migrator]) {
        await outcome(db, `UPDATE termsVersion:t1 SET text = 'x'`);
        await outcome(db, `DELETE termsVersion:t1`);
      }
      expect(
        await rows(
          migrator,
          `SELECT VALUE [text, pdfSha256] FROM termsVersion:t1`,
        ),
      ).toEqual([['terms t1', pdf('c')]]);
    });

    it('an admin version comes whole: its PDF at its path, its original, who published it and a note', async () => {
      const broken: [string, object][] = [
        [
          'a PDF elsewhere',
          { ...policy('p9', false, '1'), pdfPath: 'elsewhere.pdf' },
        ],
        [
          'no original',
          {
            ...policy('p9', false, '1'),
            originalSha256: undefined,
            originalSize: undefined,
            originalPath: undefined,
          },
        ],
        [
          'no change note',
          { ...policy('p9', false, '1'), changeSummary: undefined },
        ],
        [
          'words that aren’t its hash',
          { ...policy('p9', false, '1'), text: 'not it' },
        ],
      ];
      for (const [what, content] of broken) {
        expect([what, (await publish('dpaVersion', 'p9', content)).ok]).toEqual(
          [what, false],
        );
      }
      expect(
        (
          await outcome(admin, `CREATE termsVersion:t9 CONTENT $c`, {
            c: terms('t9', false, '2'),
          })
        ).ok,
      ).toBe(false); // no publisher
    });

    it('only the migration gives a repo version its PDF, once; api-admin never can', async () => {
      const path = `legal/privacy/v1/${pdf('9')}.pdf`;
      const set = `UPDATE dpaVersion:v1 SET pdfSha256 = $p, pdfSize = 10, pdfPath = $path`;
      expect((await outcome(admin, set, { p: pdf('9'), path })).ok).toBe(false);
      expect(
        await rows(migrator, `SELECT VALUE pdfSha256 FROM dpaVersion:v1`),
      ).toEqual([undefined]);
      expect((await outcome(migrator, set, { p: pdf('9'), path })).ok).toBe(
        true,
      );
      expect(
        (
          await outcome(migrator, set, {
            p: pdf('8'),
            path: `legal/privacy/v1/${pdf('8')}.pdf`,
          })
        ).ok,
      ).toBe(false);
    });

    it('the public reads the documents, but never who published them or where the originals are', async () => {
      expect(
        await rows(
          publicRead,
          `SELECT VALUE [pdfSha256, publishedBy, originalPath] FROM dpaVersion:p2`,
        ),
      ).toEqual([[pdf('a'), undefined, undefined]]);
      expect(
        await rows(
          publicRead,
          `SELECT VALUE [pdfSha256, publishedBy, originalPath] FROM termsVersion:t1`,
        ),
      ).toEqual([[pdf('c'), undefined, undefined]]);
      expect(
        await rows(
          admin,
          `SELECT VALUE record::id(publishedBy) FROM termsVersion:t1`,
        ),
      ).toEqual(['ada']);
    });
  });

  describe('consent binds the documents in force, and asks again under D93 (D122)', () => {
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
      for (const who of ['ann', 'bo']) {
        for (const type of ['age_18plus', 'account_data', 'terms_of_use']) {
          await grant(who, type, 'signupFormVersion:withterms');
        }
        for (const type of ['special_category_religious', 'publish']) {
          await grant(who, type, 'testimonyFormVersion:v1');
        }
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
        ['account_data', 'p2', 't1'],
        ['age_18plus', 'p2', 't1'],
        ['terms_of_use', 'p2', 't1'],
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

    it('evidence v4 only where the privacy policy has a PDF, and always then', async () => {
      const ann = await person('ann');
      expect(
        await outcome(
          ann,
          `CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'granted',
             form: testimonyFormVersion:v1, dpaVersion: fn::legal::dpa_in_force(),
             mechanism: 'web_form_submission', evidenceHash: $h, evidenceVersion: 3 }`,
          { h: sha256('v3') },
        ),
      ).toEqual({ ok: false, error: expect.stringContaining('evidence v4') });
    });

    it('a minor privacy policy asks nobody again; new grants bind it', async () => {
      expect(
        (await publish('dpaVersion', 'p3', policy('p3', false, '3'))).ok,
      ).toBe(true);
      expect(await state('ann')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
    });

    it('a privacy policy requiring re-acceptance: sign-up and new stories wait, stories stay public', async () => {
      expect(
        (await publish('dpaVersion', 'p4', policy('p4', true, '4'))).ok,
      ).toBe(true);
      expect(await state('ann')).toEqual({
        signup: false,
        testimony: true,
        public: true,
      });
      expect(
        await rows(publicRead, 'SELECT VALUE id FROM publicStory:ann_live'),
      ).toEqual(['publicStory:ann_live']);
      expect(await draft(await person('ann'), 'ann_blocked')).toEqual([]);
      // Accepting again binds the version in force and settles it.
      for (const type of ['age_18plus', 'account_data', 'terms_of_use']) {
        await grant('ann', type, 'signupFormVersion:withterms');
      }
      await grant(
        'ann',
        'special_category_religious',
        'testimonyFormVersion:v1',
      );
      expect(await state('ann')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
      expect(await draft(await person('ann'), 'ann_next')).toHaveLength(1);
    });

    it('terms requiring re-acceptance ask again at sign-in only; terms that don’t ask nobody', async () => {
      // Bo agreed before the privacy policy requiring re-acceptance (above): settle him first.
      for (const type of ['age_18plus', 'account_data', 'terms_of_use']) {
        await grant('bo', type, 'signupFormVersion:withterms');
      }
      await grant(
        'bo',
        'special_category_religious',
        'testimonyFormVersion:v1',
      );
      expect(await state('bo')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
      expect(
        (await publish('termsVersion', 't2', terms('t2', false, '5'))).ok,
      ).toBe(true);
      expect(await state('bo')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
      expect(
        (await publish('termsVersion', 't3', terms('t3', true, '6'))).ok,
      ).toBe(true);
      expect(await state('bo')).toEqual({
        signup: false,
        testimony: false,
        public: true,
      });
      await grant('bo', 'terms_of_use', 'signupFormVersion:withterms');
      expect(await state('bo')).toEqual({
        signup: true,
        testimony: false,
        public: true,
      });
    });
  });
});

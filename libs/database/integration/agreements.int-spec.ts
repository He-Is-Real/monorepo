import type { Surreal } from 'surrealdb';
import {
  agree,
  agreeAll,
  createPeople,
  LEGAL_TABLES,
  outcome,
  publishVersion,
  rows,
  run,
  shareStory,
  TestDatabase,
} from './support/harness';
import { approve, draft, ERASE, grantUpload, submit } from './support/world';

/**
 * Plan 4e (Joel, 2026-10-31 and 2026-11-01): the four immutable version tables, the pointers on
 * the user and the story, and "agree first" enforced by the database on the person's own writes.
 */
describe('consent, privacy and terms (plan 4e)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    apiUser = await t.service('api_user');
    await createPeople(t, {
      ann: 'user_ann',
      bob: 'user_bob',
      cat: 'user_cat',
      dan: 'user_dan',
    });
  });
  afterAll(() => t?.close());

  describe('the version tables', () => {
    it('the migration seeds version 0 of each, and everyone reads them', async () => {
      const ann = await t.person('user_ann');
      const publicRead = await t.service('api_public_read');
      for (const table of LEGAL_TABLES) {
        for (const db of [ann, publicRead, admin]) {
          const found = await rows<{ id: number; release_date: string }>(
            db,
            `SELECT record::id(id) AS id, content, release_date FROM type::table($table)`,
            { table },
          );
          expect(found).toHaveLength(1);
          expect(found[0]?.id).toBe(0);
          expect(found[0]?.release_date).toBeTruthy();
        }
      }
    });

    it('only api-admin saves a version, as the next number, at the database’s time', async () => {
      const t2 = await TestDatabase.create();
      try {
        for (const service of [
          'api_user',
          'api_public_read',
          'workflow',
        ] as const) {
          const r = await outcome(
            await t2.service(service),
            `CREATE privacyNotice:1 CONTENT { content: 'Mine' }`,
          );
          const n = await rows(
            await t2.migrator(),
            `SELECT VALUE id FROM privacyNotice`,
          );
          expect({ service, r: r.ok && r.result, n: n.length }).toMatchObject({
            n: 1,
          });
        }
        await createPeople(t2, { eve: 'user_eve' });
        const eve = await t2.person('user_eve');
        await outcome(
          eve,
          `CREATE privacyNotice:1 CONTENT { content: 'Mine' }`,
        );
        expect(
          await rows(await t2.migrator(), `SELECT VALUE id FROM privacyNotice`),
        ).toHaveLength(1);

        const skip = await outcome(
          await t2.service('api_admin'),
          `CREATE privacyNotice:2 CONTENT { content: 'Skips 1' }`,
        );
        expect(skip).toMatchObject({ ok: false });
        expect(!skip.ok && skip.error).toContain('legal_version_number');

        const before = new Date();
        const saved = await rows<{ release_date: string }>(
          await t2.service('api_admin'),
          `CREATE privacyNotice:1 CONTENT { content: 'Version one', release_date: d'2001-01-01T00:00:00Z' }`,
        );
        expect(
          new Date(saved[0]?.release_date ?? 0).getTime(),
        ).toBeGreaterThanOrEqual(before.getTime() - 5000);
        expect(await publishVersion(t2, 'privacyNotice')).toBe(2);
      } finally {
        await t2.close();
      }
    });

    it('nobody changes or deletes a saved version, the migrator included', async () => {
      for (const db of [admin, migrator]) {
        for (const sql of [
          `UPDATE testimonyConsent:0 SET content = 'Changed'`,
          `DELETE testimonyConsent:0`,
          `UPSERT testimonyConsent:0 CONTENT { content: 'Changed' }`,
        ]) {
          await outcome(db, sql);
        }
      }
      const [row] = await truth<{ content: string }>(
        `SELECT content FROM testimonyConsent:0`,
      );
      expect(row?.content).not.toBe('Changed');
      const migratorTry = await outcome(
        migrator,
        `UPDATE testimonyConsent:0 SET content = 'Changed'`,
      );
      expect(!migratorTry.ok && migratorTry.error).toContain(
        'legal_version_kept',
      );
    });
  });

  describe('the pointers', () => {
    it('only the person’s own session agrees, to the latest version, with the database’s time', async () => {
      // No service or admin agrees on someone's behalf.
      for (const db of [admin, apiUser, await t.service('workflow')]) {
        await outcome(
          db,
          `UPDATE user:bob SET termsOfUse = termsOfUseAgreement:0, termsOfUseAgreedAt = time::now()`,
        );
      }
      const ann = await t.person('user_ann');
      // Nor does another person.
      await outcome(
        ann,
        `UPDATE user:bob SET termsOfUse = termsOfUseAgreement:0, termsOfUseAgreedAt = time::now()`,
      );
      expect(await truth(`SELECT VALUE termsOfUse FROM ONLY user:bob`)).toEqual(
        [],
      );

      // A time sent by the client is never kept, and the two travel together.
      const done = await outcome(
        ann,
        `UPDATE $auth SET termsOfUse = termsOfUseAgreement:0,
           termsOfUseAgreedAt = d'2001-01-01T00:00:00Z'`,
      );
      expect(done.ok).toBe(true);
      const [mine] = await truth<{ v: number; at: string }>(
        `SELECT record::id(termsOfUse) AS v, termsOfUseAgreedAt AS at FROM ONLY user:ann`,
      );
      expect(mine?.v).toBe(0);
      expect(new Date(mine?.at ?? 0).getFullYear()).toBeGreaterThan(2020);

      const alone = await outcome(
        ann,
        `UPDATE $auth SET testimonyConsent = testimonyConsent:0`,
      );
      expect(!alone.ok && alone.error).toContain('agreement_time');
      const timeAlone = await outcome(
        ann,
        `UPDATE $auth SET termsOfUseAgreedAt = time::now() + 1h`,
      );
      expect(!timeAlone.ok && timeAlone.error).toContain('agreement_time');
    });

    it('refuses a version that is no longer the latest (the page shows the change), and never clears one', async () => {
      const cat = await t.person('user_cat');
      expect((await agree(cat, 'testimonyConsent', 0)).length).toBe(1);
      const next = await publishVersion(t, 'testimonyConsent', 'Version one');
      const tooOld = await outcome(
        await t.person('user_dan'),
        `UPDATE $auth SET testimonyConsent = testimonyConsent:0, testimonyConsentAgreedAt = time::now()`,
      );
      expect(!tooOld.ok && tooOld.error).toContain('agreement_version_changed');
      expect((await agree(cat, 'testimonyConsent', next)).length).toBe(1);
      expect(
        await truth(
          `SELECT VALUE record::id(testimonyConsent) FROM ONLY user:cat`,
        ),
      ).toEqual([next]);

      const cleared = await outcome(
        cat,
        `UPDATE $auth SET testimonyConsent = NONE, testimonyConsentAgreedAt = NONE`,
      );
      expect(!cleared.ok && cleared.error).toContain('agreement_kept');
      const back = await outcome(
        cat,
        `UPDATE $auth SET testimonyConsent = testimonyConsent:0, testimonyConsentAgreedAt = time::now()`,
      );
      expect(!back.ok && back.error).toContain('agreement_version_changed');
    });

    it('a person writes nothing else on their own row', async () => {
      const ann = await t.person('user_ann');
      await outcome(ann, `UPDATE $auth SET gdprDeletedAt = time::now()`);
      await outcome(ann, `UPDATE $auth SET clerkUserId = 'user_someone_else'`);
      expect(
        await truth(`SELECT clerkUserId, gdprDeletedAt FROM ONLY user:ann`),
      ).toEqual([{ clerkUserId: 'user_ann' }]);
    });
  });

  describe('agree first (Q2)', () => {
    let t3: TestDatabase;
    let pat: Surreal;
    beforeAll(async () => {
      t3 = await TestDatabase.create();
      await createPeople(t3, { pat: 'user_pat' });
      pat = await t3.person('user_pat');
    });
    afterAll(() => t3?.close());

    it('stores no story, and no heart, before the latest terms and testimony consent', async () => {
      const noTerms = await outcome(
        pat,
        `CREATE story:p1 CONTENT { submitter: $auth, slug: 'p1', title: 'T', description: 'D', primaryFormat: 'written', body: 'B' }`,
      );
      expect(!noTerms.ok && noTerms.error).toContain(
        'terms_agreement_required',
      );
      await agree(pat, 'termsOfUse');
      const noTestimony = await draft(pat, 'p1').catch((e: Error) => e.message);
      expect(String(noTestimony)).toContain('testimony_consent_required');
      expect(
        await rows(await t3.migrator(), `SELECT VALUE id FROM story`),
      ).toEqual([]);
      await agree(pat, 'testimonyConsent');
      expect(await draft(pat, 'p1')).toHaveLength(1);
    });

    it('a newer testimony consent stops edits, uploads and submission until re-agreed; withdrawing never', async () => {
      await draft(pat, 'p2');
      await publishVersion(t3, 'testimonyConsent', 'Version one');
      const edit = await outcome(pat, `UPDATE story:p2 SET title = 'New'`);
      expect(!edit.ok && edit.error).toContain('testimony_consent_required');
      const [{ version }] = await rows<{ version: number }>(
        await t3.migrator(),
        `SELECT version FROM ONLY story:p2`,
      ).then((r) => r as [{ version: number }]);
      const upload = await grantUpload(await t3.service('api_user'), {
        video: 'vid-p2',
        story: 'p2',
        person: 'pat',
        version,
      });
      expect(!upload.ok && upload.error).toContain(
        'testimony_consent_required',
      );
      const withdraw = await outcome(
        pat,
        `UPDATE story:p1 SET status = 'withdrawn'`,
      );
      expect(withdraw.ok).toBe(true);
      await agree(pat, 'testimonyConsent');
      expect((await outcome(pat, `UPDATE story:p2 SET title = 'New'`)).ok).toBe(
        true,
      );
    });

    it('newer terms stop a heart until re-agreed', async () => {
      const t4 = await TestDatabase.create();
      try {
        await createPeople(t4, { quin: 'user_quin', rae: 'user_rae' });
        const quin = await t4.person('user_quin');
        const rae = await t4.person('user_rae');
        await agreeAll(quin);
        await agreeAll(rae);
        await draft(rae, 'r1');
        await submit(rae, 'r1');
        await approve(await t4.service('api_admin'), 'r1');
        await publishVersion(t4, 'termsOfUseAgreement', 'Terms one');
        const heart = await outcome(
          quin,
          `CREATE favourite SET person = $auth, story = story:r1`,
        );
        expect(!heart.ok && heart.error).toContain('terms_agreement_required');
        await agree(quin, 'termsOfUse');
        expect(
          (
            await outcome(
              quin,
              `CREATE favourite SET person = $auth, story = story:r1`,
            )
          ).ok,
        ).toBe(true);
      } finally {
        await t4.close();
      }
    });
  });

  describe('social media sharing (per story)', () => {
    it('is the story owner’s own, on the latest version, recorded with the submission', async () => {
      const dan = await t.person('user_dan');
      await agreeAll(dan);
      await draft(dan, 'd1');
      const [before] = await truth<{ v: number }>(
        `SELECT version AS v FROM ONLY story:d1`,
      );
      // Others can't tick it for the person.
      await outcome(
        admin,
        `UPDATE story:d1 SET socialMediaSharingConsent = socialMediaSharingConsent:0, socialMediaSharingConsentAgreedAt = time::now()`,
      );
      expect(
        await truth(
          `SELECT VALUE socialMediaSharingConsent FROM ONLY story:d1`,
        ),
      ).toEqual([]);
      const both = await outcome(
        dan,
        `UPDATE story:d1 SET status = 'pending',
           socialMediaSharingConsent = fn::legal::latest('socialMediaSharingConsent'),
           socialMediaSharingConsentAgreedAt = time::now()`,
      );
      expect(both.ok).toBe(true);
      const [after] = await truth<{ v: number; s: string; at: string }>(
        `SELECT version AS v, status AS s, socialMediaSharingConsentAgreedAt AS at FROM ONLY story:d1`,
      );
      expect(after).toMatchObject({ v: (before?.v ?? 0) + 1, s: 'pending' });
      expect(after?.at).toBeTruthy();
    });

    it('refuses a sharing version that is no longer the latest', async () => {
      const dan = await t.person('user_dan');
      await draft(dan, 'd2');
      await publishVersion(t, 'socialMediaSharingConsent', 'Sharing one');
      const stale = await outcome(
        dan,
        `UPDATE story:d2 SET socialMediaSharingConsent = socialMediaSharingConsent:0,
           socialMediaSharingConsentAgreedAt = time::now()`,
      );
      expect(!stale.ok && stale.error).toContain('agreement_version_changed');
      expect((await shareStory(dan, 'story:d2')).length).toBe(1);
    });
  });

  describe('publishing and erasure', () => {
    it('approving needs the submitter’s testimony consent, whoever approves', async () => {
      await run(
        migrator,
        `CREATE user:legacy CONTENT {};
         CREATE story:legacy CONTENT { submitter: user:legacy, slug: 'legacy', title: 'T',
           description: 'D', primaryFormat: 'written', body: $body, status: 'pending',
           themeRefs: [theme:common] };`,
        { body: 'x'.repeat(250) },
      );
      const r = await outcome(
        admin,
        `UPDATE story:legacy SET status = 'approved', approvedAt = time::now()`,
      );
      expect(!r.ok && r.error).toContain('testimony_consent_required');
    });

    it('deleting the account is the withdrawal: the stub keeps no agreement', async () => {
      const ann = await t.person('user_ann');
      await agree(ann, 'testimonyConsent');
      await run(apiUser, ERASE, {
        clerkUserId: 'user_ann',
        reason: 'account_deleted',
      });
      const [stub] = await truth<Record<string, unknown>>(
        `SELECT * FROM ONLY user:ann`,
      );
      expect(Object.keys(stub ?? {}).sort()).toEqual([
        'createdAt',
        'gdprDeletedAt',
        'id',
      ]);
      const audit = await truth<Record<string, unknown>>(
        `SELECT * FROM auditLog WHERE entity = user:ann`,
      );
      expect(JSON.stringify(audit)).not.toMatch(/consent/i);
    });
  });
});

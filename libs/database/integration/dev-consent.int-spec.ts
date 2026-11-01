import type { Surreal } from 'surrealdb';
import {
  createPeople,
  DPA_V1_SHA256,
  type MigrationParams,
  outcome,
  publishDpa,
  rows,
  run,
  SERVICES,
  sha256,
  TestDatabase,
} from './support/harness';
import { approve, draft, submit } from './support/world';

/**
 * D48: consent checks relaxed in dev only, behind one switch. OpenTofu's `dev_consent_relaxed`
 * (declared only in live/dev/cluster; the modules refuse it outside dev) reaches the runner as a
 * parameter, and the runner writes it, with the environment, to `_setting:consent` in the schema
 * step. `fn::consent::granted` (the table permission, the consent events, the read-model mirror
 * and libs/consent's guard all go through it) reads that row through `fn::consent::relaxed()`.
 *
 * Off is the default: every other suite runs with it off, so the real rules are tested on every
 * PR. The row, not a DEFINE PARAM: a caller's bound variable shadows a defined param inside a
 * function (3.2.4), so a person could have switched it on for their own query.
 */
const RELAXED = 'RETURN fn::consent::relaxed()';

async function setting(t: TestDatabase) {
  return (
    await rows(
      await t.migrator(),
      'SELECT devConsentRelaxed, environment FROM _setting:consent',
    )
  )[0];
}

describe('relaxed consent in dev (D48)', () => {
  describe('off (the default)', () => {
    let t: TestDatabase;
    beforeAll(async () => {
      t = await TestDatabase.create();
      await createPeople(t, { olive: 'user_olive' });
      await publishDpa(t, 'v1');
    });
    afterAll(() => t?.close());

    it('is recorded as off, and every session reads it as off', async () => {
      expect(await setting(t)).toEqual({ devConsentRelaxed: false });
      for (const name of SERVICES) {
        expect(await rows(await t.service(name), RELAXED)).toEqual([false]);
      }
      expect(await rows(await t.person('user_olive'), RELAXED)).toEqual([
        false,
      ]);
    });

    it('keeps the real rules: no consent, no story', async () => {
      const olive = await t.person('user_olive');
      expect(await draft(olive, 'olive_story')).toEqual([]);
    });

    it('can’t be switched on by a bound variable', async () => {
      const olive = await t.person('user_olive');
      const vars = {
        devConsentRelaxed: true,
        dev_consent_relaxed: true,
        environment: 'dev',
        relaxed: true,
        s: { devConsentRelaxed: true, environment: 'dev' },
      };
      expect(await rows(olive, RELAXED, vars)).toEqual([false]);
      expect(
        await rows(
          olive,
          `RETURN fn::consent::granted($auth, ['special_category_religious'])`,
          vars,
        ),
      ).toEqual([false]);
      expect(
        await rows(
          olive,
          `CREATE story CONTENT { themeRefs: [theme:common], submitter: $auth, slug: 'bound', title: 't',
             description: 'd', primaryFormat: 'written', body: 'x' }`,
          vars,
        ),
      ).toEqual([]);
    });

    it('can’t be written by any service or person, only read', async () => {
      const writes = [
        `UPSERT _setting:consent SET devConsentRelaxed = true, environment = 'dev'`,
        `UPDATE _setting:consent SET devConsentRelaxed = true, environment = 'dev'`,
        `DELETE _setting:consent`,
        `CREATE _setting:other SET devConsentRelaxed = true, environment = 'dev'`,
      ];
      const sessions: Surreal[] = [
        ...(await Promise.all(SERVICES.map((s) => t.service(s)))),
        await t.person('user_olive'),
      ];
      for (const db of sessions) {
        expect(
          await rows(db, 'SELECT devConsentRelaxed FROM _setting:consent'),
        ).toEqual([{ devConsentRelaxed: false }]);
        for (const sql of writes) await outcome(db, sql);
      }
      expect(
        await rows(
          await t.migrator(),
          'SELECT record::id(id) AS id, devConsentRelaxed FROM _setting',
        ),
      ).toEqual([{ id: 'consent', devConsentRelaxed: false }]);
    });
  });

  describe('on, in dev', () => {
    let t: TestDatabase;
    let admin: Surreal;
    const on = (): MigrationParams =>
      t.params({ dev_consent_relaxed: true, environment: 'dev' });

    beforeAll(async () => {
      t = await TestDatabase.create({ migrate: false });
      const summary = await t.migrate(on());
      expect(summary.devConsentRelaxed).toBe(true);
      await t.createServices();
      await t.createCommonTheme();
      await createPeople(t, { dana: 'user_dana', moderator: 'user_mod' });
      await publishDpa(t, 'v1');
      admin = await t.service('api_admin');
    });
    afterAll(() => t?.close());

    it('is recorded and read as on', async () => {
      expect(await setting(t)).toEqual({
        devConsentRelaxed: true,
        environment: 'dev',
      });
      expect(await rows(await t.person('user_dana'), RELAXED)).toEqual([true]);
      expect(await rows(admin, RELAXED)).toEqual([true]);
    });

    it('lets a dummy person without consent rows create, submit and be published', async () => {
      const dana = await t.person('user_dana');
      expect(await draft(dana, 'dana_story')).toHaveLength(1);
      expect(await submit(dana, 'dana_story')).toHaveLength(1);
      await approve(admin, 'dana_story');
      expect(
        await rows(
          await t.service('api_public_read'),
          'SELECT VALUE slug FROM publicStory',
        ),
      ).toEqual(['dana_story']);
    });

    it('answers the consent guard’s question (fn::consent::granted) with yes', async () => {
      const dana = await t.person('user_dana');
      expect(
        await rows(
          dana,
          `RETURN fn::consent::granted($auth, ['special_category_religious', 'publish', 'age_18plus'])`,
        ),
      ).toEqual([true]);
      expect(
        await rows(
          admin,
          `RETURN fn::consent::granted(story:dana_story.submitter, ['publish'])`,
        ),
      ).toEqual([true]);
      // Nobody: still no.
      expect(
        await rows(dana, `RETURN fn::consent::granted(NONE, ['publish'])`),
      ).toEqual([false]);
    });

    it('leaves the ledger itself alone: nothing is granted that wasn’t', async () => {
      const [story] = await rows(
        await t.migrator(),
        'SELECT VALUE consent FROM ONLY story:dana_story',
      );
      expect(story).toEqual({});
      expect(
        await rows(
          await t.person('user_dana'),
          'SELECT * FROM consent WHERE subject = $auth',
        ),
      ).toEqual([]);
    });

    it('keeps the ledger’s own rules: no consent without a published form version', async () => {
      await run(
        admin,
        `CREATE dpaVersion:v2_draft CONTENT { materiality: 'material',
           documentPath: 'libs/legal/dpa/v2.md', contentHash: $h }`,
        { h: sha256('v2') },
      );
      const result = await outcome(
        await t.person('user_dana'),
        `CREATE consent CONTENT { subject: $auth, type: 'publish', event: 'granted',
           dpaVersion: dpaVersion:v2_draft, mechanism: 'web_form_submission', evidenceHash: $h }`,
        { h: sha256('x') },
      );
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('form version'),
      });
    });

    it('switches off again with the next migration', async () => {
      const summary = await t.migrate(
        t.params({ dpa_sha256: { v1: DPA_V1_SHA256, v2_draft: sha256('v2') } }),
      );
      expect(summary.devConsentRelaxed).toBe(false);
      expect(await setting(t)).toEqual({ devConsentRelaxed: false });
      const dana = await t.person('user_dana');
      expect(await draft(dana, 'dana_second')).toEqual([]);
    });
  });

  describe('refused outside dev', () => {
    let t: TestDatabase;
    beforeAll(async () => {
      t = await TestDatabase.create();
    });
    afterAll(() => t?.close());

    it.each([
      ['prod', 'prod'],
      ['an unknown environment', null],
    ])(
      'in %s: the migration fails and the setting stays off',
      async (_name, environment) => {
        const run = await t.runMigration(
          t.params({ dev_consent_relaxed: true, environment }),
        );
        expect(run.exitCode).toBe(1);
        expect(run.output).toContain(
          'consent checks can be relaxed in dev only (D48)',
        );
        expect(await setting(t)).toEqual({ devConsentRelaxed: false });
      },
    );

    it('by the database too, whoever writes the row (even the migrator)', async () => {
      expect(
        await outcome(
          await t.migrator(),
          `UPSERT _setting:consent SET devConsentRelaxed = true, environment = 'prod'`,
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining(
          'consent checks can be relaxed in dev only (D48)',
        ),
      });
    });
  });
});

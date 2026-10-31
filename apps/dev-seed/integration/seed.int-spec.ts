import {
  outcome,
  rows,
  run,
  type TestDatabase,
} from '@heisreal/database/integration-testing';
import { createHash } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import { DATASET } from '../src/app/dataset';
import bunnyMedia from '../src/app/bunny-media.json';
import type { BunnyMedia } from '../src/app/media';
import { buildVars, fakeUploads } from '../src/app/plan';
import { reset, RESET_SQL } from '../src/app/seed';
import { devDatabase } from '../testing';

/**
 * D49: the dev-seed reset against SurrealDB 3.2.4 with the real schema, as the dev-only `dev_seed`
 * system user (EDITOR) that SurrealDB's startup init creates when OpenTofu's dev_seed_login is
 * on. Every event runs, so this is the test that the D47 dataset fits the schema: types and
 * shapes (D53), text limits (A3, the 200-character minimum), the approval gate (A2) and the
 * read model's mirror check. Uploads are stand-ins (fakeUploads) with the media spec's sizes.
 */
const vars = () => buildVars(DATASET, fakeUploads());
const approved = DATASET.stories.filter((s) => s.status === 'approved');

describe('dev-seed reset on SurrealDB (dev: placeholder forms, consent enforced)', () => {
  let t: TestDatabase;
  let seeder: Surreal;

  beforeAll(async () => {
    ({ t, seeder } = await devDatabase({
      legalPlaceholders: true,
      environment: 'dev',
    }));
  });
  afterAll(() => t.close());

  it('loads the whole dataset', async () => {
    const summary = await reset(seeder, vars());
    const expected: Record<string, number> = {};
    for (const s of DATASET.stories)
      expected[s.status] = (expected[s.status] ?? 0) + 1;
    expect(summary).toEqual({
      byStatus: expected,
      publicStories: approved.length,
      reviews: DATASET.stories.reduce(
        (n, s) => n + (s.reviews?.length ?? 0),
        0,
      ),
      themes: DATASET.themes.length,
      fixturePeople: DATASET.people.length + 1,
    });
  });

  it('loads with the committed media record (the uploaded dev media)', async () => {
    const summary = await reset(
      seeder,
      buildVars(DATASET, bunnyMedia as BunnyMedia),
    );
    expect(summary.publicStories).toBe(approved.length);
    await reset(seeder, vars()); // back to the stand-ins for the tests below
  });

  it('gives every fixture person real consent on the forms in force, so the published stories pass the real checks (D75)', async () => {
    const migrator = await t.migrator();
    expect(await rows(migrator, 'RETURN fn::consent::relaxed()')).toEqual([
      false,
    ]);
    const people = [...DATASET.people, DATASET.moderator];
    for (const id of people) {
      expect([
        id,
        await rows(
          migrator,
          `LET $u = type::record('user', $id);
           RETURN [fn::consent::signup_accepted($u),
             fn::consent::granted($u, ['special_category_religious', 'publish', 'age_18plus'])]`,
          { id },
        ),
      ]).toEqual([id, [true, true]]);
    }
    // Every grant's evidence is the API's v4 hash of what it names (D125: the privacy policy in
    // force, and on the sign-up form the terms in force), computed independently.
    const ledger = await rows<Record<string, string>>(
      migrator,
      `SELECT type, event, mechanism, evidenceHash, record::tb(form) AS table,
         record::id(form) AS version, form.textHash AS textHash,
         form.statementsHash AS statementsHash, evidenceVersion,
         record::id(dpaVersion) AS dpa, dpaVersion.contentHash AS dpaHash,
         IF termsVersion = NONE { NONE } ELSE { record::id(termsVersion) } AS terms,
         termsVersion.contentHash AS termsHash
       FROM consent`,
    );
    expect(ledger).toHaveLength(people.length * 5);
    // D109: 18+ is ticked on the sign-up form only, and nobody ticks sharing.
    expect(
      [...new Set(ledger.map((r) => `${r['type']} ${r['table']}`))].sort(),
    ).toEqual([
      'account_data signupFormVersion',
      'age_18plus signupFormVersion',
      'publish testimonyFormVersion',
      'special_category_religious testimonyFormVersion',
      'terms_of_use signupFormVersion',
    ]);
    for (const r of ledger) {
      expect(r['evidenceVersion']).toBe(4);
      const signup = r['table'] === 'signupFormVersion';
      expect([r['type'], r['dpa'], r['terms'] ?? null]).toEqual([
        r['type'],
        'dev_policy',
        signup ? 'dev_placeholder' : null,
      ]);
      expect(r['evidenceHash']).toBe(
        createHash('sha256')
          .update(
            JSON.stringify([
              'heisreal-consent-evidence/v4',
              signup ? 'signup' : 'testimony',
              r['version'],
              r['textHash'],
              r['statementsHash'],
              r['dpa'],
              r['dpaHash'],
              signup ? r['terms'] : null,
              signup ? r['termsHash'] : null,
              r['type'],
              r['event'],
              r['mechanism'],
            ]),
          )
          .digest('hex'),
      );
    }
    // A reset doesn't grant again while the grants are on the versions in force.
    await reset(seeder, vars());
    expect(
      await rows(migrator, 'SELECT count() AS n FROM consent GROUP ALL'),
    ).toEqual([{ n: people.length * 5 }]);
  });

  it('is idempotent: a second reset gives the same data', async () => {
    const before = await rows(
      await t.migrator(),
      'SELECT id, slug, status FROM story ORDER BY id',
    );
    await reset(seeder, vars());
    const after = await rows(
      await t.migrator(),
      'SELECT id, slug, status FROM story ORDER BY id',
    );
    expect(after).toEqual(before);
  });

  it('every story fits the schema’s rules, approved ones the approval gate too', async () => {
    const migrator = await t.migrator();
    expect(
      await rows(
        migrator,
        'SELECT VALUE id FROM story WHERE fn::story::shape_problem($this) != NONE',
      ),
    ).toEqual([]);
    expect(
      await rows(
        migrator,
        "SELECT VALUE id FROM story WHERE status = 'approved' AND fn::story::approval_problem($this) != NONE",
      ),
    ).toEqual([]);
  });

  it('walks each story through the real states: submitted, reviewed, versions', async () => {
    const migrator = await t.migrator();
    const [v03] = await rows<{
      version: number;
      submittedAt: unknown;
      approvedAt: unknown;
      feedback: unknown;
    }>(
      migrator,
      'SELECT version, submittedAt, approvedAt, rejectionFeedback AS feedback FROM story:seed_v03',
    );
    expect(v03.version).toBe(7); // create + 6 moves (sent back once, then approved)
    expect(v03.submittedAt).toBeTruthy();
    expect(v03.approvedAt).toBeTruthy();
    expect(v03.feedback).toBeUndefined();
    const reviews = await rows<{ decision: string; storyVersion: number }>(
      migrator,
      'SELECT decision, storyVersion, decidedAt FROM moderationReview WHERE story = story:seed_v03 ORDER BY decidedAt, storyVersion',
    );
    expect(reviews.map((r) => [r.decision, r.storyVersion])).toEqual([
      ['request_changes', 3],
      ['approve', 6],
    ]);
    const [sentBack] = await rows<{ feedback: string; lockedBy: unknown }>(
      migrator,
      'SELECT rejectionFeedback AS feedback, lockedBy FROM story:seed_w10',
    );
    expect(sentBack.feedback).toContain('test feedback');
    expect(sentBack.lockedBy).toBeUndefined();
    const [inReview] = await rows<{ lockedBy: unknown }>(
      migrator,
      'SELECT lockedBy FROM story:seed_v09',
    );
    expect(String(inReview.lockedBy)).toBe('user:seed_moderator');
    const [draft] = await rows<{ submittedAt: unknown }>(
      migrator,
      'SELECT submittedAt FROM story:seed_w11',
    );
    expect(draft.submittedAt).toBeUndefined();
  });

  it('publishes exactly the approved stories, which api-public-read can read', async () => {
    const reader = await t.service('api_public_read');
    const slugs = await rows<string>(
      reader,
      'SELECT VALUE slug FROM publicStory ORDER BY slug',
    );
    expect(slugs).toEqual(approved.map((s) => s.slug).sort());
    const [skeleton] = await rows<{ title: string; publishedAt: unknown }>(
      reader,
      "SELECT title, publishedAt FROM publicStory WHERE slug = 'test-story-walking-skeleton'",
    );
    expect(skeleton.title).toBe('Test story: the walking skeleton');
    const [w01] = await rows<{ image: unknown }>(
      reader,
      'SELECT image FROM publicStory:seed_w01',
    );
    expect(w01.image).toEqual({
      path: 'dev-seed/image-01.webp',
      width: 1200,
      height: 1600,
      alt: 'A test pattern with a label (dummy image)',
    });
  });

  it('keeps people who aren’t fixtures, removes their content and stale fixtures', async () => {
    const migrator = await t.migrator();
    await run(
      migrator,
      `CREATE user:someone_real SET clerkUserId = 'user_test_real';
       CREATE user:seed_old;
       CREATE story:their_draft CONTENT {
         submitter: user:someone_real, slug: 'their-draft', title: 'Theirs', description: '',
         body: 'A draft', primaryFormat: 'written'
       };`,
    );
    await reset(seeder, vars());
    expect(
      await rows(migrator, 'SELECT VALUE id FROM user:someone_real'),
    ).toHaveLength(1);
    expect(await rows(migrator, 'SELECT VALUE id FROM user:seed_old')).toEqual(
      [],
    );
    expect(
      await rows(migrator, 'SELECT VALUE id FROM story:their_draft'),
    ).toEqual([]);
  });

  it('marks dev’s Clerk test accounts trusted submitters, signed in before or not (D112)', async () => {
    const migrator = await t.migrator();
    await run(
      migrator,
      `CREATE user:tester_known SET clerkUserId = 'user_tester_known'`,
    );
    const withAccounts = {
      ...vars(),
      testAccounts: ['user_tester_known', 'user_tester_new'],
    };
    await reset(seeder, withAccounts);
    await reset(seeder, withAccounts); // idempotent
    expect(
      await rows(
        migrator,
        `SELECT user.clerkUserId AS clerk, trusted, devSeed FROM submitterLimits
           WHERE user.clerkUserId IN ['user_tester_known', 'user_tester_new'] ORDER BY clerk`,
      ),
    ).toEqual([
      { clerk: 'user_tester_known', trusted: true, devSeed: true },
      { clerk: 'user_tester_new', trusted: true, devSeed: true },
    ]);
    expect(
      await rows(
        migrator,
        `SELECT VALUE id FROM user WHERE clerkUserId = 'user_tester_new'`,
      ),
    ).toHaveLength(1);
  });

  it('is one transaction: a failure leaves the data as it was', async () => {
    const migrator = await t.migrator();
    const before = await rows(
      migrator,
      'SELECT count() AS n FROM story GROUP ALL',
    );
    const broken = vars();
    broken.stories[broken.stories.length - 1].draft['primaryFormat'] = 'video'; // no media: refused
    broken.stories[broken.stories.length - 1].steps = [{ status: 'pending' }];
    await expect(reset(seeder, broken)).rejects.toThrow(
      /needs its video before it is submitted/,
    );
    expect(
      await rows(migrator, 'SELECT count() AS n FROM story GROUP ALL'),
    ).toEqual(before);
  });
});

describe('dev-seed refuses anything but dev', () => {
  it.each([
    [
      'a database that isn’t dev',
      { legalPlaceholders: false, environment: null },
      /not dev/,
    ],
    [
      'dev without published consent forms',
      { legalPlaceholders: false, environment: 'dev' },
      /no consent forms are published/,
    ],
  ])('refuses %s and changes nothing', async (_, params, error) => {
    const { t, seeder } = await devDatabase(params);
    try {
      await run(
        await t.migrator(),
        'CREATE theme:keep SET name = "Keep", category = themeCategory:other',
      );
      const result = await outcome(
        seeder,
        RESET_SQL,
        vars() as unknown as Record<string, unknown>,
      );
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(error),
      });
      expect(
        await rows(await t.migrator(), 'SELECT VALUE id FROM theme:keep'),
      ).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});

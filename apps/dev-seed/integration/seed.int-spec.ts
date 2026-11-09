import {
  outcome,
  rows,
  run,
  type TestDatabase,
} from '@heisreal/database/integration-testing';
import type { Surreal } from 'surrealdb';
import { DATASET } from '../src/app/dataset';
import bunnyMedia from '../src/app/bunny-media.json';
import type { BunnyMedia } from '../src/app/media';
import { buildVars, fakeUploads, stepsFor } from '../src/app/plan';
import { reset, RESET_SQL } from '../src/app/seed';
import { devDatabase } from '../testing';

/**
 * D49: the dev-seed reset against SurrealDB 3.2.4 with the real schema, as the dev-only `dev_seed`
 * system user (EDITOR) that SurrealDB's startup init creates when OpenTofu's dev_seed_login is
 * on. Every event runs, so this is the test that the D47 dataset fits the schema: types and
 * shapes (D53), text limits (A3, the 200-character minimum), the status log's steps (R6) and
 * the approval gate (A2). Uploads are stand-ins (fakeUploads) with the media spec's sizes.
 */
const vars = () => buildVars(DATASET, fakeUploads());
const approved = DATASET.stories.filter((s) => s.status === 'approved');

describe('dev-seed reset on SurrealDB (dev, the real agreement rules)', () => {
  let t: TestDatabase;
  let seeder: Surreal;

  beforeAll(async () => {
    ({ t, seeder } = await devDatabase({ environment: 'dev' }));
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
      // R12: one row per file a story uses: each story its own.
      files:
        DATASET.stories.filter((s) => s.media).length +
        DATASET.stories.filter((s) => s.image).length,
      statusEntries: DATASET.stories.reduce(
        (n, s) => n + stepsFor(s, new Date()).length,
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

  it('is idempotent: a second reset gives the same data', async () => {
    const before = await rows(
      await t.migrator(),
      'SELECT id, slug, currentStatus.status AS status FROM story ORDER BY id',
    );
    await reset(seeder, vars());
    const after = await rows(
      await t.migrator(),
      'SELECT id, slug, currentStatus.status AS status FROM story ORDER BY id',
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
        "SELECT VALUE id FROM story WHERE currentStatus.status = 'approved' AND fn::story::approval_problem($this) != NONE",
      ),
    ).toEqual([]);
    // Nothing for the media worker: no seeded clip is checked again or made a picture video.
    expect(
      await rows(migrator, 'SELECT VALUE id FROM mediaJob WHERE doneAt = NONE'),
    ).toEqual([]);
  });

  it('gives every story its own file rows; the stories never public share no upload, through placeholders (R12; Codex, #188 review)', async () => {
    const migrator = await t.migrator();
    // A story points only at its own rows: no row is pointed at by two stories.
    expect(
      await rows(
        migrator,
        `SELECT VALUE id FROM story WHERE (mediaFile != NONE AND mediaFile.story != id)
           OR (image != NONE AND image.file.story != id)`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        migrator,
        `SELECT record::id(id) AS story, record::id(mediaFile) AS file,
           mediaFile.processing AS processing, mediaFile.lengthSeconds AS lengthSeconds,
           mediaFile.thumbnailPath AS thumbnailPath
         FROM story WHERE mediaFile != NONE
           AND string::starts_with(record::id(mediaFile), '00000000-')
         ORDER BY story`,
      ),
    ).toEqual([
      // Submitted, not processed yet: no facts.
      { story: 'seed_v08', file: '00000000-0000-0000-0000-00000000a008' },
      ...['09', '10', '11'].map((n) => ({
        story: `seed_v${n}`,
        file: `00000000-0000-0000-0000-00000000a0${n}`,
        processing: 'ready',
        lengthSeconds: expect.any(Number),
        thumbnailPath: `00000000-0000-0000-0000-00000000a0${n}/thumbnail.jpg`,
      })),
    ]);
  });

  it('walks each story through the real states: its status log, who added each entry, versions', async () => {
    const migrator = await t.migrator();
    const log = (id: string) =>
      rows<Record<string, unknown>>(
        migrator,
        `SELECT status, actor, by, storyVersion, comment, at FROM storyStatusLog
           WHERE story = type::record('story', $id) ORDER BY at`,
        { id },
      );
    // Sent back once, then approved: create, its upload (R12: the pointer to its video) and
    // 6 status entries, each moving the status pointer.
    expect(
      await rows(migrator, 'SELECT VALUE version FROM story:seed_v03'),
    ).toEqual([8]);
    expect(
      (await log('seed_v03')).map((e) => [e.status, e.actor, e.storyVersion]),
    ).toEqual([
      ['pending', 'person', 2],
      ['in_review', 'moderator', 3],
      ['changes_requested', 'moderator', 4],
      ['pending', 'person', 5],
      ['in_review', 'moderator', 6],
      ['approved', 'moderator', 7],
    ]);
    const sentBack = (await log('seed_w10')).at(-1);
    expect(sentBack).toMatchObject({
      status: 'changes_requested',
      by: 'user:seed_moderator',
    });
    expect(sentBack?.comment).toContain('test feedback');
    expect((await log('seed_v09')).map((e) => e.status)).toEqual([
      'pending',
      'in_review',
    ]);
    expect(await log('seed_w11')).toEqual([]);
    expect(
      await rows(migrator, 'SELECT VALUE currentStatus FROM story:seed_w11'),
    ).toEqual([undefined]);
  });

  it('publishes exactly the approved stories, which api-public-read can read', async () => {
    const reader = await t.service('api_public_read');
    const slugs = await rows<string>(
      reader,
      'SELECT VALUE slug FROM story ORDER BY slug',
    );
    expect(slugs).toEqual(approved.map((s) => s.slug).sort());
    const [skeleton] = await rows<{ title: string; publishedAt: unknown }>(
      reader,
      "SELECT title, currentStatus.publishedAt AS publishedAt FROM story WHERE slug = 'test-story-walking-skeleton'",
    );
    expect(skeleton.title).toBe('Test story: the walking skeleton');
    const [w01] = await rows<{ image: unknown }>(
      reader,
      `SELECT { path: record::id(image.file), width: image.file.width,
         height: image.file.height, alt: image.alt } AS image FROM story:seed_w01`,
    );
    expect(w01.image).toEqual({
      path: 'dev-seed/image-01.webp',
      width: 1200,
      height: 1600,
      alt: 'A test pattern with a label (dummy image)',
    });
  });

  it('every fixture person agreed to the latest terms and testimony consent, kept across resets (plan 4e)', async () => {
    const migrator = await t.migrator();
    const agreed = () =>
      rows<Record<string, unknown>>(
        migrator,
        `SELECT id, termsOfUse, termsOfUseAgreedAt, testimonyConsent, testimonyConsentAgreedAt
           FROM user WHERE string::starts_with(<string> record::id(id), 'seed_') ORDER BY id`,
      );
    const before = await agreed();
    expect(before).toHaveLength(DATASET.people.length + 1);
    for (const person of before) {
      expect(person).toEqual({
        id: expect.any(String),
        termsOfUse: 'termsOfUseAgreement:0',
        termsOfUseAgreedAt: expect.any(String),
        testimonyConsent: 'testimonyConsent:0',
        testimonyConsentAgreedAt: expect.any(String),
      });
    }
    await reset(seeder, vars());
    expect(await agreed()).toEqual(before);
    // No dummy story is shared beyond the dev site.
    expect(
      await rows(
        migrator,
        'SELECT VALUE id FROM story WHERE socialMediaSharingConsent != NONE',
      ),
    ).toEqual([]);

    // A newer testimony consent: the next reset moves every fixture person to it.
    await run(
      await t.service('api_admin'),
      `CREATE testimonyConsent:1 CONTENT { content: 'Version one', publishedBy: user:legal_admin }`,
    );
    await reset(seeder, vars());
    expect(
      await rows(
        migrator,
        `SELECT VALUE testimonyConsent FROM user
           WHERE string::starts_with(<string> record::id(id), 'seed_')`,
      ),
    ).toEqual(Array(before.length).fill('testimonyConsent:1'));
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

  it('marks dev’s Clerk test accounts trusted submitters who agreed to the latest texts, signed in before or not (D112, C1)', async () => {
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
    // C1: both are on the latest terms of use and testimony consent, so the behavioural suites
    // can share a story straight after a reset.
    expect(
      await rows(
        migrator,
        `SELECT clerkUserId AS clerk,
           termsOfUse = fn::legal::latest('termsOfUseAgreement') AND termsOfUseAgreedAt != NONE AS terms,
           testimonyConsent = fn::legal::latest('testimonyConsent') AND testimonyConsentAgreedAt != NONE AS testimony
           FROM user WHERE clerkUserId IN ['user_tester_known', 'user_tester_new'] ORDER BY clerk`,
      ),
    ).toEqual([
      { clerk: 'user_tester_known', terms: true, testimony: true },
      { clerk: 'user_tester_new', terms: true, testimony: true },
    ]);
  });

  it('puts dev’s newcomer test accounts back to never having agreed to anything (plan 4e)', async () => {
    const migrator = await t.migrator();
    // Agreed already, as data/0009's fill-in left every person who existed then.
    await run(
      migrator,
      `CREATE user:newcomer CONTENT {
         clerkUserId: 'user_newcomer',
         termsOfUse: fn::legal::latest('termsOfUseAgreement'), termsOfUseAgreedAt: time::now(),
         testimonyConsent: fn::legal::latest('testimonyConsent'), testimonyConsentAgreedAt: time::now()
       }`,
    );
    const withNewcomers = {
      ...vars(),
      newcomerAccounts: ['user_newcomer', 'user_newcomer_not_signed_in'],
    };
    await reset(seeder, withNewcomers);
    await reset(seeder, withNewcomers); // idempotent
    expect(
      await rows(
        migrator,
        `SELECT clerkUserId AS clerk, termsOfUse, termsOfUseAgreedAt, testimonyConsent,
           testimonyConsentAgreedAt FROM user
           WHERE clerkUserId IN ['user_newcomer', 'user_newcomer_not_signed_in']`,
      ),
    ).toEqual([{ clerk: 'user_newcomer' }]);
  });

  it('is one transaction: a failure leaves the data as it was', async () => {
    const migrator = await t.migrator();
    const before = await rows(
      migrator,
      'SELECT count() AS n FROM story GROUP ALL',
    );
    const broken = vars();
    broken.stories[broken.stories.length - 1].draft['primaryFormat'] = 'video'; // no media: refused
    broken.stories[broken.stories.length - 1].steps = [
      { status: 'pending', actor: 'person', at: new Date() },
    ];
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
    ['a database without an environment', { environment: null }, /not dev/],
    ['another environment', { environment: 'prod' }, /not dev/],
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

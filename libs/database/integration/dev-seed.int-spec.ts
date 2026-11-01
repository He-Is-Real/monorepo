import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DPA_V1_SHA256,
  MIGRATION_TIMEOUT_MS,
  rows,
  sha256,
  SCHEMA_DIR,
  TestDatabase,
} from './support/harness';

/**
 * Seed 0003 (M0 task 0.9): the walking-skeleton story, in development only. Off by default
 * (OpenTofu passes seed_dev_story = false everywhere but live/dev/cluster): the script is then
 * recorded as applied and writes nothing, so turning it on later in production would do nothing
 * either. On, it publishes one obviously fake story through the schema's own rules.
 */
const DEV_SEED_SHA256 = sha256(
  readFileSync(join(SCHEMA_DIR, '../../legal/dpa/dev_seed.md'), 'utf8'),
);
const SLUG = 'test-story-walking-skeleton';

async function freshDatabase() {
  const t = await TestDatabase.create({ migrate: false });
  return t;
}

describe('seed 0003: the dev-only walking-skeleton story', () => {
  describe('off (the default, every environment but dev)', () => {
    let t: TestDatabase;
    beforeAll(async () => {
      t = await freshDatabase();
      await t.migrate();
      await t.createServices();
    });
    afterAll(() => t?.close());

    it('is recorded as applied and writes nothing', async () => {
      const migrator = await t.migrator();
      const [applied] = await rows(
        migrator,
        'SELECT VALUE record::id(id) FROM _migration',
      );
      expect(applied).toBeDefined();
      expect(
        await rows(
          migrator,
          `SELECT VALUE record::id(id) FROM _migration WHERE record::id(id) = '0003-dev-seed-story'`,
        ),
      ).toEqual(['0003-dev-seed-story']);
      for (const table of ['publicStory', 'story', 'consent', 'user']) {
        expect(await rows(migrator, `SELECT * FROM ${table}`)).toEqual([]);
      }
      expect(
        await rows(migrator, 'SELECT VALUE record::id(id) FROM dpaVersion'),
      ).toEqual(['v1']);
    });

    it('does nothing when turned on afterwards: it ran once already', async () => {
      await t.migrate(
        t.params({
          seed_dev_story: true,
          dpa_sha256: { v1: DPA_V1_SHA256, dev_seed: DEV_SEED_SHA256 },
        }),
      );
      const migrator = await t.migrator();
      expect(await rows(migrator, 'SELECT * FROM publicStory')).toEqual([]);
    });
  });

  describe('on (dev)', () => {
    let t: TestDatabase;
    const params = () =>
      t.params({
        seed_dev_story: true,
        dpa_sha256: { v1: DPA_V1_SHA256, dev_seed: DEV_SEED_SHA256 },
      });
    beforeAll(async () => {
      t = await freshDatabase();
      await t.migrate(params());
      await t.createServices();
    });
    afterAll(() => t?.close());

    it('publishes one test story that api-public-read can read by slug', async () => {
      const reader = await t.service('api_public_read');
      const [story] = await rows(
        reader,
        'SELECT slug, title, body, bylineName, primaryFormat, version FROM publicStory WHERE slug = $slug',
        { slug: SLUG },
      );
      expect(story).toMatchObject({
        slug: SLUG,
        title: 'Test story: the walking skeleton',
        bylineName: 'Test Person',
        primaryFormat: 'written',
        version: 1,
      });
      expect(String(story['body'])).toContain('Nobody shared this story');
    });

    it('keeps everything else as private as for any story', async () => {
      const reader = await t.service('api_public_read');
      for (const table of ['story', 'user', 'consent']) {
        expect(await rows(reader, `SELECT * FROM ${table}`)).toEqual([]);
      }
    });

    it('went through the real rules: an approved story whose test submitter consents, no Clerk account', async () => {
      const migrator = await t.migrator();
      const [story] = await rows(
        migrator,
        'SELECT status, consent FROM story:dev_seed',
      );
      expect(story['status']).toBe('approved');
      const [user] = await rows(migrator, 'SELECT * FROM user:dev_seed');
      expect(user['clerkUserId']).toBeUndefined();
      const [dpa] = await rows(
        migrator,
        'SELECT kind, status FROM dpaVersion:dev_seed',
      );
      // kind legacy: api-user's "version in force" only ever considers standard versions.
      expect(dpa).toEqual({ kind: 'legacy', status: 'published' });
    });

    it(
      'stays a single story across later migrations, and the DPA sync accepts its file',
      async () => {
        // With a publicStory row, 3.2.4 + RocksDB sometimes refuses the schema step's COMMIT with a
        // retryable conflict (re-defining the full-text index); the runner retries it. Several
        // runs in a row make that likely to happen here.
        for (let run = 0; run < 5; run++) {
          expect((await t.migrate(params())).applied).toEqual([]);
        }
        const migrator = await t.migrator();
        expect(
          await rows(migrator, 'SELECT VALUE slug FROM publicStory'),
        ).toEqual([SLUG]);
      },
      5 * MIGRATION_TIMEOUT_MS,
    );
  });
});

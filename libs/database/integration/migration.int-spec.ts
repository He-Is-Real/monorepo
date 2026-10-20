import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import type { SecretsService } from '@heisreal/secrets';
import { connectDatabase } from '../src/lib/database.module';
import {
  createPeople,
  type MigrationRun,
  outcome,
  rows,
  run,
  SCHEMA_DIR,
  SERVICES,
  sha256,
  TestDatabase,
} from './support/harness';

/**
 * D14: the migrate Job and the init Job, run against an empty database with the files they ship
 * with: libs/database/schema through the Job's runner (infra/k8s/surrealdb/base/migrate.py), and
 * infra/k8s/surrealdb/base/init.surql.tmpl rendered the way External Secrets Operator renders it
 * and imported the way `surreal import` imports it.
 */

const INIT_TEMPLATE = join(
  __dirname,
  '../../../infra/k8s/surrealdb/base/init.surql.tmpl',
);
/** The Job's identity check (migrate-job.yaml). */
const JOB_ENV = {
  MIGRATE_EXPECT_USERS: 'backup,migrator',
  MIGRATE_EXPECT_SERVICES: SERVICES.join(','),
};
const SEEDS = ['0001-seed-dpa-v1', '0002-seed-legacy-dpa'];

/** ESO's rendering of init.surql.tmpl ({{ .key | toJson }}), in the test's namespace. */
async function renderInit(
  t: TestDatabase,
  passwords: Record<string, string>,
): Promise<string> {
  const template = await readFile(INIT_TEMPLATE, 'utf8');
  return template
    .replace(/\{\{\s*\.(\w+)\s*\|\s*toJson\s*\}\}/g, (_, key: string) => {
      if (!(key in passwords)) throw new Error(`no value for ${key}`);
      return JSON.stringify(passwords[key]);
    })
    .replace(/\bheisreal\b/g, t.namespace);
}

/** What `surreal import` does: POST /import as root. */
async function importAsRoot(t: TestDatabase, sql: string): Promise<void> {
  const auth = Buffer.from(
    `${process.env['SURREAL_TEST_USER'] ?? 'root'}:${process.env['SURREAL_TEST_PASS'] ?? 'root'}`,
  ).toString('base64');
  const response = await fetch(`${t.url.replace(/^ws/, 'http')}/import`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${auth}`,
      'surreal-ns': t.namespace,
      'surreal-db': t.database,
    },
    body: sql,
  });
  if (!response.ok) {
    throw new Error(
      `import failed: ${response.status} ${await response.text()}`,
    );
  }
}

function initPasswords(t: TestDatabase): Record<string, string> {
  return {
    ...Object.fromEntries(t.servicePasswords),
    migrator: t.migratorPassword,
    backup: t.backupPassword,
  };
}

const bundles: string[] = [];
/** A copy of libs/database/schema with some files replaced (null = removed). */
async function bundleWith(
  changes: Record<string, string | null>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migration-bundle-'));
  bundles.push(dir);
  await cp(SCHEMA_DIR, dir, { recursive: true });
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) await rm(join(dir, path));
    else await writeFile(join(dir, path), text);
  }
  return dir;
}
afterAll(() =>
  Promise.all(bundles.map((d) => rm(d, { recursive: true, force: true }))),
);

const appliedIds = async (t: TestDatabase) =>
  rows(
    await t.migrator(),
    'SELECT VALUE record::id(id) FROM _migration ORDER BY id',
  );

describe('init + migrate on an empty database', () => {
  let t: TestDatabase;
  let first: MigrationRun;
  const old: Record<string, string> = {};

  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
    // The state before D13 B: per-service system users, as the old init Job made them.
    const root = await t.root();
    for (const [user, role] of [
      ['api_read', 'VIEWER'],
      ['api_write', 'EDITOR'],
      ['api_admin', 'EDITOR'],
      ['workflow', 'EDITOR'],
    ]) {
      old[user] = randomBytes(12).toString('hex');
      await run(
        root,
        `USE NS ${t.namespace} DB ${t.database};
         DEFINE USER ${user} ON DATABASE PASSWORD '${old[user]}' ROLES ${role};`,
      );
    }
    await importAsRoot(t, await renderInit(t, initPasswords(t)));
    first = await t.runMigration(t.params(), { env: JOB_ENV });
  });
  afterAll(() => t?.close());

  it('migrates, and the Job’s identity check passes', () => {
    expect(first.exitCode).toBe(0);
    expect(first.summary).toMatchObject({
      clerk: true,
      applied: SEEDS,
      alreadyApplied: [],
      heldBack: [],
    });
  });

  it('records every data script once, with its checksum, in _migration', async () => {
    const recorded = await rows<{ id: string; checksum: string }>(
      await t.migrator(),
      'SELECT record::id(id) AS id, checksum FROM _migration ORDER BY id',
    );
    expect(recorded).toEqual(
      await Promise.all(
        SEEDS.map(async (id) => ({
          id,
          checksum: sha256(
            await readFile(join(SCHEMA_DIR, 'data', `${id}.surql`), 'utf8'),
          ),
        })),
      ),
    );
  });

  it('leaves only the migrator and backup system users', async () => {
    const [info] = await rows<{ users: Record<string, string> }>(
      await t.migrator(),
      'INFO FOR DB',
    );
    expect(Object.keys(info.users).sort()).toEqual(['backup', 'migrator']);
  });

  it.each(['api_read', 'api_write', 'api_admin', 'workflow'])(
    'refuses the old system-user login %s',
    async (user) => {
      await expect(t.systemUser(user, old[user])).rejects.toThrow();
    },
  );

  it.each(SERVICES)(
    '%s signs in through svc with its Secret Manager password',
    async (name) => {
      const db = await t.service(name);
      expect(await rows(db, 'RETURN $auth')).toEqual([`service:${name}`]);
      await expect(t.service(name, 'wrong-password')).rejects.toThrow();
    },
  );

  it('libs/database connects as the service through svc', async () => {
    const secrets = {
      get: async () => t.servicePasswords.get('api_public_read'),
    } as unknown as SecretsService;
    const db = await connectDatabase(
      new Surreal(),
      {
        url: t.url,
        namespace: t.namespace,
        database: t.database,
        username: 'api_public_read',
        passwordSecret: 'surreal-api-public-read-password',
      },
      secrets,
    );
    try {
      expect(await rows(db, 'RETURN $auth')).toEqual([
        'service:api_public_read',
      ]);
      expect(
        await rows(db, 'SELECT VALUE record::id(id) FROM dpaVersion'),
      ).toEqual(['legacy-squarespace']); // published only: the draft v1 is invisible to it
    } finally {
      await db.close();
    }
  });

  it('backup is a read-only system user', async () => {
    const backup = await t.systemUser('backup', t.backupPassword);
    expect((await rows(backup, 'SELECT VALUE id FROM dpaVersion')).length).toBe(
      2,
    );
    await outcome(backup, `CREATE tag:x SET name = 'x', category = 'theme'`); // refused or a no-op
    expect(
      await rows(await t.migrator(), 'SELECT VALUE id FROM tag:x'),
    ).toEqual([]);
  });

  it('a second run is a no-op: same schema, no script re-run, data and sessions intact', async () => {
    const migrator = await t.migrator();
    const admin = await t.service('api_admin'); // a WebSocket session opened before
    await run(admin, `CREATE tag:kept SET name = 'Kept', category = 'theme'`);
    const before = {
      info: await rows(migrator, 'INFO FOR DB'),
      migrations: await rows(migrator, 'SELECT * FROM _migration ORDER BY id'),
      dpa: await rows(migrator, 'SELECT * FROM dpaVersion ORDER BY id'),
    };

    const again = await t.runMigration(t.params(), { env: JOB_ENV });
    expect(again.exitCode).toBe(0);
    expect(again.summary).toMatchObject({ applied: [], alreadyApplied: SEEDS });

    expect(await rows(migrator, 'INFO FOR DB')).toEqual(before.info);
    expect(
      await rows(migrator, 'SELECT * FROM _migration ORDER BY id'),
    ).toEqual(before.migrations);
    expect(
      await rows(migrator, 'SELECT * FROM dpaVersion ORDER BY id'),
    ).toEqual(before.dpa);
    expect(await rows(admin, 'SELECT VALUE name FROM tag:kept')).toEqual([
      'Kept',
    ]);
  });

  it('re-running init rotates a service password', async () => {
    const previous = t.servicePasswords.get('api_user') as string;
    const rotated = randomBytes(18).toString('hex');
    t.servicePasswords.set('api_user', rotated);
    await importAsRoot(t, await renderInit(t, initPasswords(t)));
    await expect(t.service('api_user', previous)).rejects.toThrow();
    expect(await rows(await t.service('api_user'), 'RETURN $auth')).toEqual([
      'service:api_user',
    ]);
  });
});

describe('the Job’s identity check', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
  });
  afterAll(() => t?.close());

  it('fails while an old system user remains or a service has no login', async () => {
    await run(
      await t.root(),
      `USE NS ${t.namespace} DB ${t.database};
       DEFINE USER api_admin ON DATABASE PASSWORD 'x' ROLES EDITOR;`,
    );
    const result = await t.runMigration(t.params(), {
      env: { ...JOB_ENV, MIGRATE_WAIT_SECONDS: '1' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "system users are ['api_admin', 'migrator']",
    );
    expect(result.output).toContain('no service login yet');
  });
});

describe('data scripts on an already-migrated database', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  it('runs a new script exactly once', async () => {
    const bundle = await bundleWith({
      'data/0003-add-tag.surql': `CREATE tag:migrated SET name = 'Migrated', category = 'theme';\n`,
    });
    expect(await t.migrate(t.params(), { bundleDir: bundle })).toMatchObject({
      applied: ['0003-add-tag'],
      alreadyApplied: SEEDS,
    });
    // CREATE fails on an existing record, so a re-run would fail this migration.
    expect(await t.migrate(t.params(), { bundleDir: bundle })).toMatchObject({
      applied: [],
      alreadyApplied: [...SEEDS, '0003-add-tag'],
    });
    expect(
      await rows(await t.migrator(), 'SELECT VALUE name FROM tag:migrated'),
    ).toEqual(['Migrated']);
  });

  it('a failing script leaves no _migration row and none of its writes, and stops there', async () => {
    const failing = await bundleWith({
      'data/0004-fails.surql': `CREATE tag:partial SET name = 'Partial', category = 'theme';\nTHROW 'boom';\n`,
      'data/0005-after.surql': `CREATE tag:after SET name = 'After', category = 'theme';\n`,
    });
    const result = await t.runMigration(t.params(), { bundleDir: failing });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      '0004-fails.surql: An error occurred: boom',
    );
    expect(await appliedIds(t)).toEqual([...SEEDS, '0003-add-tag']);
    expect(
      await rows(
        await t.migrator(),
        'SELECT VALUE id FROM tag:partial, tag:after',
      ),
    ).toEqual([]);

    const fixed = await bundleWith({
      'data/0004-fails.surql': `CREATE tag:partial SET name = 'Partial', category = 'theme';\n`,
      'data/0005-after.surql': `CREATE tag:after SET name = 'After', category = 'theme';\n`,
    });
    expect(await t.migrate(t.params(), { bundleDir: fixed })).toMatchObject({
      applied: ['0004-fails', '0005-after'],
    });
  });

  it('refuses to go on if an applied script has changed', async () => {
    const original = await readFile(
      join(SCHEMA_DIR, 'data/0001-seed-dpa-v1.surql'),
      'utf8',
    );
    const edited = await bundleWith({
      'data/0001-seed-dpa-v1.surql': `${original}-- edited\n`,
    });
    const result = await t.runMigration(t.params(), { bundleDir: edited });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      '0001-seed-dpa-v1.surql changed after it was applied',
    );
  });

  it.each([
    ['BEGIN TRANSACTION;\nCREATE tag:a;\nCOMMIT TRANSACTION;\n', 'BEGIN'],
    ['CREATE tag:a;\nRETURN 1;\nCREATE tag:b;\n', 'RETURN'],
  ])('rejects a script with a top-level %#: %s', async (text, word) => {
    const result = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({ 'data/0009-own-transaction.surql': text }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(`top-level ${word}`);
  });

  it('a failing schema leaves the previous schema in place', async () => {
    const schema = await readFile(join(SCHEMA_DIR, 'schema.surql'), 'utf8');
    const broken = await bundleWith({
      'schema.surql': `${schema}\nDEFINE TABLE OVERWRITE scratch SCHEMALESS;\nDEFINE FIELD OVERWRITE note ON story TYPE string;\nTHROW 'broken schema';\n`,
    });
    const result = await t.runMigration(t.params(), { bundleDir: broken });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('broken schema');
    const [info] = await rows<{ tables: Record<string, string> }>(
      await t.migrator(),
      'INFO FOR DB',
    );
    expect(info.tables['scratch']).toBeUndefined();
    const [story] = await rows<{ fields: Record<string, string> }>(
      await t.migrator(),
      'INFO FOR TABLE story',
    );
    expect(story.fields['note']).toBeUndefined();
  });
});

describe('parameters (Terraform values)', () => {
  it('holds back a script whose parameter is null, and every later one, until it is set', async () => {
    const t = await TestDatabase.create({ migrate: false });
    try {
      const bundle = await bundleWith({
        'data/0003-after-legacy.surql': `CREATE tag:later SET name = 'Later', category = 'theme';\n`,
      });
      const held = await t.runMigration(t.params({ legacy_sha256: null }), {
        bundleDir: bundle,
      });
      expect(held.exitCode).toBe(0);
      expect(held.summary).toMatchObject({
        applied: ['0001-seed-dpa-v1'],
        heldBack: ['0002-seed-legacy-dpa', '0003-after-legacy'],
      });
      expect(held.output).toContain(
        '0002-seed-legacy-dpa.surql needs legacy_sha256',
      );
      expect(await appliedIds(t)).toEqual(['0001-seed-dpa-v1']);

      expect(await t.migrate(t.params(), { bundleDir: bundle })).toMatchObject({
        applied: ['0002-seed-legacy-dpa', '0003-after-legacy'],
        heldBack: [],
      });
    } finally {
      await t.close();
    }
  });

  it('D20: a draft DPA’s contentHash follows its file; a published one is frozen', async () => {
    const t = await TestDatabase.create();
    try {
      const migrator = await t.migrator();
      const hash = () =>
        rows(migrator, 'SELECT VALUE contentHash FROM dpaVersion:v1');
      const edited = sha256('dpa v1, edited by the lawyer');
      await t.migrate(t.params({ dpa_v1_sha256: edited }));
      expect(await hash()).toEqual([edited]);

      await run(
        await t.service('api_admin'),
        `UPDATE dpaVersion:v1 SET status = 'published', effectiveFrom = time::now()`,
      );
      const changedAfterPublishing = await t.runMigration(
        t.params({ dpa_v1_sha256: sha256('changed after publishing') }),
      );
      expect(changedAfterPublishing.exitCode).toBe(1);
      expect(changedAfterPublishing.output).toContain(
        'dpaVersion:v1 is published, but its file in libs/legal/dpa has changed',
      );
      expect(await hash()).toEqual([edited]);

      const legacyChanged = await t.runMigration(
        t.params({ dpa_v1_sha256: edited, legacy_sha256: sha256('other') }),
      );
      expect(legacyChanged.exitCode).toBe(1);
      expect(legacyChanged.output).toContain('legacy-squarespace');
    } finally {
      await t.close();
    }
  });
});

describe('Clerk access (person sessions)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
    await t.migrate(t.params({ clerk_jwt_public_key: null }));
    await t.createServices();
    await createPeople(t, { ann: 'user_ann' });
  });
  afterAll(() => t?.close());

  const accesses = async () =>
    Object.keys(
      (
        await rows<{ accesses: Record<string, string> }>(
          await t.migrator(),
          'INFO FOR DB',
        )
      )[0].accesses,
    ).sort();

  it('without a key there is no clerk access, so no token opens a person session', async () => {
    expect(await accesses()).toEqual(['svc']);
    await expect(t.person('user_ann')).rejects.toThrow();
  });

  it('with the key set, Clerk tokens work; unsetting it closes them again', async () => {
    expect((await t.migrate(t.params())).clerk).toBe(true);
    expect(await accesses()).toEqual(['clerk', 'svc']);
    const ann: Surreal = await t.person('user_ann');
    expect(await rows(ann, 'RETURN $auth')).toEqual(['user:ann']);

    expect(
      (await t.migrate(t.params({ clerk_jwt_public_key: null }))).clerk,
    ).toBe(false);
    expect(await accesses()).toEqual(['svc']);
    await expect(t.person('user_ann')).rejects.toThrow();
  });
});

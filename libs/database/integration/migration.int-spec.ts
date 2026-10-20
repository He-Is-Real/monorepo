import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import type { SecretsService } from '@heisreal/secrets';
import { connectDatabase } from '../src/lib/database.module';
import { pinnedSurrealImage } from './support/global-setup';
import {
  createPeople,
  DPA_V1_SHA256,
  LEGACY_SHA256,
  type MigrationRun,
  nextGeneration,
  outcome,
  RUNNER,
  rows,
  run,
  SCHEMA_DIR,
  SERVICES,
  sha256,
  TestDatabase,
} from './support/harness';

/**
 * D14 + the D13 B cutover, with the files they ship with: libs/database/schema through the Job's
 * runner (libs/database/schema/migrate.py), and infra/k8s/surrealdb/base/init.surql.tmpl rendered
 * the way External Secrets Operator renders it, with the identity marker Terraform appends. On
 * the shared test server the init runs as root over /sql (what `surreal start --import-file`
 * does, without the restart); the cutover suite at the end restarts a dedicated container with
 * --import-file, exactly as the StatefulSet does.
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

/** The line Terraform appends to the init template (modules/db-identity). */
const identityMarker = (hash: string) =>
  `\nUPSERT _identity:current SET hash = ${JSON.stringify(hash)}, appliedAt = time::now() RETURN NONE;\n`;

/**
 * ESO's rendering of init.surql.tmpl ({{ .key | toJson }}), plus Terraform's identity marker.
 * On the shared server it goes in the test's namespace.
 */
async function renderInit(
  t: TestDatabase,
  passwords: Record<string, string>,
  identityHash?: string,
): Promise<string> {
  const template = await readFile(INIT_TEMPLATE, 'utf8');
  return (
    template
      .replace(/\{\{\s*\.(\w+)\s*\|\s*toJson\s*\}\}/g, (_, key: string) => {
        if (!(key in passwords)) throw new Error(`no value for ${key}`);
        return JSON.stringify(passwords[key]);
      })
      .replace(/\bheisreal\b/g, t.namespace) +
    (identityHash ? identityMarker(identityHash) : '')
  );
}

/** Runs the init as root, as the server's startup import does (no OPTION IMPORT). */
async function initAsRoot(t: TestDatabase, sql: string): Promise<void> {
  await run(await t.root(), sql);
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

/** A bundle whose schema also defines a marker table, to see whether the schema step ran. */
async function withScratchTable(): Promise<string> {
  const schema = await readFile(join(SCHEMA_DIR, 'schema.surql'), 'utf8');
  return bundleWith({
    'schema.surql': `${schema}\nDEFINE TABLE OVERWRITE scratch_marker SCHEMALESS PERMISSIONS NONE;\n`,
  });
}
const scratchTableExists = async (t: TestDatabase) => {
  const [info] = await rows<{ tables: Record<string, string> }>(
    await t.migrator(),
    'INFO FOR DB',
  );
  return 'scratch_marker' in info.tables;
};

const appliedIds = async (t: TestDatabase) =>
  rows(
    await t.migrator(),
    'SELECT VALUE record::id(id) FROM _migration ORDER BY id',
  );

describe('init + migrate on an empty database', () => {
  let t: TestDatabase;
  let first: MigrationRun;
  let oldEditor: Surreal;
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
    oldEditor = await t.systemUser('api_admin', old['api_admin']); // opened before the init
    await initAsRoot(t, await renderInit(t, initPasswords(t), 'config-1'));
    first = await t.runMigration(t.params({ identity_hash: 'config-1' }), {
      env: JOB_ENV,
    });
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

  it('pinned 3.2.4 behaviour: REMOVE USER alone leaves an open session working (hence the restart)', async () => {
    // Fails when an upgrade makes REMOVE USER end sessions; the restart-based cutover (last
    // suite) is what ends them on 3.2.4.
    expect(
      await rows(
        oldEditor,
        'SELECT VALUE record::id(id) FROM _migration ORDER BY id',
      ),
    ).toEqual(SEEDS); // an EDITOR reads a PERMISSIONS NONE table
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

    const again = await t.runMigration(
      t.params({ identity_hash: 'config-1' }),
      { env: JOB_ENV },
    );
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
    await initAsRoot(t, await renderInit(t, initPasswords(t), 'config-2'));
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

  it('waits for the restart with the expected identity config, and changes nothing until then', async () => {
    await initAsRoot(t, await renderInit(t, initPasswords(t), 'config-old'));
    const result = await t.runMigration(
      t.params({ identity_hash: 'config-new' }),
      {
        env: { ...JOB_ENV, MIGRATE_WAIT_SECONDS: '1' },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "SurrealDB hasn't restarted with identity config config-new yet (it has config-old)",
    );
    const [info] = await rows<{ tables: Record<string, string> }>(
      await t.migrator(),
      'INFO FOR DB',
    );
    expect(info.tables['story']).toBeUndefined(); // no schema applied
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

  // On 3.2.4 a RETURN statement inside a transaction commits it early and skips the rest, at the
  // top level and inside IF/FOR blocks alike, so a RETURN statement is refused anywhere outside a
  // DEFINE body (stored, not run). BEGIN/COMMIT/CANCEL/OPTION would break the runner's transaction.
  it.each([
    [
      'indented RETURN',
      `CREATE tag:a SET name = 'a', category = 'theme';\n    RETURN 123;\nCREATE tag:b SET name = 'b', category = 'theme';\n`,
      'RETURN',
    ],
    [
      'inline ; RETURN',
      `CREATE tag:a SET name = 'a', category = 'theme'; RETURN 1; CREATE tag:b SET name = 'b', category = 'theme';\n`,
      'RETURN',
    ],
    [
      'RETURN in an IF block',
      `CREATE tag:a SET name = 'a', category = 'theme';\nIF true { RETURN 1 };\nCREATE tag:b SET name = 'b', category = 'theme';\n`,
      'RETURN',
    ],
    ['RETURN in a FOR block', `FOR $x IN [1] {\n  RETURN $x;\n};\n`, 'RETURN'],
    [
      'its own transaction',
      'BEGIN TRANSACTION;\nCREATE tag:a;\nCOMMIT TRANSACTION;\n',
      'BEGIN',
    ],
    [
      'lower-case commit',
      `CREATE tag:a SET name = 'a', category = 'theme';\ncommit;\n`,
      'COMMIT',
    ],
    ['OPTION IMPORT', 'OPTION IMPORT;\nCREATE tag:a;\n', 'OPTION'],
  ])(
    'refuses a script with %s, before changing anything',
    async (_, text, word) => {
      const result = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({ 'data/0009-refused.surql': text }),
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(`${word} statement`);
      expect(await appliedIds(t)).not.toContain('0009-refused');
    },
  );

  it('allows RETURN in strings, comments, record ids, DEFINE bodies and as a clause', async () => {
    const text = [
      `CREATE tag:s SET name = 'RETURN 1; COMMIT;', category = 'theme';`,
      '-- RETURN 1;',
      '// RETURN 1;',
      '# COMMIT;',
      '/* BEGIN; RETURN 1; */',
      `CREATE tag:⟨RETURN; x⟩ SET name = "it\\"s; RETURN", category = 'theme' RETURN NONE;`,
      'DEFINE FUNCTION OVERWRITE fn::scratch::one() { RETURN 1; };',
      `CREATE tag:last SET name = 'Last', category = 'theme';`,
    ].join('\n');
    expect(
      await t.migrate(t.params(), {
        bundleDir: await bundleWith({ 'data/0006-allowed.surql': text }),
      }),
    ).toMatchObject({ applied: ['0006-allowed'] });
    expect(
      await rows(await t.migrator(), 'SELECT VALUE name FROM tag:last'),
    ).toEqual(['Last']);
  });

  it('fails a step whose results don’t match its statements (an early exit the scanner missed)', async () => {
    const probe = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("m", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class Client:
    def query(self, sql, variables):
        return [{"status": "OK", "result": None}] * 3  # BEGIN, CREATE, COMMIT: one CREATE missing
try:
    m.run(Client(), "0007-x.surql", "BEGIN TRANSACTION; CREATE a:1; CREATE a:2; COMMIT TRANSACTION;", {})
    print("not caught")
except m.MigrationError as err:
    print("caught:", err)
`;
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        'python3',
        ['-c', probe, RUNNER],
        { env: { PATH: process.env['PATH'], PYTHONDONTWRITEBYTECODE: '1' } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      ),
    );
    expect(output).toContain(
      'caught: 0007-x.surql: 3 results for 4 statements: something ended the transaction early',
    );
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
      expect(held.output).toContain('HELD BACK');
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
      const files = (v1: string, legacy = LEGACY_SHA256) => ({
        dpa_sha256: { v1, 'legacy-squarespace': legacy },
      });
      await t.migrate(t.params(files(edited)));
      expect(await hash()).toEqual([edited]);

      await run(
        await t.service('api_admin'),
        `UPDATE dpaVersion:v1 SET status = 'published', effectiveFrom = time::now()`,
      );
      const changedAfterPublishing = await t.runMigration(
        t.params(files(sha256('changed after publishing'))),
        { bundleDir: await withScratchTable() },
      );
      expect(changedAfterPublishing.exitCode).toBe(1);
      expect(changedAfterPublishing.output).toContain(
        'dpaVersion:v1 is published, but its file in libs/legal/dpa has changed',
      );
      expect(await hash()).toEqual([edited]);
      expect(await scratchTableExists(t)).toBe(false); // checked before the schema step

      const legacyChanged = await t.runMigration(
        t.params(files(edited, sha256('other'))),
      );
      expect(legacyChanged.exitCode).toBe(1);
      expect(legacyChanged.output).toContain('legacy-squarespace');
    } finally {
      await t.close();
    }
  });
});

describe('P2-5: a seeded DPA version must keep its file', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  it.each([
    [
      'a draft (v1)',
      { 'legacy-squarespace': LEGACY_SHA256 },
      'dpaVersion:v1 exists, but libs/legal/dpa/v1.md does not',
    ],
    [
      'a published version (legacy)',
      { v1: DPA_V1_SHA256 },
      'dpaVersion:`legacy-squarespace` exists, but libs/legal/dpa/legacy-squarespace.md does not',
    ],
  ])(
    'fails, before changing anything, when %s has lost its file',
    async (_, hashes, message) => {
      const result = await t.runMigration(t.params({ dpa_sha256: hashes }), {
        bundleDir: await withScratchTable(),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(message);
      expect(await scratchTableExists(t)).toBe(false);
    },
  );

  it('a version that isn’t seeded yet may lack its file', async () => {
    const fresh = await TestDatabase.create({ migrate: false });
    try {
      const held = await fresh.runMigration(
        fresh.params({
          legacy_sha256: null,
          dpa_sha256: { v1: DPA_V1_SHA256 },
        }),
      );
      expect(held.output).toContain('HELD BACK');
      expect(held.exitCode).toBe(0);
      expect(held.summary?.heldBack).toEqual(['0002-seed-legacy-dpa']);
    } finally {
      await fresh.close();
    }
  });
});

describe('P2-4: overlapping runners and stale bundles', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  const generation = async () =>
    rows(
      await t.migrator(),
      'SELECT VALUE generation FROM _migrationRun:current',
    );

  it('refuses a bundle older than the last one applied, without changing the schema', async () => {
    const older = nextGeneration();
    await t.migrate(t.params({ generation: nextGeneration() })); // a newer bundle ran first
    const stale = await t.runMigration(t.params({ generation: older }), {
      bundleDir: await withScratchTable(),
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain('is stale');
    expect(await scratchTableExists(t)).toBe(false);
  });

  it('a runner overtaken mid-run by a newer one fails, keeping nothing of its step, and can’t resume', async () => {
    const genA = nextGeneration();
    const genB = nextGeneration();
    const slowA = await bundleWith({
      'data/0010-slow.surql': `SLEEP 10s;\nCREATE tag:slow SET name = 'Slow', category = 'theme';\n`,
    });
    // A: schema step done, then sits in 0010's transaction (10 s) while B runs.
    let schemaDone: () => void = () => undefined;
    const aInData = new Promise<void>((r) => (schemaDone = r));
    const a = t.runMigration(t.params({ generation: genA }), {
      bundleDir: slowA,
      onOutput: (chunk) => {
        if (chunk.includes('schema.surql:')) schemaDone();
      },
    });
    await aInData;
    // B: a newer bundle (without 0010) runs to completion meanwhile.
    expect(await t.migrate(t.params({ generation: genB }))).toMatchObject({
      applied: [],
    });
    const resultA = await a;
    expect(resultA.exitCode).toBe(1);
    expect(await appliedIds(t)).not.toContain('0010-slow');
    expect(
      await rows(await t.migrator(), 'SELECT VALUE id FROM tag:slow'),
    ).toEqual([]);
    expect(await generation()).toEqual([new Date(genB).toISOString()]);

    // A's Job retrying: refused before it touches anything.
    const retry = await t.runMigration(t.params({ generation: genA }), {
      bundleDir: slowA,
    });
    expect(retry.exitCode).toBe(1);
    expect(retry.output).toContain('is stale');
  }, 60_000);
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

const hasDocker = (() => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * P1-1: removing a system user doesn't end its open sessions on 3.2.4 (an EDITOR session kept
 * reading PERMISSIONS NONE tables). The cutover is therefore SurrealDB restarting with the new
 * startup init (`--import-file`), as the StatefulSet does when Terraform changes the identity
 * hash: every older session ends with the old process, and the server answers nothing until
 * the init has run. A dedicated container on a persistent volume, so it can restart.
 */
(hasDocker ? describe : describe.skip)(
  'D13 B cutover: restart with the startup init',
  () => {
    const name = `surreal-cutover-${randomBytes(4).toString('hex')}`;
    const rootPassword = process.env['SURREAL_TEST_PASS'] ?? 'root';
    let initDir: string;
    let t: TestDatabase;
    let oldEditor: Surreal;
    const oldPassword = randomBytes(12).toString('hex');

    async function start(withInit: boolean): Promise<string> {
      execFileSync('docker', [
        'run',
        '--detach',
        '--name',
        name,
        '--user',
        'root',
        '--publish',
        '127.0.0.1::8000',
        '--volume',
        `${name}:/data`,
        '--volume',
        `${initDir}:/init:ro`,
        '--env',
        'SURREAL_USER=root',
        '--env',
        `SURREAL_PASS=${rootPassword}`,
        pinnedSurrealImage(),
        'start',
        ...(withInit ? ['--import-file=/init/init.surql'] : []),
        'rocksdb:/data/db',
      ]);
      const port = execFileSync('docker', ['port', name, '8000/tcp'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')[0]
        .split(':')
        .pop();
      const http = `http://127.0.0.1:${port}`;
      const auth = Buffer.from(`root:${rootPassword}`).toString('base64');
      for (const deadline = Date.now() + 30_000; ;) {
        try {
          const r = await fetch(`${http}/sql`, {
            method: 'POST',
            body: 'RETURN 1',
            headers: {
              Accept: 'application/json',
              Authorization: `Basic ${auth}`,
            },
          });
          if (r.ok) break; // 503 while starting up, i.e. while the init runs
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline)
          throw new Error('cutover container not ready');
        await new Promise((r) => setTimeout(r, 200));
      }
      return `ws://127.0.0.1:${port}`;
    }
    const stop = () =>
      execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' });

    beforeAll(async () => {
      initDir = await mkdtemp(join(tmpdir(), 'cutover-init-'));
      // Before: the pre-D13 per-service system users, and an EDITOR session open on one.
      const url = await start(false);
      t = TestDatabase.at(url, 'heisreal', 'main');
      await run(
        await t.root(),
        `DEFINE NAMESPACE heisreal; USE NS heisreal; DEFINE DATABASE main; USE NS heisreal DB main;
       DEFINE USER api_admin ON DATABASE PASSWORD '${oldPassword}' ROLES EDITOR;
       DEFINE USER api_read ON DATABASE PASSWORD '${oldPassword}' ROLES VIEWER;
       DEFINE TABLE secret SCHEMALESS PERMISSIONS NONE; CREATE secret:x;`,
      );
      oldEditor = await t.systemUser('api_admin', oldPassword);
      expect(await rows(oldEditor, 'SELECT VALUE id FROM secret')).toEqual([
        'secret:x',
      ]);

      // The cutover: the rendered init (real template, real namespace) at startup.
      const init = (await renderInit(t, initPasswords(t), 'cutover-1')).replace(
        new RegExp(`\\b${t.namespace}\\b`, 'g'),
        'heisreal',
      );
      await writeFile(join(initDir, 'init.surql'), init, { mode: 0o644 });
      stop();
      const restarted = await start(true);
      t = Object.assign(TestDatabase.at(restarted, 'heisreal', 'main'), {
        migratorPassword: t.migratorPassword,
        backupPassword: t.backupPassword,
        servicePasswords: t.servicePasswords,
      });
    }, 90_000);
    afterAll(async () => {
      await t?.close().catch(() => undefined);
      stop();
      execFileSync('docker', ['volume', 'rm', '--force', name], {
        stdio: 'ignore',
      });
      await rm(initDir, { recursive: true, force: true });
    });

    it('the old EDITOR session opened before the cutover can no longer act', async () => {
      await expect(
        oldEditor.query('SELECT * FROM secret').collect(),
      ).rejects.toThrow();
      await expect(
        oldEditor
          .query('REMOVE EVENT consent_append_only ON consent')
          .collect(),
      ).rejects.toThrow();
    });

    it.each(['api_admin', 'api_read'])(
      'a new %s login is refused',
      async (user) => {
        await expect(t.systemUser(user, oldPassword)).rejects.toThrow();
      },
    );

    it('leaves only migrator and backup, and the identity marker', async () => {
      const migrator = await t.migrator();
      const [info] = await rows<{ users: Record<string, string> }>(
        migrator,
        'INFO FOR DB',
      );
      expect(Object.keys(info.users).sort()).toEqual(['backup', 'migrator']);
      expect(
        await rows(migrator, 'SELECT VALUE hash FROM _identity:current'),
      ).toEqual(['cutover-1']);
    });

    it('then the migrate Job runs, after checking the restart happened, and every service signs in', async () => {
      const result = await t.runMigration(
        t.params({ identity_hash: 'cutover-1' }),
        { env: JOB_ENV },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        'identities: as expected (identity config cutover-1)',
      );
      expect(result.summary).toMatchObject({ applied: SEEDS });
      for (const service of SERVICES) {
        expect(await rows(await t.service(service), 'RETURN $auth')).toEqual([
          `service:${service}`,
        ]);
      }
    });
  },
);

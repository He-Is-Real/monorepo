import { execFileSync } from 'node:child_process';
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
  type MigrationRun,
  outcome,
  rows,
  run,
  SCHEMA_DIR,
  SERVICES,
  type ServiceName,
  sha256,
  TestDatabase,
} from './support/harness';

/**
 * D14 + the D13 B cutover, with the files they ship with: libs/database/schema through the Job's
 * runner (libs/database/schema/migrate.py), infra/k8s/surrealdb/base/init.surql.tmpl rendered the
 * way External Secrets Operator renders it (with the identity marker Terraform substitutes), and
 * infra/k8s/surrealdb/base/identity_check.py, the readiness check of the identity-check sidecar.
 * On the shared test server the init runs as root over /sql (what `surreal start --import-file`
 * does, without the restart); the last suite restarts a dedicated container with --import-file,
 * exactly as the StatefulSet does.
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
const SEEDS = ['0001-seed-dpa-v1'];
const CODEX_EXAMPLES = [
  'LET $x = [RETURN 17];',
  'IF true THEN RETURN 17 END;',
  'LET $x = 1 + RETURN 17;',
];

/**
 * ESO's rendering of init.surql.tmpl ({{ .key | toJson }}) and, given a hash, Terraform's
 * identity marker in place of the `-- @identity-marker` line (modules/db-identity). On the shared
 * server it goes in the test's namespace. `breakApiUser` injects a runtime error into the
 * api_user hash assignment (Codex's fault probe).
 */
async function renderInit(
  t: TestDatabase,
  identityHash?: string,
  { breakApiUser = false, namespace = t.namespace } = {},
): Promise<string> {
  const passwords: Record<string, string> = {
    ...Object.fromEntries(t.servicePasswords),
    migrator: t.migratorPassword,
    backup: t.backupPassword,
  };
  let text = (await readFile(INIT_TEMPLATE, 'utf8'))
    .replace(/\{\{\s*\.(\w+)\s*\|\s*toJson\s*\}\}/g, (_, key: string) => {
      if (!(key in passwords)) throw new Error(`no value for ${key}`);
      return JSON.stringify(passwords[key]);
    })
    .replace(/\bheisreal\b/g, namespace);
  if (identityHash) {
    text = text.replace(
      '-- @identity-marker',
      `UPSERT _identity:current SET hash = ${JSON.stringify(identityHash)}, appliedAt = time::now();`,
    );
  }
  if (breakApiUser) {
    text = text.replace(
      /(UPSERT service:api_user\s+SET secretHash = )crypto::argon2::generate\([^)]*\)/,
      '$1<int> "not a number"',
    );
  }
  return text;
}

/** Runs the init as root, as the server's startup import does. Returns whether it committed. */
async function initAsRoot(t: TestDatabase, sql: string): Promise<boolean> {
  return (await outcome(await t.root(), sql)).ok;
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
async function tables(t: TestDatabase): Promise<Record<string, string>> {
  const [info] = await rows<{ tables: Record<string, string> }>(
    await t.migrator(),
    'INFO FOR DB',
  );
  return info.tables;
}
const scratchTableExists = async (t: TestDatabase) =>
  'scratch_marker' in (await tables(t));
const appliedIds = async (t: TestDatabase) =>
  rows(
    await t.migrator(),
    'SELECT VALUE record::id(id) FROM _migration ORDER BY id',
  );
const pendingSteps = async (t: TestDatabase) =>
  '_migrationPending' in (await tables(t))
    ? rows(
        await t.migrator(),
        'SELECT VALUE record::id(id) FROM _migrationPending',
      )
    : [];
const tagIds = async (t: TestDatabase, ...ids: string[]) =>
  (
    await rows<string>(
      await t.migrator(),
      `SELECT VALUE record::id(id) FROM ${ids.map((i) => `tag:${i}`).join(', ')}`,
    )
  ).sort();
const tag = (id: string) =>
  `CREATE tag:${id} SET name = '${id}', category = 'theme';\n`;

// ---------------------------------------------------------------- identities (D13 B)

describe('init + identity check + migrate on an empty database', () => {
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
    expect(await initAsRoot(t, await renderInit(t, 'config-1'))).toBe(true);
    expect(await t.identityCheck(t.credentials(), 'config-1')).toMatchObject({
      ready: true,
    });
    first = await t.runMigration(t.params({ identity_hash: 'config-1' }), {
      env: JOB_ENV,
    });
  });
  afterAll(() => t?.close());

  it('migrates once the identity config is verified', () => {
    expect(first.exitCode).toBe(0);
    expect(first.output).toContain(
      'identities: as expected (identity config config-1 verified)',
    );
    expect(first.summary).toMatchObject({
      clerk: true,
      applied: SEEDS,
      alreadyApplied: [],
    });
  });

  it('records every data script once, with its checksum, and leaves no pending step', async () => {
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
    expect(await pendingSteps(t)).toEqual([]);
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
      await rows(oldEditor, 'SELECT VALUE record::id(id) FROM _migration'),
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
      // The only DPA version is the draft v1, which the public can't see.
      expect(await rows(db, 'SELECT VALUE id FROM dpaVersion')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('backup is a read-only system user', async () => {
    const backup = await t.systemUser('backup', t.backupPassword);
    expect(await rows(backup, 'SELECT VALUE id FROM dpaVersion')).toEqual([
      'dpaVersion:v1',
    ]);
    await outcome(backup, tag('x')); // refused or a no-op
    expect(await tagIds(t, 'x')).toEqual([]);
  });

  it('a second run is a no-op: same schema, no script re-run, data and sessions intact', async () => {
    const migrator = await t.migrator();
    const admin = await t.service('api_admin'); // a WebSocket session opened before
    await run(admin, tag('kept'));
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
    expect(again.summary).toMatchObject({
      applied: [],
      alreadyApplied: SEEDS,
      token: (first.summary?.token ?? 0) + 1,
    });

    expect(await rows(migrator, 'INFO FOR DB')).toEqual(before.info);
    expect(
      await rows(migrator, 'SELECT * FROM _migration ORDER BY id'),
    ).toEqual(before.migrations);
    expect(
      await rows(migrator, 'SELECT * FROM dpaVersion ORDER BY id'),
    ).toEqual(before.dpa);
    expect(await rows(admin, 'SELECT VALUE name FROM tag:kept')).toEqual([
      'kept',
    ]);
  });

  it('re-running the init rotates a service password, and the check verifies the new one', async () => {
    const previous = t.servicePasswords.get('api_user') as string;
    t.servicePasswords.set('api_user', randomBytes(18).toString('hex'));
    expect(await initAsRoot(t, await renderInit(t, 'config-2'))).toBe(true);
    await expect(t.service('api_user', previous)).rejects.toThrow();
    expect(await rows(await t.service('api_user'), 'RETURN $auth')).toEqual([
      'service:api_user',
    ]);
    expect(await t.identityCheck(t.credentials(), 'config-2')).toMatchObject({
      ready: true,
    });
    expect(
      await rows(
        await t.migrator(),
        'SELECT VALUE hash FROM _identity:verified',
      ),
    ).toEqual(['config-2']);
  });
});

describe('P2: a failed startup init fails closed', () => {
  let t: TestDatabase;
  let oldPasswords: Map<ServiceName, string>;
  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
    expect(await initAsRoot(t, await renderInit(t, 'config-1'))).toBe(true);
    await t.migrate(t.params());
    expect(await t.identityCheck(t.credentials(), 'config-1')).toMatchObject({
      ready: true,
    });
    oldPasswords = new Map(t.servicePasswords);
  });
  afterAll(() => t?.close());

  it('a runtime error in a rotation keeps every old identity and no new marker, and the check stays not Ready', async () => {
    // Rotate every service password, with an error injected into api_user's new hash.
    for (const name of SERVICES) {
      t.servicePasswords.set(name, randomBytes(18).toString('hex'));
    }
    const sql = await renderInit(t, 'config-2', { breakApiUser: true });
    expect(await initAsRoot(t, sql)).toBe(false);

    const migrator = await t.migrator();
    expect(
      await rows(migrator, 'SELECT VALUE hash FROM _identity:current'),
    ).toEqual(['config-1']);
    // The whole transaction rolled back: old passwords still work, new ones don't.
    for (const name of SERVICES) {
      expect(
        await rows(
          await t.service(name, oldPasswords.get(name)),
          'RETURN $auth',
        ),
      ).toEqual([`service:${name}`]);
      await expect(t.service(name)).rejects.toThrow();
    }

    const check = await t.identityCheck(t.credentials(), 'config-2');
    expect(check.ready).toBe(false);
    expect(check.output).toContain('NOT READY');
    for (const password of [
      ...t.servicePasswords.values(),
      t.migratorPassword,
    ]) {
      expect(check.output).not.toContain(password);
    }
    expect(
      await rows(migrator, 'SELECT VALUE hash FROM _identity:verified'),
    ).toEqual(['config-1']);

    // The migrate Job waits for config-2 to be verified, and changes nothing.
    const result = await t.runMigration(
      t.params({ identity_hash: 'config-2' }),
      {
        env: { ...JOB_ENV, MIGRATE_WAIT_SECONDS: '1' },
        bundleDir: await withScratchTable(),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      'identity config config-2 not verified yet',
    );
    expect(await scratchTableExists(t)).toBe(false);
  });

  it('is not Ready while an old system user remains or a password is wrong', async () => {
    t.servicePasswords = new Map(oldPasswords);
    expect(await t.identityCheck(t.credentials(), 'config-1')).toMatchObject({
      ready: true,
    });
    const wrong = { ...t.credentials(), backup: 'not-the-password' };
    expect(await t.identityCheck(wrong, 'config-1')).toMatchObject({
      ready: false,
      output: expect.stringContaining("backup can't sign in"),
    });
    await run(
      await t.root(),
      `USE NS ${t.namespace} DB ${t.database};
       DEFINE USER api_admin ON DATABASE PASSWORD 'x' ROLES EDITOR;`,
    );
    expect(await t.identityCheck(t.credentials(), 'config-1')).toMatchObject({
      ready: false,
      output: expect.stringContaining(
        "system users are ['api_admin', 'backup', 'migrator']",
      ),
    });
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
    expect('story' in (await tables(t))).toBe(false); // nothing applied
  });
});

// ---------------------------------------------------------------- P1: the transaction guard

describe('P1: scripts can never commit partly', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  // On 3.2.4 each of these ends the transaction early (tested): data scripts may not contain
  // the RETURN token at all; BEGIN/COMMIT/CANCEL nowhere; no OPTION statement.
  it.each([
    ...CODEX_EXAMPLES.map((x) => [`Codex: ${x}`, x, 'RETURN']),
    ['an indented RETURN', '    RETURN 123;', 'RETURN'],
    ['inline ; RETURN', `${tag('mid').trim()} RETURN 1;`, 'RETURN'],
    ['RETURN in an IF block', 'IF true { RETURN 1 };', 'RETURN'],
    [
      'a RETURN NONE clause',
      `CREATE tag:c SET name = 'c', category = 'theme' RETURN NONE;`,
      'RETURN',
    ],
    [
      'a function with RETURN',
      'DEFINE FUNCTION OVERWRITE fn::x() { RETURN 1 };',
      'RETURN',
    ],
    ['its own transaction', 'BEGIN TRANSACTION;', 'BEGIN'],
    ['lower-case commit', 'commit;', 'COMMIT'],
    ['CANCEL', 'CANCEL TRANSACTION;', 'CANCEL'],
    ['OPTION IMPORT', 'OPTION IMPORT;', 'OPTION'],
    // Codex round 3: BREAK/CONTINUE in an IF block skip the rest of the block, and the
    // transaction (with the marker after it) still commits.
    [
      'Codex: BREAK in an IF block',
      `IF true { CREATE tag:in_before SET name = 'in_before', category = 'theme'; BREAK; CREATE tag:in_after SET name = 'in_after', category = 'theme'; };`,
      'BREAK',
    ],
    [
      'Codex: CONTINUE in an IF block',
      `IF true { CREATE tag:in_before SET name = 'in_before', category = 'theme'; CONTINUE; CREATE tag:in_after SET name = 'in_after', category = 'theme'; };`,
      'CONTINUE',
    ],
  ] as [string, string, string][])(
    'refuses %s before anything runs: no writes, no marker',
    async (_, middle, word) => {
      const result = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({
          'data/0009-refused.surql': `${tag('before')}${middle}\n${tag('after')}`,
        }),
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(word);
      expect(result.output).toContain('nothing was run');
      expect(
        await tagIds(t, 'before', 'after', 'in_before', 'in_after'),
      ).toEqual([]);
      expect(await appliedIds(t)).toEqual(SEEDS);
      expect(await pendingSteps(t)).toEqual([]);
    },
  );

  it('allows the refused words in strings, comments and ids', async () => {
    const text = [
      `CREATE tag:s SET name = 'RETURN 1; COMMIT;', category = 'theme';`,
      '-- RETURN 1;',
      '// RETURN 1;',
      '# COMMIT;',
      '/* BEGIN; RETURN 1; */',
      `CREATE tag:⟨RETURN; x⟩ SET name = "it\\"s; RETURN", category = 'theme';`,
      'FOR $i IN [1, 2] { IF $i = 2 { CREATE tag:in_loop SET name = "BREAK", category = "theme"; }; };',
      tag('last'),
    ].join('\n');
    expect(
      await t.migrate(t.params(), {
        bundleDir: await bundleWith({ 'data/0006-allowed.surql': text }),
      }),
    ).toMatchObject({ applied: ['0006-allowed'] });
    expect(await tagIds(t, 'last')).toEqual(['last']);
  });

  // Review round 4: SurrealDB ends `--`/`//`/`#` comments at these line separators too; the
  // scanner ended them at LF only, so a BREAK after one was hidden from it.
  it.each([
    ['U+2028 (Codex)', '\u2028'],
    ['U+0085', '\u0085'],
    ['U+2029', '\u2029'],
  ])(
    'refuses a %s line separator after a comment, before anything runs',
    async (_, sep) => {
      const text = `IF true {\n${tag('sep_before')}-- comment${sep}BREAK;\n${tag('sep_after')}};\n`;
      const result = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({ 'data/0009-separator.surql': text }),
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(
        `U+${sep.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`,
      );
      expect(await tagIds(t, 'sep_before', 'sep_after')).toEqual([]);
      expect(await appliedIds(t)).not.toContain('0009-separator');
      expect(await pendingSteps(t)).toEqual([]);
    },
  );

  it.each([
    [
      'NUL in a string',
      `CREATE tag:z SET name = 'a\u0000b', category = 'theme';\n`,
      'U+0000',
    ],
    [
      'a form feed',
      `CREATE tag:z SET name = 'z', category = 'theme';\u000c\n`,
      'U+000C',
    ],
    [
      'a vertical tab in a string',
      `CREATE tag:z SET name = 'a\u000bb', category = 'theme';\n`,
      'U+000B',
    ],
    [
      'a no-break space outside a string',
      `CREATE tag:z SET name = 'z',\u00a0category = 'theme';\n`,
      'U+00A0',
    ],
    [
      'non-ASCII in a comment',
      `-- caf\u00e9\nCREATE tag:z SET name = 'z', category = 'theme';\n`,
      'printable ASCII',
    ],
  ])('refuses %s', async (_, text, message) => {
    const result = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({ 'data/0009-characters.surql': text }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(message);
    expect(await tagIds(t, 'z')).toEqual([]);
  });

  it('allows non-ASCII text inside string literals', async () => {
    expect(
      await t.migrate(t.params(), {
        bundleDir: await bundleWith({
          'data/0008-unicode.surql': `CREATE tag:uni SET name = 'caf\u00e9 ’quoted’', category = 'theme';\n`,
        }),
      }),
    ).toMatchObject({ applied: ['0008-unicode'] });
    expect(
      await rows(await t.migrator(), 'SELECT VALUE name FROM tag:uni'),
    ).toEqual(['caf\u00e9 ’quoted’']);
  });

  it('defence in depth: a BREAK in an IF block that got past the grammar blocks until cleared (review round 4)', async () => {
    const leaky = `IF true {\n${tag('brk_before')}BREAK;\n${tag('brk_after')}};\n`;
    const bundle = await bundleWith({ 'data/0010-break.surql': leaky });
    const first = await t.runMigration(t.params(), {
      bundleDir: bundle,
      bypassGrammar: true,
    });
    expect(first.exitCode).toBe(3);
    expect(first.output).toContain('PARTIAL COMMIT POSSIBLE');
    // 3.2.4 committed the transaction (marker included) but skipped brk_after.
    expect(await tagIds(t, 'brk_before', 'brk_after')).toEqual(['brk_before']);
    expect(await pendingSteps(t)).toEqual(['0010-break']);

    // The second run must not treat the marker as proof: the pending row still blocks it.
    const second = await t.runMigration(t.params(), {
      bundleDir: bundle,
      bypassGrammar: true,
      env: { MIGRATE_PENDING_WAIT_SECONDS: '1' },
    });
    expect(second.exitCode).toBe(3);
    expect(second.output).toContain('blocked: unfinished step(s) 0010-break');

    // The operator completes the script's work and clears the row deliberately.
    await run(
      await t.migrator(),
      `${tag('brk_after')}DELETE _migrationPending:⟨0010-break⟩;`,
    );
    expect(
      await t.migrate(t.params(), { bundleDir: bundle, bypassGrammar: true }),
    ).toMatchObject({
      applied: [],
      alreadyApplied: expect.arrayContaining(['0010-break']),
    });
  });

  // Review round 5: the regex literals /'/ made the scanner read a string where SurrealDB reads
  // code, so it missed the RETURN, and its (wrong) statement count matched the shortened reply.
  const CODEX_REGEX = `LET $open = /'/;\nUPSERT reviewProbe:before SET ran = true;\nLET $stop = [RETURN 1];\nLET $close = /'/;\nUPSERT reviewProbe:after SET ran = true;\n`;
  const probes = async () =>
    'reviewProbe' in (await tables(t))
      ? rows<string>(
          await t.migrator(),
          'SELECT VALUE record::id(id) FROM reviewProbe ORDER BY id',
        )
      : [];

  it('refuses Codex’s regex example before anything runs (grammar on)', async () => {
    const result = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({ 'data/0011-regex.surql': CODEX_REGEX }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('`/` outside a string');
    expect(await probes()).toEqual([]);
    expect(await appliedIds(t)).not.toContain('0011-regex');
  });

  it('the closing acknowledgement catches it even with the grammar off: exit 3, then blocked until cleared', async () => {
    const bundle = await bundleWith({ 'data/0011-regex.surql': CODEX_REGEX });
    const first = await t.runMigration(t.params(), {
      bundleDir: bundle,
      bypassGrammar: true,
    });
    expect(first.exitCode).toBe(3);
    expect(first.output).toContain("the step's closing nonce never came back");
    expect(await probes()).toEqual(['before']); // 3.2.4 committed the part before the RETURN
    expect(await appliedIds(t)).not.toContain('0011-regex');
    expect(await pendingSteps(t)).toEqual(['0011-regex']);

    const second = await t.runMigration(t.params(), {
      bundleDir: bundle,
      bypassGrammar: true,
      env: { MIGRATE_PENDING_WAIT_SECONDS: '1' },
    });
    expect(second.exitCode).toBe(3);
    expect(second.output).toContain('blocked: unfinished step(s) 0011-regex');

    // The operator undoes the partial write, fixes the script and clears the row.
    await run(
      await t.migrator(),
      'DELETE reviewProbe; DELETE _migrationPending:⟨0011-regex⟩;',
    );
    expect(
      await t.migrate(t.params(), {
        bundleDir: await bundleWith({
          'data/0011-regex.surql': `UPSERT reviewProbe:before SET ran = true;\nUPSERT reviewProbe:after SET ran = true;\n`,
        }),
      }),
    ).toMatchObject({ applied: ['0011-regex'] });
    expect(await probes()).toEqual(['after', 'before']);
  });

  it.each([
    ['a regex literal', "LET $r = /a'b/;", '`/` outside a string'],
    ['division', 'LET $d = 4 / 2;', '`/` outside a string'],
    [
      'an r"…" record string',
      'LET $p = r"tag:a";',
      'prefixed string literal (r"',
    ],
    [
      "a u'…' uuid string",
      "LET $p = u'0189d6e3-8eac-703a-9a48-dd6c8bb0d0b6';",
      "prefixed string literal (u'",
    ],
    [
      "a d'…' datetime string",
      "LET $p = d'2024-01-01';",
      "prefixed string literal (d'",
    ],
    ['a b"…" bytes string', 'LET $p = b"ab";', 'prefixed string literal (b"'],
    ["an s'…' string", "LET $p = s'x';", "prefixed string literal (s'"],
    [
      'a backslash outside a string',
      'LET $p = 1 \\ 2;',
      '`\\` outside a string',
    ],
    ['`@`', 'LET $p = @x;', '`@` outside a string'],
    ['a closure (`|`)', 'LET $p = [1].map(|$v| $v);', '`|` outside a string'],
    ['`%`', 'LET $p = 5 % 2;', '`%` outside a string'],
  ])(
    'refuses %s in a data script, before anything runs',
    async (_, line, message) => {
      const result = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({
          'data/0012-literal.surql': `${tag('lit_before')}${line}\n`,
        }),
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(message);
      expect(await tagIds(t, 'lit_before')).toEqual([]);
    },
  );

  it('schema files are DDL only; RETURN only inside a DEFINE (tested contained)', async () => {
    const schema = await readFile(join(SCHEMA_DIR, 'schema.surql'), 'utf8');
    const dml = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({
        'schema.surql': `${schema}\n${tag('in_schema')}`,
      }),
    });
    expect(dml.exitCode).toBe(2);
    expect(dml.output).toContain('CREATE statement (only DEFINE/REMOVE here)');
    expect(await tagIds(t, 'in_schema')).toEqual([]);

    expect(
      (
        await t.runMigration(t.params(), {
          bundleDir: await bundleWith({
            'schema.surql': `${schema}\nDEFINE FUNCTION OVERWRITE fn::scratch::one() { RETURN 1; };\n`,
          }),
        })
      ).exitCode,
    ).toBe(0);
  });

  it('defence in depth: a RETURN that got past the grammar fails loudly and blocks every later run', async () => {
    const leaky = `${tag('dd_before')}${CODEX_EXAMPLES[0]}\n${tag('dd_after')}`;
    const bypassed = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({ 'data/0007-leaky.surql': leaky }),
      bypassGrammar: true,
    });
    expect(bypassed.exitCode).toBe(3);
    expect(bypassed.output).toContain(
      'PARTIAL COMMIT POSSIBLE, MANUAL RECOVERY NEEDED',
    );
    // What 3.2.4 committed before the early exit stays; the rest and the marker don't.
    expect(await tagIds(t, 'dd_before', 'dd_after')).toEqual(['dd_before']);
    expect(await appliedIds(t)).not.toContain('0007-leaky');
    expect(await pendingSteps(t)).toEqual(['0007-leaky']);

    // A retry, even with the script fixed, refuses to start: it can't mark 0007 as done.
    const retry = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({
        'data/0007-leaky.surql': `${tag('dd_before')}${tag('dd_after')}`,
      }),
      env: { MIGRATE_PENDING_WAIT_SECONDS: '1' },
    });
    expect(retry.exitCode).toBe(3);
    expect(retry.output).toContain('blocked: unfinished step(s) 0007-leaky');
    expect(await appliedIds(t)).not.toContain('0007-leaky');

    // The operator checks the data, undoes the partial write, clears the row (README).
    await run(
      await t.migrator(),
      'DELETE tag:dd_before; DELETE _migrationPending:⟨0007-leaky⟩;',
    );
    expect(
      await t.migrate(t.params(), {
        bundleDir: await bundleWith({
          'data/0007-leaky.surql': `${tag('dd_before')}${tag('dd_after')}`,
        }),
      }),
    ).toMatchObject({ applied: ['0007-leaky'] });
    expect(await tagIds(t, 'dd_before', 'dd_after')).toEqual([
      'dd_after',
      'dd_before',
    ]);
  });
});

// ---------------------------------------------------------------- the allow-list, proved on 3.2.4

/**
 * Round 3: the data-script grammar is an allow-list (migrate.py ALLOWED_STATEMENTS and
 * REFUSED_WORDS). Every allowed statement form runs to completion in each context (top level,
 * IF block, FOR block), with the statements after it and the _migration marker reached; every
 * refused word is refused before anything runs; and for the control-flow words, running the same
 * script directly (no runner) shows why: statements are skipped, and for BREAK/CONTINUE the
 * marker after the block still commits.
 */
describe('allow-list: the guard matches 3.2.4', () => {
  let t: TestDatabase;
  let seq = 100;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  const contexts: Record<string, (body: string) => string> = {
    top: (body) => body,
    'IF block': (body) => `IF true {\n${body}\n};`,
    'FOR block': (body) => `FOR $i IN [1] {\n${body}\n};`,
  };
  const wrap = (ctx: string, k: string, stmt: string) =>
    contexts[ctx](
      `CREATE tag:in_before_${k} SET name = 'b', category = 'theme';\n${stmt};\nCREATE tag:in_after_${k} SET name = 'a', category = 'theme';`,
    );
  const exists = async (id: string) =>
    (await rows(await t.migrator(), `SELECT VALUE id FROM tag:${id}`))
      .length === 1;

  // stmt(k) and what must hold afterwards (besides in_after and the marker).
  const allowed: Record<
    string,
    [(k: string) => string, (k: string) => Promise<boolean>]
  > = {
    CREATE: [
      (k) => `CREATE tag:e_${k} SET name = 'e', category = 'theme'`,
      (k) => exists(`e_${k}`),
    ],
    UPDATE: [
      (k) => `UPDATE tag:in_before_${k} SET name = 'updated'`,
      async (k) =>
        (
          await rows<string>(
            await t.migrator(),
            `SELECT VALUE name FROM tag:in_before_${k}`,
          )
        )[0] === 'updated',
    ],
    UPSERT: [
      (k) => `UPSERT tag:e_${k} SET name = 'e', category = 'theme'`,
      (k) => exists(`e_${k}`),
    ],
    DELETE: [
      (k) => `DELETE tag:in_before_${k}`,
      async (k) => !(await exists(`in_before_${k}`)),
    ],
    LET: [() => 'LET $v = 1', async () => true],
    IF: [
      (k) =>
        `IF true { CREATE tag:e_${k} SET name = 'e', category = 'theme'; }`,
      (k) => exists(`e_${k}`),
    ],
    FOR: [
      (k) =>
        `FOR $x IN [1, 2] { UPSERT tag:e_${k} SET name = 'e', category = 'theme'; }`,
      (k) => exists(`e_${k}`),
    ],
    SELECT: [() => 'SELECT * FROM tag', async () => true],
  };
  const allowedCases = Object.keys(allowed).flatMap((form) =>
    Object.keys(contexts).map((ctx) => [form, ctx]),
  );

  it.each(allowedCases)(
    'allowed: %s in %s runs to completion, marker last',
    async (form, ctx) => {
      const k = `${form}_${ctx}`.toLowerCase().replace(/\W+/g, '_');
      const script = `${String(++seq).padStart(4, '0')}-allowed`;
      const [stmt, holds] = allowed[form];
      const run_ = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({
          [`data/${script}.surql`]: `${wrap(ctx, k, stmt(k))}\n`,
        }),
      });
      expect(run_.exitCode).toBe(0);
      expect(await exists(`in_after_${k}`)).toBe(true);
      expect(await holds(k)).toBe(true);
      expect(await appliedIds(t)).toContain(script);
    },
  );

  it.each(Object.keys(contexts))(
    'allowed: THROW in %s aborts the step, confirmed by the server',
    async (ctx) => {
      const k = `throw_${ctx}`.replace(/\W+/g, '_');
      const script = `${String(++seq).padStart(4, '0')}-throws`;
      const result = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({
          [`data/${script}.surql`]: `${wrap(ctx, k, "THROW 'stop'")}\n`,
        }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("the server refused the step's COMMIT");
      expect(await exists(`in_before_${k}`)).toBe(false);
      expect(await appliedIds(t)).not.toContain(script);
      expect(await pendingSteps(t)).toEqual([]);
    },
  );

  const refused: Record<string, string> = {
    RETURN: 'RETURN 1',
    BREAK: 'BREAK',
    CONTINUE: 'CONTINUE',
    BEGIN: 'BEGIN TRANSACTION',
    COMMIT: 'COMMIT TRANSACTION',
    CANCEL: 'CANCEL TRANSACTION',
    OPTION: 'OPTION IMPORT',
    SLEEP: 'SLEEP 1ms',
    USE: 'USE NS elsewhere',
    DEFINE: 'DEFINE TABLE scratch_def SCHEMALESS',
    REMOVE: 'REMOVE TABLE IF EXISTS scratch_def',
    ALTER: "ALTER TABLE tag COMMENT 'x'",
    INFO: 'INFO FOR DB',
    KILL: "KILL u'0189d6e3-8eac-703a-9a48-dd6c8bb0d0b6'",
    LIVE: 'LIVE SELECT * FROM tag',
    THEN: "IF true THEN CREATE tag:t SET name = 't', category = 'theme' END",
    INSERT: "INSERT INTO tag { id: tag:ins, name: 'i', category: 'theme' }",
    RELATE: 'RELATE tag:a->rel->tag:b',
  };
  const refusedCases = Object.keys(refused).flatMap((word) =>
    Object.keys(contexts).map((ctx) => [word, ctx]),
  );

  it.each(refusedCases)(
    'refused: %s in %s, before anything runs',
    async (word, ctx) => {
      const k = `ref_${word}_${ctx}`.toLowerCase().replace(/\W+/g, '_');
      const script = `${String(++seq).padStart(4, '0')}-refused`;
      const result = await t.runMigration(t.params(), {
        bundleDir: await bundleWith({
          [`data/${script}.surql`]: `${wrap(ctx, k, refused[word])}\n`,
        }),
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(word);
      expect(await exists(`in_before_${k}`)).toBe(false);
      expect(await appliedIds(t)).not.toContain(script);
    },
  );

  // Why: the same script run directly in a transaction with a marker after it, as the runner
  // would without the grammar.
  it.each([
    ['RETURN', 'top', 'skips the rest and the marker'],
    ['RETURN', 'IF block', 'skips the rest and the marker'],
    ['RETURN', 'FOR block', 'skips the rest and the marker'],
    [
      'BREAK',
      'IF block',
      'skips the rest of the block, but the marker commits',
    ],
    [
      'BREAK',
      'FOR block',
      'skips the rest of the block, but the marker commits',
    ],
    [
      'CONTINUE',
      'IF block',
      'skips the rest of the block, but the marker commits',
    ],
    [
      'CONTINUE',
      'FOR block',
      'skips the rest of the block, but the marker commits',
    ],
  ])('reality on 3.2.4: %s in %s %s', async (word, ctx, what) => {
    const k = `real_${word}_${ctx}`.toLowerCase().replace(/\W+/g, '_');
    await outcome(
      await t.migrator(),
      `BEGIN TRANSACTION;\n${wrap(ctx, k, refused[word])}\nCREATE tag:mark_${k} SET name = 'm', category = 'theme';\nCOMMIT TRANSACTION;`,
    );
    expect(await exists(`in_before_${k}`)).toBe(true); // committed
    expect(await exists(`in_after_${k}`)).toBe(false); // silently skipped
    expect(await exists(`mark_${k}`)).toBe(what.includes('marker commits'));
  });
});

// ---------------------------------------------------------------- data scripts

describe('data scripts on an already-migrated database', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  it('runs a new script exactly once', async () => {
    const bundle = await bundleWith({
      'data/0003-add-tag.surql': tag('migrated'),
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
    expect(await tagIds(t, 'migrated')).toEqual(['migrated']);
  });

  it('a failing script leaves no _migration row, none of its writes and no pending row, and stops there', async () => {
    const failing = await bundleWith({
      'data/0004-fails.surql': `${tag('partial')}THROW 'boom';\n`,
      'data/0005-after.surql': tag('after'),
    });
    const result = await t.runMigration(t.params(), { bundleDir: failing });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('0004-fails: An error occurred: boom');
    expect(result.output).toContain("the server refused the step's COMMIT");
    expect(await appliedIds(t)).toEqual([...SEEDS, '0003-add-tag']);
    expect(await tagIds(t, 'partial', 'after')).toEqual([]);
    expect(await pendingSteps(t)).toEqual([]);

    const fixed = await bundleWith({
      'data/0004-fails.surql': tag('partial'),
      'data/0005-after.surql': tag('after'),
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
    const result = await t.runMigration(t.params(), {
      bundleDir: await bundleWith({
        'data/0001-seed-dpa-v1.surql': `${original}-- edited\n`,
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      '0001-seed-dpa-v1.surql changed after it was applied',
    );
  });

  it('a failing schema leaves the previous schema in place', async () => {
    const schema = await readFile(join(SCHEMA_DIR, 'schema.surql'), 'utf8');
    const broken = await bundleWith({
      // DDL only, failing at run time (no IF EXISTS).
      'schema.surql': `${schema}\nDEFINE TABLE OVERWRITE scratch SCHEMALESS;\nDEFINE FIELD OVERWRITE note ON story TYPE string;\nREMOVE TABLE does_not_exist;\n`,
    });
    const result = await t.runMigration(t.params(), { bundleDir: broken });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('schema:');
    expect('scratch' in (await tables(t))).toBe(false);
    const [story] = await rows<{ fields: Record<string, string> }>(
      await t.migrator(),
      'INFO FOR TABLE story',
    );
    expect(story.fields['note']).toBeUndefined();
    expect(await pendingSteps(t)).toEqual([]);
  });
});

// ---------------------------------------------------------------- parameters, DPA texts

describe('parameters (Terraform values)', () => {
  it('refuses, before changing anything, a script that uses a parameter passed as null', async () => {
    const t = await TestDatabase.create();
    try {
      const result = await t.runMigration(
        t.params({ clerk_jwt_public_key: null }),
        {
          bundleDir: await bundleWith({
            'schema.surql': `${await readFile(join(SCHEMA_DIR, 'schema.surql'), 'utf8')}\nDEFINE TABLE OVERWRITE scratch_marker SCHEMALESS PERMISSIONS NONE;\n`,
            'data/0003-needs-key.surql': `CREATE tag:k SET name = $clerk_jwt_public_key, category = 'theme';\n`,
          }),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        '0003-needs-key.surql uses clerk_jwt_public_key, which Terraform passed as null',
      );
      expect(await scratchTableExists(t)).toBe(false);
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
      await t.migrate(t.params({ dpa_sha256: { v1: edited } }));
      expect(await hash()).toEqual([edited]);

      await run(
        await t.service('api_admin'),
        `UPDATE dpaVersion:v1 SET status = 'published', effectiveFrom = time::now()`,
      );
      const changed = await t.runMigration(
        t.params({ dpa_sha256: { v1: sha256('changed after publishing') } }),
        { bundleDir: await withScratchTable() },
      );
      expect(changed.exitCode).toBe(1);
      expect(changed.output).toContain(
        'dpaVersion:v1 is published, but its file in libs/legal/dpa has changed',
      );
      expect(await hash()).toEqual([edited]);
      expect(await scratchTableExists(t)).toBe(false); // checked before the schema step

      const missing = await t.runMigration(t.params({ dpa_sha256: {} }), {
        bundleDir: await withScratchTable(),
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.output).toContain(
        'dpaVersion:v1 exists, but libs/legal/dpa/v1.md does not',
      );
      expect(await scratchTableExists(t)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('P2-5: a seeded draft without its file fails too; a version not seeded yet may lack one', async () => {
    const t = await TestDatabase.create();
    try {
      const result = await t.runMigration(t.params({ dpa_sha256: {} }), {
        bundleDir: await withScratchTable(),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        'dpaVersion:v1 exists, but libs/legal/dpa/v1.md does not',
      );
      expect(await scratchTableExists(t)).toBe(false);
      expect(
        (
          await t.runMigration(
            t.params({ dpa_sha256: { v1: DPA_V1_SHA256, v2: sha256('v2') } }),
          )
        ).exitCode,
      ).toBe(0);
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------- fencing token

describe('P2: overlapping runners (fencing token from the database)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  const lockToken = async () =>
    (
      await rows<number>(
        await t.migrator(),
        'SELECT VALUE token FROM _migrationRun:lock',
      )
    )[0];

  it('two identical runners at once: distinct tokens, the script applied exactly once, nothing left pending', async () => {
    const bundle = await bundleWith({ 'data/0003-once.surql': tag('once') });
    const before = await lockToken();
    const [a, b] = await Promise.all([
      t.runMigration(t.params(), { bundleDir: bundle }),
      t.runMigration(t.params(), { bundleDir: bundle }),
    ]);
    expect([a.exitCode, b.exitCode].every((c) => c === 0 || c === 1)).toBe(
      true,
    );
    expect([a.exitCode, b.exitCode]).toContain(0);
    expect(await lockToken()).toBe(before + 2);
    expect(await appliedIds(t)).toEqual([...SEEDS, '0003-once']);
    expect(await tagIds(t, 'once')).toEqual(['once']);
    expect(await pendingSteps(t)).toEqual([]);
  });

  it('a run paused mid-step loses to a run that started after it, keeping nothing of that step', async () => {
    const slowA = await bundleWith({
      // About 9 s of work inside the step's transaction (SLEEP needs root, which the migrator
      // isn't; tested: 'IAM error: Not enough permissions').
      'data/0010-slow.surql': `FOR $i IN 1..50 { LET $h = crypto::bcrypt::generate('slow'); };\n${tag('slow')}`,
    });
    let inSlowStep: () => void = () => undefined;
    const aInStep = new Promise<void>((r) => (inSlowStep = r));
    const a = t.runMigration(t.params(), {
      bundleDir: slowA,
      onOutput: (chunk) => {
        if (chunk.includes('schema.surql:')) inSlowStep(); // next: 0010's transaction
      },
    });
    await aInStep;
    const b = await t.runMigration(t.params()); // the newer bundle, without 0010
    const resultA = await a;
    expect(b.exitCode).toBe(0);
    expect(resultA.exitCode).toBe(1);
    expect(resultA.output).toMatch(/superseded|conflict/i);
    expect(await appliedIds(t)).not.toContain('0010-slow');
    expect(await tagIds(t, 'slow')).toEqual([]);
    expect(await pendingSteps(t)).toEqual([]);
    expect(await lockToken()).toBe(b.summary?.token);
  }, 60_000);

  it('a rollback to an older bundle is simply a newer run, and succeeds', async () => {
    const newer = await bundleWith({ 'data/0011-newer.surql': tag('newer') });
    expect(await t.migrate(t.params(), { bundleDir: newer })).toMatchObject({
      applied: ['0011-newer'],
    });
    const rolledBack = await t.runMigration(t.params()); // the older bundle
    expect(rolledBack.exitCode).toBe(0);
    expect(rolledBack.output).toContain(
      "_migration:0011-newer was applied but its script isn't in the bundle",
    );
  });
});

// ---------------------------------------------------------------- Clerk

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

// ---------------------------------------------------------------- the real restart

const hasDocker = (() => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * P1-1 (round 1) and P2 (round 2) on a dedicated container with a persistent volume, restarted
 * with `--import-file` as the StatefulSet does: the restart ends old sessions; a failed init
 * (runtime or syntax error) keeps the old identities and leaves the check not Ready.
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
    const handles: TestDatabase[] = [];

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
    /**
     * Restart with an init script; the new handle keeps the credentials. Connections opened
     * before are NOT closed here: only the restart may end them.
     */
    async function restartWith(init: string): Promise<void> {
      await writeFile(join(initDir, 'init.surql'), init, { mode: 0o644 });
      handles.push(t);
      stop();
      const url = await start(true);
      t = Object.assign(TestDatabase.at(url, 'heisreal', 'main'), {
        migratorPassword: t.migratorPassword,
        backupPassword: t.backupPassword,
        servicePasswords: t.servicePasswords,
      });
    }

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
      await restartWith(
        await renderInit(t, 'cutover-1', { namespace: 'heisreal' }),
      );
    }, 90_000);
    afterAll(async () => {
      await t?.close().catch(() => undefined);
      for (const h of handles) await h.closeConnections();
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

    it('the identity check is Ready, then the migrate Job runs and every service signs in', async () => {
      expect(await t.identityCheck(t.credentials(), 'cutover-1')).toMatchObject(
        {
          ready: true,
        },
      );
      const result = await t.runMigration(
        t.params({ identity_hash: 'cutover-1' }),
        { env: JOB_ENV },
      );
      expect(result.exitCode).toBe(0);
      expect(result.summary).toMatchObject({ applied: SEEDS });
      for (const service of SERVICES) {
        expect(await rows(await t.service(service), 'RETURN $auth')).toEqual([
          `service:${service}`,
        ]);
      }
    });

    it('a restart whose init fails at runtime keeps the old identities and is not Ready', async () => {
      const previous = new Map(t.servicePasswords);
      for (const s of SERVICES)
        t.servicePasswords.set(s, randomBytes(18).toString('hex'));
      await restartWith(
        await renderInit(t, 'cutover-2', {
          namespace: 'heisreal',
          breakApiUser: true,
        }),
      );
      expect(
        await rows(
          await t.migrator(),
          'SELECT VALUE hash FROM _identity:current',
        ),
      ).toEqual(['cutover-1']);
      const check = await t.identityCheck(t.credentials(), 'cutover-2');
      expect(check.ready).toBe(false);
      expect(check.output).toContain('NOT READY');
      expect(
        await rows(
          await t.service('api_user', previous.get('api_user')),
          'RETURN $auth',
        ),
      ).toEqual(['service:api_user']); // the old password still works: nothing changed
      t.servicePasswords = previous;
    });

    it('a restart with a syntactically invalid init is not Ready', async () => {
      await restartWith('THIS IS NOT SURREALQL;\n');
      expect((await t.identityCheck(t.credentials(), 'cutover-3')).ready).toBe(
        false,
      );
      // …while the server itself answers /health (why readiness can't rely on it).
      const health = await fetch(`${t.url.replace(/^ws/, 'http')}/health`);
      expect(health.status).toBe(200);
    });
  },
);

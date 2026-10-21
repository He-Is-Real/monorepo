import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuthProvider, Surreal, type SurrealQueryable } from 'surrealdb';
import {
  clerkClaims,
  type ClerkTokenOptions,
  newSigningKeys,
  signRs256,
  type SigningKeys,
} from './jwt';

export const SCHEMA_DIR = join(__dirname, '../../schema');
/** The migrate Job's runner (D14): the tests apply the schema with it, exactly as the Job does. */
export const RUNNER = join(SCHEMA_DIR, 'migrate.py');
export const IDENTITY_CHECK = join(
  __dirname,
  '../../../../infra/k8s/surrealdb/base/identity_check.py',
);

export const SERVICES = [
  'api_public_read',
  'api_user',
  'api_admin',
  'workflow',
] as const;
export type ServiceName = (typeof SERVICES)[number];

export type Row = Record<string, unknown>;

export const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** The parameters Terraform passes the runner (params.json); null = not available yet. */
export interface MigrationParams {
  clerk_jwt_public_key: string | null;
  /** { <dpaVersion id>: sha256 of libs/legal/dpa/<id>.md } for every file there */
  dpa_sha256: Record<string, string>;
  /** The identity config that must be verified first (GKE); null = don't check */
  identity_hash: string | null;
  /** Seed 0003's walking-skeleton story (dev only, M0 0.9); Terraform's default is false. */
  seed_dev_story: boolean;
}

export interface MigrationSummary {
  schemaStatements: number;
  clerk: boolean;
  applied: string[];
  alreadyApplied: string[];
  /** The fencing token this run took from the database */
  token: number;
  bundle: string;
}

export interface MigrationRun {
  exitCode: number;
  output: string;
  summary?: MigrationSummary;
}

export interface MigrationOptions {
  /** A bundle directory (default: libs/database/schema itself). */
  bundleDir?: string;
  /** Extra environment, e.g. MIGRATE_EXPECT_USERS as the Job sets it. */
  env?: Record<string, string>;
  /** Called with the runner's output as it arrives (to act at a given step). */
  onOutput?: (chunk: string) => void;
  /**
   * Defence-in-depth tests only: run the real runner with its grammar check switched off (the
   * statement count stays), to see what happens when a dangerous script gets past it.
   */
  bypassGrammar?: boolean;
}

const BYPASS_GRAMMAR = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("migrate", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
real_scan = m.scan
m.scan = lambda text, mode="data": (real_scan(text, "runner")[0], [])
sys.argv = sys.argv[1:]
sys.exit(m.main())
`;

/** Runs SurrealQL and returns every statement's result as JSON; throws on the first error. */
export async function run(
  db: SurrealQueryable,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<unknown[]> {
  return (await db.query(sql, vars).json().collect()) as unknown[];
}

/** The last statement's result, as an array of rows (empty when nothing matched or was allowed). */
export async function rows<T = Row>(
  db: SurrealQueryable,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T[]> {
  const results = await run(db, sql, vars);
  const last = results[results.length - 1];
  if (last === undefined || last === null) return [];
  return (Array.isArray(last) ? last : [last]) as T[];
}

export type Outcome =
  { ok: true; result: unknown } | { ok: false; error: string };

/** The last statement's outcome, without throwing: for asserting on refusals. */
export async function outcome(
  db: SurrealQueryable,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const responses = await db.query(sql, vars).json().responses();
    const errors = responses.flatMap((r) =>
      r.success ? [] : [String(r.error?.message ?? r.error)],
    );
    if (errors.length) {
      // In a failed transaction every other statement reports "not executed"; surface the
      // root cause (surrealdb.js 2.0.x's collect() throws the first, unhelpful, one).
      const NOT_RUN = 'not executed due to a failed transaction';
      return {
        ok: false,
        error: errors.find((e) => !e.includes(NOT_RUN)) ?? errors[0],
      };
    }
    const last = responses[responses.length - 1];
    return { ok: true, result: last?.success ? last.result : undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * One isolated namespace/database per test file, with the schema and seeds applied by an
 * OWNER `migrator` system user (as the D14 migration Job will), and one `service` record per
 * service with a random password (argon2-hashed in the database).
 */
export class TestDatabase {
  readonly keys: SigningKeys = newSigningKeys();
  readonly migratorPassword = randomBytes(18).toString('hex');
  readonly backupPassword = randomBytes(18).toString('hex');
  servicePasswords = new Map<ServiceName, string>(
    SERVICES.map((s) => [s, randomBytes(18).toString('hex')]),
  );
  private readonly connections: Surreal[] = [];

  private constructor(
    readonly url: string,
    readonly namespace: string,
    readonly database: string,
  ) {}

  /** A handle on an existing server and database (e.g. a dedicated container); creates nothing. */
  static at(url: string, namespace: string, database: string): TestDatabase {
    return new TestDatabase(url, namespace, database);
  }

  /**
   * migrate: false leaves an empty database with only the migrator user (no schema, no
   * services), for tests of the migration itself.
   */
  static async create({ migrate = true } = {}): Promise<TestDatabase> {
    const url = process.env['SURREAL_TEST_URL'];
    if (!url) throw new Error('SURREAL_TEST_URL is not set (global setup)');
    const t = new TestDatabase(
      url,
      `it_${randomBytes(6).toString('hex')}`,
      'main',
    );
    const root = await t.root();
    await run(
      root,
      `DEFINE NAMESPACE ${t.namespace}; USE NS ${t.namespace};
       DEFINE DATABASE ${t.database}; USE NS ${t.namespace} DB ${t.database};
       DEFINE USER migrator ON DATABASE PASSWORD '${t.migratorPassword}' ROLES OWNER;`,
    ); // PASSWORD takes a literal only; the password is random hex
    if (migrate) {
      await t.migrate();
      await t.createServices();
    }
    return t;
  }

  /** What Terraform would pass, with this database's stand-in Clerk key. */
  params(overrides: Partial<MigrationParams> = {}): MigrationParams {
    return {
      clerk_jwt_public_key: this.keys.publicKeyPem,
      dpa_sha256: { v1: DPA_V1_SHA256 },
      identity_hash: null,
      seed_dev_story: false,
      ...overrides,
    };
  }

  /** Runs the migrate Job's runner against this database as the migrator; never throws. */
  async runMigration(
    params: MigrationParams = this.params(),
    {
      bundleDir = SCHEMA_DIR,
      env = {},
      onOutput,
      bypassGrammar = false,
    }: MigrationOptions = {},
  ): Promise<MigrationRun> {
    const dir = await mkdtemp(join(tmpdir(), 'migration-params-'));
    const paramsFile = join(dir, 'params.json');
    await writeFile(paramsFile, JSON.stringify(params));
    try {
      return await new Promise<MigrationRun>((resolve) => {
        const child = execFile(
          'python3',
          [
            ...(bypassGrammar ? ['-c', BYPASS_GRAMMAR] : []),
            RUNNER,
            bundleDir,
            '--params',
            paramsFile,
          ],
          {
            env: {
              PATH: process.env['PATH'],
              PYTHONDONTWRITEBYTECODE: '1', // no __pycache__ in libs/database/schema
              SURREAL_ENDPOINT: this.url.replace(/^ws/, 'http'),
              SURREAL_NAMESPACE: this.namespace,
              SURREAL_DATABASE: this.database,
              SURREAL_USER: 'migrator',
              SURREAL_PASS: this.migratorPassword,
              MIGRATE_WAIT_SECONDS: '20',
              MIGRATE_PENDING_WAIT_SECONDS: '20',
              ...env,
            },
          },
          (error, stdout, stderr) => {
            const output = `${stdout}${stderr}`;
            const line = stdout
              .split('\n')
              .find((l) => l.startsWith('MIGRATION SUMMARY '));
            resolve({
              exitCode: error ? Number(error.code ?? 1) : 0,
              output,
              summary: line
                ? (JSON.parse(
                    line.slice('MIGRATION SUMMARY '.length),
                  ) as MigrationSummary)
                : undefined,
            });
          },
        );
        if (onOutput) child.stdout?.on('data', (d) => onOutput(String(d)));
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * The identity-check sidecar's readiness check (infra/k8s/surrealdb/base/identity_check.py),
   * with these credentials and, optionally, the expected identity config hash.
   */
  async identityCheck(
    credentials: {
      migrator: string;
      backup: string;
      services: Record<string, string>;
    },
    expected?: string,
  ): Promise<{ ready: boolean; output: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'identity-check-'));
    try {
      await writeFile(
        join(dir, 'credentials.json'),
        JSON.stringify(credentials),
      );
      if (expected)
        await writeFile(join(dir, 'identity-hash'), `${expected}\n`);
      return await new Promise((resolve) => {
        execFile(
          'python3',
          [IDENTITY_CHECK],
          {
            env: {
              PATH: process.env['PATH'],
              PYTHONDONTWRITEBYTECODE: '1',
              SURREAL_ENDPOINT: this.url.replace(/^ws/, 'http'),
              SURREAL_NAMESPACE: this.namespace,
              SURREAL_DATABASE: this.database,
              IDENTITY_CREDENTIALS: join(dir, 'credentials.json'),
              IDENTITY_EXPECTED_FILE: join(dir, 'identity-hash'),
            },
          },
          (error, stdout, stderr) =>
            resolve({ ready: !error, output: `${stdout}${stderr}` }),
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The credentials the init Secret holds for this database (as ESO renders credentials.json). */
  credentials() {
    return {
      migrator: this.migratorPassword,
      backup: this.backupPassword,
      services: Object.fromEntries(this.servicePasswords),
    };
  }

  /** Migrates (schema, Clerk access, data scripts, DPA sync); throws if the runner fails. */
  async migrate(
    params?: MigrationParams,
    options?: MigrationOptions,
  ): Promise<MigrationSummary> {
    const result = await this.runMigration(params, options);
    if (result.exitCode !== 0 || !result.summary) {
      throw new Error(
        `migration failed (${result.exitCode}):\n${result.output}`,
      );
    }
    return result.summary;
  }

  /**
   * One `service` record per service. In the cluster the init Job writes these (see
   * migration.int-spec.ts); here the migrator does, with the same argon2 call.
   */
  async createServices(): Promise<void> {
    const migrator = await this.migrator();
    for (const [name, secret] of this.servicePasswords) {
      await run(
        migrator,
        `UPSERT type::record('service', $name) SET secretHash = crypto::argon2::generate($secret)`,
        { name, secret },
      );
    }
  }

  private async open(auth?: AuthProvider): Promise<Surreal> {
    const db = new Surreal();
    this.connections.push(db); // closed in close(), even if connecting fails
    await db.connect(this.url, {
      namespace: this.namespace,
      database: this.database,
      authentication: auth,
      reconnect: false,
    });
    return db;
  }

  /** Unauthenticated connection with the namespace and database selected. */
  connect(): Promise<Surreal> {
    return this.open();
  }

  root(): Promise<Surreal> {
    return this.open({
      username: process.env['SURREAL_TEST_USER'] ?? 'root',
      password: process.env['SURREAL_TEST_PASS'] ?? 'root',
    });
  }

  /** A database-level system user's login (only migrator and backup exist after init). */
  systemUser(username: string, password: string): Promise<Surreal> {
    return this.open({
      namespace: this.namespace,
      database: this.database,
      username,
      password,
    });
  }

  migrator(): Promise<Surreal> {
    return this.open({
      namespace: this.namespace,
      database: this.database,
      username: 'migrator',
      password: this.migratorPassword,
    });
  }

  /** A service's own login: DEFINE ACCESS svc with its name and password. */
  service(name: ServiceName, secret?: string): Promise<Surreal> {
    // Passed to connect() (not signin()) so the SDK signs in again after a reconnect or token
    // expiry. surrealdb.js 2.0.8 types `authentication` as system users/tokens only, but its
    // runtime signs in with any credentials; 2.1.0 types record access too.
    return this.open({
      namespace: this.namespace,
      database: this.database,
      access: 'svc',
      variables: { name, secret: secret ?? this.servicePasswords.get(name) },
    } as unknown as AuthProvider);
  }

  token(clerkUserId: string, options: Partial<ClerkTokenOptions> = {}): string {
    return signRs256(
      clerkClaims(clerkUserId, {
        namespace: this.namespace,
        database: this.database,
        ...options,
      }),
      this.keys.privateKey,
    );
  }

  /** A person's session (D27): its own connection, authenticated with their Clerk token. */
  async person(clerkUserId: string): Promise<Surreal> {
    const db = await this.connect();
    await db.authenticate(this.token(clerkUserId));
    return db;
  }

  /** Closes this handle's connections only (e.g. to a server that's gone). */
  async closeConnections(): Promise<void> {
    await Promise.all(
      this.connections.map((c) => c.close().catch(() => undefined)),
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      this.connections.map((c) => c.close().catch(() => undefined)),
    );
    const root = new Surreal();
    await root.connect(this.url, {
      authentication: {
        username: process.env['SURREAL_TEST_USER'] ?? 'root',
        password: process.env['SURREAL_TEST_PASS'] ?? 'root',
      },
      reconnect: false,
    });
    await root.query(`REMOVE NAMESPACE IF EXISTS ${this.namespace}`).collect();
    await root.close();
  }
}

/** A legacy DPA hash for the schema's D22 legacy-consent rules, kept until the M1 import (D44). */
export const LEGACY_SHA256 = sha256('legacy-squarespace placeholder');

/**
 * Test fixture: the published legacy DPA that seed 0002 used to create. D44 dropped the seed
 * (the M1 import gets a `legacy-migration` consent category instead), but the schema's D22
 * legacy-consent rules stay until then, so the tests that pin them create the row themselves.
 */
export async function seedLegacyDpaFixture(t: TestDatabase): Promise<void> {
  await run(
    await t.migrator(),
    `CREATE dpaVersion:\`legacy-squarespace\` CONTENT {
       kind: 'legacy', status: 'published', materiality: 'material',
       documentPath: 'libs/legal/dpa/legacy-squarespace.md', contentHash: $h,
       effectiveFrom: d'2024-01-01' }`,
    { h: LEGACY_SHA256 },
  );
}
export const DPA_V1_SHA256 = sha256('dpa v1 placeholder');

// ---------------------------------------------------------------- fixtures

export const CONSENT_TYPES = [
  'special_category_religious',
  'publish',
  'share_socials',
  'age_18plus',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/** Creates people the way production does: api-user creates the user record on first use. */
export async function createPeople(
  t: TestDatabase,
  people: Record<string, string>,
): Promise<void> {
  const apiUser = await t.service('api_user');
  for (const [id, clerkUserId] of Object.entries(people)) {
    const created = await rows(
      apiUser,
      `CREATE type::record('user', $id) SET clerkUserId = $clerkUserId`,
      { id, clerkUserId },
    );
    if (created.length !== 1) throw new Error(`could not create user:${id}`);
  }
}

/** api-admin publishes a DPA version (D20), creating it first if needed. */
export async function publishDpa(t: TestDatabase, id: string): Promise<void> {
  const admin = await t.service('api_admin');
  await run(
    admin,
    `IF !record::exists(type::record('dpaVersion', $id)) {
       CREATE type::record('dpaVersion', $id) CONTENT {
         materiality: 'material', documentPath: 'libs/legal/dpa/' + $id + '.md',
         contentHash: $hash };
     };
     UPDATE type::record('dpaVersion', $id) SET status = 'published', effectiveFrom = time::now();`,
    { id, hash: sha256(`dpa ${id}`) },
  );
}

/** The person grants or withdraws one consent type in their own session. */
export function consentEvent(
  person: SurrealQueryable,
  type: ConsentType,
  event: 'granted' | 'withdrawn',
  dpa = 'v1',
  extra: Row = {},
): Promise<Row[]> {
  return rows(
    person,
    `CREATE consent CONTENT object::extend({
       subject: $auth, type: $type, event: $event,
       dpaVersion: type::record('dpaVersion', $dpa),
       mechanism: 'web_form_submission', evidenceHash: $hash
     }, $extra)`,
    { type, event, dpa, hash: sha256(`${type} ${event} ${dpa}`), extra },
  );
}

export async function grantAll(
  person: SurrealQueryable,
  dpa = 'v1',
): Promise<void> {
  for (const type of CONSENT_TYPES) {
    const r = await consentEvent(person, type, 'granted', dpa);
    if (r.length !== 1) throw new Error(`consent ${type} not recorded`);
  }
}

let storySeq = 0;
/** The person creates a draft story in their own session. */
export function createDraft(
  person: SurrealQueryable,
  fields: Row = {},
): Promise<Row[]> {
  storySeq += 1;
  return rows(
    person,
    `CREATE story CONTENT object::extend({
       submitter: $auth, slug: $slug, title: 'A story', description: 'How I came to faith',
       primaryFormat: 'written', body: 'Text'
     }, $fields)`,
    { slug: `story-${storySeq}-${randomBytes(3).toString('hex')}`, fields },
  );
}

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
import { surrealTestLogin } from './login';

/**
 * A test that runs migrations gets this much time for each one (a Vitest test timeout, not an
 * assertion): each run starts the Python runner and re-applies the whole schema, so how long it
 * takes depends on the machine and what else runs on it, not on the behaviour checked.
 */
export const MIGRATION_TIMEOUT_MS = 60_000;

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
  'housekeeping',
] as const;
export type ServiceName = (typeof SERVICES)[number];

export type Row = Record<string, unknown>;

export const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** The parameters OpenTofu passes the runner (params.json); null = not available yet. */
export interface MigrationParams {
  clerk_jwt_public_key: string | null;
  /** { <dpaVersion id>: sha256 of libs/legal/dpa/<id>.md } for every file there */
  dpa_sha256: Record<string, string>;
  /** { <dpaVersion id>: the words of libs/legal/dpa/<id>.md } (D84: copied into the row) */
  dpa_text: Record<string, string>;
  /** { signup|testimony|social: { <id>: sha256 of libs/legal/forms/<kind>/<id>.md } } (D84) */
  form_sha256: Record<FormKind, Record<string, string>>;
  /** The same files' words. */
  form_text: Record<FormKind, Record<string, string>>;
  /** D114: each version's boxes, its <id>.statements.json decoded. */
  form_statements: Record<FormKind, Record<string, FormStatements>>;
  /** The same files' sha256. */
  form_statements_sha256: Record<FormKind, Record<string, string>>;
  /** D121: { <id>: the words of libs/legal/terms/<id>.md } (data 0007). */
  terms_text: Record<string, string>;
  /** D75: dev's placeholder privacy document and forms; OpenTofu allows true in dev only. */
  dev_legal_placeholders: boolean;
  /** The identity config that must be verified first (GKE); null = don't check */
  identity_hash: string | null;
  /** Seed 0003's walking-skeleton story (dev only, M0 0.9); OpenTofu's default is false. */
  seed_dev_story: boolean;
  /** D48: relax consent checks for dummy data; OpenTofu allows true in dev only (default false). */
  dev_consent_relaxed: boolean;
  /** The environment OpenTofu migrates ('dev', ...); null = not given. */
  environment: string | null;
}

export interface MigrationSummary {
  schemaStatements: number;
  clerk: boolean;
  /** D48: whether the database relaxes consent checks after this run (read back, not assumed). */
  devConsentRelaxed: boolean;
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
  /** The runner (default: this bundle's migrate.py; an older release's for upgrade tests). */
  runner?: string;
  /** Extra environment, e.g. MIGRATE_EXPECT_USERS as the Job sets it. */
  env?: Record<string, string>;
  /** Called with the runner's output as it arrives (to act at a given step). */
  onOutput?: (chunk: string) => void;
  /** With MIGRATE_TEST_PAUSE_BEFORE=<step> in `env`: lets the paused runner go on. */
  resume?: Promise<void>;
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
  static async create({
    migrate = true,
    params,
  }: {
    migrate?: boolean;
    params?: Partial<MigrationParams>;
  } = {}): Promise<TestDatabase> {
    const t = new TestDatabase(
      surrealTestLogin().url,
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
      await t.migrate(t.params(params));
      await t.createServices();
    }
    return t;
  }

  /** What OpenTofu would pass, with this database's stand-in Clerk key. */
  params(overrides: Partial<MigrationParams> = {}): MigrationParams {
    return {
      clerk_jwt_public_key: this.keys.publicKeyPem,
      ...legalParams(),
      identity_hash: null,
      seed_dev_story: false,
      dev_consent_relaxed: false,
      dev_legal_placeholders: false,
      environment: null,
      ...overrides,
    };
  }

  /** Runs the migrate Job's runner against this database as the migrator; never throws. */
  async runMigration(
    params: MigrationParams = this.params(),
    {
      bundleDir = SCHEMA_DIR,
      runner = RUNNER,
      env = {},
      onOutput,
      resume,
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
            runner,
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
        // MIGRATE_TEST_PAUSE_BEFORE: the runner waits for a line on stdin.
        if (resume) void resume.then(() => child.stdin?.end('\n'));
        else child.stdin?.end();
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
    /** system-users.json: other system users (D49: dev_seed in dev) and their passwords. */
    extraUsers?: Record<string, string>,
  ): Promise<{ ready: boolean; output: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'identity-check-'));
    try {
      await writeFile(
        join(dir, 'credentials.json'),
        JSON.stringify(credentials),
      );
      if (expected)
        await writeFile(join(dir, 'identity-hash'), `${expected}\n`);
      if (extraUsers)
        await writeFile(
          join(dir, 'system-users.json'),
          JSON.stringify(extraUsers),
        );
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
              IDENTITY_EXTRA_USERS: join(dir, 'system-users.json'),
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
      username: surrealTestLogin().user,
      password: surrealTestLogin().pass,
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

  /**
   * A person's session (D27): its own connection, authenticated with their Clerk token.
   *
   * Like a browser's Clerk client, it gets a fresh token (60 s, as Clerk's) whenever the last one
   * expires: passed to connect(), the token callback is what surrealdb.js 2.0.8 renews through.
   * A token given to authenticate() instead is dropped at its `exp` (the SDK invalidates the
   * session), so a file that keeps a person's connection for over a minute, as a busy machine
   * makes it, would carry on as an anonymous session ("Anonymous access not allowed").
   */
  person(clerkUserId: string): Promise<Surreal> {
    return this.open(() => this.token(clerkUserId));
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
        username: surrealTestLogin().user,
        password: surrealTestLogin().pass,
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

export const LEGAL_DIR = join(__dirname, '../../../legal');
export type FormKind = 'signup' | 'testimony' | 'social';
export const FORM_KINDS: readonly FormKind[] = [
  'signup',
  'testimony',
  'social',
];
/** The schema table of each form. */
export const FORM_TABLE: Record<FormKind, string> = {
  signup: 'signupFormVersion',
  testimony: 'testimonyFormVersion',
  social: 'socialSharingFormVersion',
};

/** { <id>: words } of the .md files in a libs/legal directory. */
function texts(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => [f.slice(0, -3), readFileSync(join(dir, f), 'utf8')]),
  );
}
/** D114: a form version's statements file, `<id>.statements.json`. */
export interface FormStatements {
  statements: { key: string; label: string; step?: string }[];
}

/** { <id>: file text } of the .statements.json files in a libs/legal/forms directory. */
function statementFiles(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.statements.json'))
      .map((f) => [
        f.slice(0, -'.statements.json'.length),
        readFileSync(join(dir, f), 'utf8'),
      ]),
  );
}
const hashes = (t: Record<string, string>) =>
  Object.fromEntries(Object.entries(t).map(([id, text]) => [id, sha256(text)]));

/**
 * The legal texts' parameters as OpenTofu builds them (modules/db-migration), from the real
 * files in libs/legal, except DPA v1: the tests keep a stand-in text (and its hash) for it.
 */
export function legalParams(): Pick<
  MigrationParams,
  | 'dpa_sha256'
  | 'dpa_text'
  | 'form_sha256'
  | 'form_text'
  | 'form_statements'
  | 'form_statements_sha256'
  | 'terms_text'
> {
  const dpa = { ...texts(join(LEGAL_DIR, 'dpa')), v1: 'dpa v1 placeholder' };
  const forms = Object.fromEntries(
    FORM_KINDS.map((k) => [k, texts(join(LEGAL_DIR, 'forms', k))]),
  ) as Record<FormKind, Record<string, string>>;
  const statements = Object.fromEntries(
    FORM_KINDS.map((k) => [k, statementFiles(join(LEGAL_DIR, 'forms', k))]),
  ) as Record<FormKind, Record<string, string>>;
  return {
    terms_text: texts(join(LEGAL_DIR, 'terms')),
    dpa_sha256: hashes(dpa),
    dpa_text: dpa,
    form_sha256: Object.fromEntries(
      FORM_KINDS.map((k) => [k, hashes(forms[k])]),
    ) as Record<FormKind, Record<string, string>>,
    form_text: forms,
    form_statements: Object.fromEntries(
      FORM_KINDS.map((k) => [
        k,
        Object.fromEntries(
          Object.entries(statements[k]).map(([id, text]) => [
            id,
            JSON.parse(text) as FormStatements,
          ]),
        ),
      ]),
    ) as Record<FormKind, Record<string, FormStatements>>,
    form_statements_sha256: Object.fromEntries(
      FORM_KINDS.map((k) => [k, hashes(statements[k])]),
    ) as Record<FormKind, Record<string, string>>,
  };
}

// ---------------------------------------------------------------- fixtures

/** What grantAll grants: every statement of the three forms (D93). */
export const CONSENT_TYPES = [
  'special_category_religious',
  'publish',
  'share_socials',
  'age_18plus',
  'account_data',
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

/**
 * Marks people trusted submitters (D94, D112: submitterLimits.trusted), as the migrator: no
 * open-drafts or weekly limit. For suites about other rules that start more stories per person
 * than the limits allow.
 */
export async function trustSubmitters(
  t: TestDatabase,
  ...ids: string[]
): Promise<void> {
  const migrator = await t.migrator();
  for (const id of ids) {
    await run(
      migrator,
      `UPSERT type::record('submitterLimits', $id) SET user = type::record('user', $id),
         trusted = true`,
      { id },
    );
  }
}

/**
 * api-admin publishes a DPA version (D20), creating it first if needed, and with it version
 * <id> of the three consent forms (D84, D93), linked to it: the ledger fixtures bind each grant to the
 * form of the same id. A form's text is its file in libs/legal/forms when there is one (so a
 * later migration's form-sync agrees), else a stand-in.
 */
export async function publishDpa(
  t: TestDatabase,
  id: string,
  testimony: Row = {},
): Promise<void> {
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
  await publishForm(t, 'signup', id, { dpa: id });
  await publishForm(t, 'testimony', id, { dpa: id, ...testimony });
  await publishForm(t, 'social', id, { dpa: id });
}

/** The statements a form version must have (fn::form::required_statements). */
export function requiredStatements(kind: FormKind, fields: Row = {}): string[] {
  if (kind === 'signup')
    return fields['coversTerms'] === true
      ? ['age_18plus', 'account_data', 'terms_of_use']
      : ['age_18plus', 'account_data'];
  if (kind === 'social') return ['share_socials'];
  return fields['coversPublicPublishing'] === true
    ? ['special_category_religious', 'publish']
    : ['special_category_religious'];
}

/** api-admin creates and publishes version <id> of a consent form, linked to DPA `dpa`. */
export async function publishForm(
  t: TestDatabase,
  kind: FormKind,
  id: string,
  { dpa = 'v1', ...fields }: Row & { dpa?: string } = {},
): Promise<void> {
  const legal = legalParams();
  // A repo version whose file asks for the terms (sign-up v2, D122) is used as it is only when
  // the test asks for the terms too (coversTerms); otherwise a stand-in of that id.
  const repo = !(
    kind === 'signup' &&
    legal.form_statements[kind][id]?.statements.some(
      (s) => s.key === 'terms_of_use',
    ) &&
    fields['coversTerms'] !== true
  );
  const text =
    (repo ? legal.form_text[kind][id] : undefined) ??
    `Stand-in ${kind} form ${id}.`;
  const features =
    kind === 'testimony'
      ? { coversPublicPublishing: true, draftRetentionMonths: 6 }
      : {};
  // D114: its boxes, from its statements file, or stand-in words for the ones it must have.
  const file = repo ? legal.form_statements[kind][id] : undefined;
  const statements =
    file?.statements ??
    requiredStatements(kind, { ...features, ...fields }).map((key) => ({
      key,
      label: `Stand-in words for ${key} on ${kind} form ${id}.`,
    }));
  const content = {
    status: 'published',
    textRef: `libs/legal/forms/${kind}/${id}.md`,
    textHash: sha256(text),
    text,
    statements,
    statementsHash:
      (repo ? legal.form_statements_sha256[kind][id] : undefined) ??
      sha256(JSON.stringify({ statements })),
    ...features,
    ...fields,
  };
  const created = await rows(
    await t.service('api_admin'),
    `CREATE type::record($table, $id) CONTENT object::extend($content, {
       dpaVersion: type::record('dpaVersion', $dpa) })`,
    { table: FORM_TABLE[kind], id, content, dpa },
  );
  if (created.length !== 1) throw new Error(`form ${kind} ${id} not published`);
}

/** The form a consent type is ticked on (D93): 18+ and account_data at sign-up, sharing on the social form. */
export const formOf = (type: string, version: string) =>
  `${
    type === 'account_data' || type === 'age_18plus'
      ? FORM_TABLE.signup
      : type === 'share_socials'
        ? FORM_TABLE.social
        : FORM_TABLE.testimony
  }:${version}`;

/**
 * The person grants or withdraws one consent type in their own session, on form version `dpa`
 * of its form (publishDpa publishes both forms with the DPA's id).
 */
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
       dpaVersion: type::record('dpaVersion', $dpa), form: <record> $form,
       mechanism: 'web_form_submission', evidenceHash: $hash
     }, $extra)`,
    {
      type,
      event,
      dpa,
      form: formOf(type, dpa),
      hash: sha256(`${type} ${event} ${dpa}`),
      extra,
    },
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

/**
 * Story text long enough to submit: a written story needs at least 200 characters from submit
 * on (Joel, 2026-10-23, from the POC). Plain filler, no testimony words.
 */
export const STORY_TEXT_PADDING =
  '. Filler for the tests, long enough to submit. '.repeat(5).trimEnd();

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
       primaryFormat: 'written', body: 'Text' + $padding
     }, $fields)`,
    {
      slug: `story-${storySeq}-${randomBytes(3).toString('hex')}`,
      fields,
      padding: STORY_TEXT_PADDING,
    },
  );
}

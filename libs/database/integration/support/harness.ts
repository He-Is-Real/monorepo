import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

export const SERVICES = [
  'api_public_read',
  'api_user',
  'api_admin',
  'workflow',
] as const;
export type ServiceName = (typeof SERVICES)[number];

export type Row = Record<string, unknown>;

/** Fills the `${name}` placeholders Terraform's templatefile() fills in production. */
export function renderTemplate(
  file: string,
  vars: Record<string, string>,
): string {
  const text = readFileSync(join(SCHEMA_DIR, file), 'utf8').replace(
    /\$\{(\w+)\}/g,
    (_, name: string) => {
      if (!(name in vars)) throw new Error(`${file}: no value for \${${name}}`);
      return vars[name];
    },
  );
  return text;
}

export const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

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
  readonly servicePasswords = new Map<ServiceName, string>(
    SERVICES.map((s) => [s, randomBytes(18).toString('hex')]),
  );
  private readonly connections: Surreal[] = [];

  private constructor(
    readonly url: string,
    readonly namespace: string,
    readonly database: string,
  ) {}

  static async create(): Promise<TestDatabase> {
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
    await t.applySchema();
    await t.applySeeds();
    const migrator = await t.migrator();
    for (const [name, secret] of t.servicePasswords) {
      await run(
        migrator,
        `CREATE type::record('service', $name) SET secretHash = crypto::argon2::generate($secret)`,
        { name, secret },
      );
    }
    return t;
  }

  /** Applies schema.surql; returns the number of statements (all must succeed). */
  async applySchema(): Promise<number> {
    const sql = renderTemplate('schema.surql', {
      clerk_jwt_public_key: this.keys.publicKeyPem,
    });
    const responses = await (await this.migrator()).query(sql).responses();
    const errors = responses.filter((r) => !r.success);
    if (errors.length) {
      throw new Error(
        `schema.surql: ${errors.map((e) => (e.success ? '' : e.error?.message)).join('; ')}`,
      );
    }
    return responses.length;
  }

  async applySeeds(): Promise<void> {
    const migrator = await this.migrator();
    await run(
      migrator,
      renderTemplate('data/0001-seed-dpa-v1.surql', {
        dpa_v1_sha256: sha256('dpa v1 placeholder'),
      }),
    );
    await run(
      migrator,
      renderTemplate('data/0002-seed-legacy-dpa.surql', {
        legacy_sha256: LEGACY_SHA256,
      }),
    );
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

export const LEGACY_SHA256 = sha256('legacy-squarespace placeholder');

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

import { randomBytes } from 'node:crypto';
import { run, TestDatabase } from '@heisreal/database/integration-testing';
import type { Surreal } from 'surrealdb';
import { DATASET } from '../src/app/dataset';
import { buildVars, fakeUploads } from '../src/app/plan';
import { reset } from '../src/app/seed';

export { DATASET } from '../src/app/dataset';
export type { StoryFixture, TagFixture } from '../src/app/dataset';

/**
 * A SurrealDB (3.2.4, the real schema) set up the way dev is: the placeholder privacy document
 * and consent forms (D75), consent checks enforced (D48 off), and the dev-only `dev_seed` login
 * (D49). For integration tests: `@heisreal/dev-seed/testing`.
 */
export async function devDatabase(params: {
  legalPlaceholders: boolean;
  environment: string | null;
  relaxed?: boolean;
}): Promise<{ t: TestDatabase; seeder: Surreal }> {
  const t = await TestDatabase.create({ migrate: false });
  await t.migrate(
    t.params({
      dev_legal_placeholders: params.legalPlaceholders,
      dev_consent_relaxed: params.relaxed ?? false,
      environment: params.environment,
    }),
  );
  await t.createServices();
  const password = randomBytes(18).toString('hex');
  // What init.surql.tmpl's dev-seed line does in dev (modules/db-identity).
  await run(
    await t.root(),
    `USE NS ${t.namespace} DB ${t.database};
     DEFINE USER dev_seed ON DATABASE PASSWORD '${password}' ROLES EDITOR;`,
  ); // PASSWORD takes a literal only; the password is random hex
  return { t, seeder: await t.systemUser('dev_seed', password) };
}

/**
 * A dev database holding the whole D47 dataset (uploads are stand-ins with the media spec's
 * sizes and durations), loaded by the real reset. Other projects' integration tests read it
 * through their own service logins.
 */
export async function devDatabaseWithDataset(): Promise<TestDatabase> {
  const { t, seeder } = await devDatabase({
    legalPlaceholders: true,
    environment: 'dev',
  });
  await reset(seeder, buildVars(DATASET, fakeUploads()));
  return t;
}

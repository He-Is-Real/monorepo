import {
  LEGAL_TABLES,
  outcome,
  rows,
  run,
  SERVICES,
  TestDatabase,
} from './support/harness';

/** Plan 4e's guard events: the version tables' immutability and the agreement pointers' rules. */
const GUARD_EVENTS: Record<string, string[]> = {
  ...Object.fromEntries(LEGAL_TABLES.map((t) => [t, [`${t}_kept`]])),
  user: ['user_agreements'],
  story: ['story_agreements'],
};
const GUARD_FUNCTIONS = [
  'legal::check_pointer',
  'legal::check_version',
  'legal::latest',
  'legal::require_terms',
  'legal::require_testimony',
];

/** D14: schema.surql is declarative and idempotent; seeds run once; only the migrator changes the schema. */
describe('schema.surql and seeds on the pinned SurrealDB', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  it('lets the migrator (OWNER) define and remove schema', async () => {
    const migrator = await t.migrator();
    await run(
      migrator,
      'DEFINE TABLE scratch SCHEMALESS; REMOVE TABLE scratch;',
    );
  });

  describe.each(SERVICES)('service %s', (name) => {
    it.each([
      'DEFINE TABLE scratch SCHEMALESS',
      'DEFINE FIELD OVERWRITE note ON story TYPE option<string>',
      'REMOVE EVENT testimonyConsent_kept ON testimonyConsent',
      'REMOVE EVENT user_agreements ON user',
      'REMOVE TABLE testimonyConsent',
      'DEFINE ACCESS OVERWRITE svc ON DATABASE TYPE RECORD SIGNIN (SELECT * FROM service)',
      'DEFINE USER intruder ON DATABASE PASSWORD "x" ROLES OWNER',
      'DEFINE FUNCTION OVERWRITE fn::legal::latest($table: string) { RETURN NONE }',
    ])('is refused: %s', async (sql) => {
      const result = await outcome(await t.service(name), sql);
      expect(result.ok).toBe(false);
    });
  });

  it('refuses schema changes in a person session too', async () => {
    const apiUser = await t.service('api_user');
    await run(apiUser, `CREATE user:ddl SET clerkUserId = 'user_ddl'`);
    const person = await t.person('user_ddl');
    for (const sql of [
      'REMOVE TABLE testimonyConsent',
      'REMOVE EVENT termsOfUseAgreement_kept ON termsOfUseAgreement',
      'REMOVE EVENT user_agreements ON user',
      'DEFINE FUNCTION OVERWRITE fn::legal::require_terms($user: any) { RETURN NONE }',
    ]) {
      expect((await outcome(person, sql)).ok).toBe(false);
    }
  });

  it('still has every guard event and function after all the attempts', async () => {
    const migrator = await t.migrator();
    for (const [table, events] of Object.entries(GUARD_EVENTS)) {
      const [info] = await rows<{ events: Record<string, unknown> }>(
        migrator,
        `INFO FOR TABLE ${table}`,
      );
      expect(Object.keys(info?.events ?? {})).toEqual(
        expect.arrayContaining(events),
      );
    }
    const [db] = await rows<{ functions: Record<string, string> }>(
      migrator,
      'INFO FOR DB',
    );
    expect(Object.keys(db?.functions ?? {})).toEqual(
      expect.arrayContaining(GUARD_FUNCTIONS),
    );
    // The redefinition attempt changed nothing: the latest is still version 0, not NONE.
    expect(
      await rows(migrator, `RETURN fn::legal::latest('testimonyConsent')`),
    ).toEqual(['testimonyConsent:0']);
    expect(
      await rows(migrator, 'SELECT VALUE id FROM service ORDER BY id'),
    ).toHaveLength(SERVICES.length);
  });
});

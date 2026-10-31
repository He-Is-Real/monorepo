import { outcome, rows, run, SERVICES, TestDatabase } from './support/harness';

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
      'REMOVE EVENT consent_append_only ON consent',
      'REMOVE TABLE consent',
      'DEFINE ACCESS OVERWRITE svc ON DATABASE TYPE RECORD SIGNIN (SELECT * FROM service)',
      'DEFINE USER intruder ON DATABASE PASSWORD "x" ROLES OWNER',
      'DEFINE FUNCTION OVERWRITE fn::consent::current($u: any, $t: string) { RETURN { event: "granted" } }',
    ])('is refused: %s', async (sql) => {
      const result = await outcome(await t.service(name), sql);
      expect(result.ok).toBe(false);
    });
  });

  it('refuses schema changes in a person session too', async () => {
    const apiUser = await t.service('api_user');
    await run(apiUser, `CREATE user:ddl SET clerkUserId = 'user_ddl'`);
    const person = await t.person('user_ddl');
    expect((await outcome(person, 'REMOVE TABLE consent')).ok).toBe(false);
    expect(
      (await outcome(person, 'REMOVE EVENT consent_append_only ON consent')).ok,
    ).toBe(false);
  });

  it('still has every guard event after all the attempts', async () => {
    const migrator = await t.migrator();
    const [consent] = await rows<{ events: Record<string, unknown> }>(
      migrator,
      'INFO FOR TABLE consent',
    );
    expect(Object.keys(consent.events).sort()).toEqual([
      'consent_append_only',
      'consent_evidence_v4',
      'consent_evidence_v5',
      'consent_fence',
      'consent_form',
      'consent_legacy_only_migrator',
      'consent_legal_fence',
      'consent_published_dpa',
      'consent_story',
      'consent_withdrawal_requests_erasure',
      'consent_withdrawal_unhides',
    ]);
    expect(
      await rows(migrator, 'SELECT VALUE id FROM service ORDER BY id'),
    ).toHaveLength(SERVICES.length);
  });
});

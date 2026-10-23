import {
  DPA_V1_SHA256,
  outcome,
  rows,
  run,
  SERVICES,
  TestDatabase,
} from './support/harness';

/** D14: schema.surql is declarative and idempotent; seeds run once; only the migrator changes the schema. */
describe('schema.surql and seeds on the pinned SurrealDB', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  it('re-applies cleanly (every statement is OVERWRITE)', async () => {
    const { schemaStatements } = await t.migrate();
    expect(schemaStatements).toBeGreaterThan(100);
  });

  it('runs each seed once: re-running is a no-op', async () => {
    expect(await t.migrate()).toMatchObject({
      applied: [],
      alreadyApplied: [
        '0001-seed-dpa-v1',
        '0003-dev-seed-story',
        '0004-check-story-shapes',
      ],
    });
    const migrator = await t.migrator();
    expect(
      await rows(
        migrator,
        'SELECT VALUE record::id(id) FROM _migration ORDER BY id',
      ),
    ).toEqual([
      '0001-seed-dpa-v1',
      '0003-dev-seed-story',
      '0004-check-story-shapes',
    ]);
    expect(
      await rows(
        migrator,
        'SELECT record::id(id) AS id, status, kind, contentHash FROM dpaVersion ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'v1',
        status: 'draft',
        kind: 'standard',
        contentHash: DPA_V1_SHA256,
      },
    ]);
  });

  it('3.2.4 gotcha: an element index over record links finds nothing; over strings it works', async () => {
    // Why publicStory has tagSlugs (D63): `tagRefs.*` or `tagRefs[*]` indexes make
    // `tagRefs CONTAINS tag:x` use the index and return no rows.
    const migrator = await t.migrator();
    const found = await rows(
      migrator,
      `DEFINE TABLE gotcha_tag SCHEMAFULL; DEFINE TABLE gotcha SCHEMAFULL;
       DEFINE FIELD refs ON gotcha TYPE array<record<gotcha_tag>>;
       DEFINE FIELD names ON gotcha TYPE array<string>;
       DEFINE INDEX gotcha_refs ON gotcha FIELDS refs.*;
       DEFINE INDEX gotcha_names ON gotcha FIELDS names.*;
       CREATE gotcha_tag:a;
       CREATE gotcha:1 SET refs = [gotcha_tag:a], names = ['a'];
       RETURN {
         refs: (SELECT VALUE id FROM gotcha WHERE refs CONTAINS gotcha_tag:a),
         names: (SELECT VALUE id FROM gotcha WHERE names CONTAINS 'a')
       };`,
    );
    await run(migrator, 'REMOVE TABLE gotcha; REMOVE TABLE gotcha_tag;');
    expect(found.at(-1)).toEqual({ refs: [], names: ['gotcha:1'] });
  });

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
      'consent_fence',
      'consent_legacy_only_migrator',
      'consent_published_dpa',
      'consent_withdrawal_unhides',
    ]);
    expect(
      await rows(migrator, 'SELECT VALUE id FROM service ORDER BY id'),
    ).toHaveLength(4);
  });
});

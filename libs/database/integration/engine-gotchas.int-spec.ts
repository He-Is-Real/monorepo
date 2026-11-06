import { rows, run, TestDatabase } from './support/harness';

/**
 * The SurrealDB 3.2.4 behaviours the schema and queries work around (docs/db-permissions.md,
 * "SurrealDB 3.2.4 gotchas"), pinned on scratch tables so an engine upgrade shows which still
 * hold. A failure here means the engine changed: update that gotcha and the code relying on it.
 */
describe('SurrealDB gotchas the schema relies on', () => {
  let t: TestDatabase;
  let migrator: Awaited<ReturnType<TestDatabase['migrator']>>;
  const plan = async (sql: string) =>
    JSON.stringify(await run(migrator, sql)).replace(/\s+/g, ' ');

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
  });
  afterAll(() => t?.close());

  describe('queries and indexes', () => {
    beforeAll(async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_tag SCHEMALESS; DEFINE TABLE gotcha_item SCHEMALESS;
         DEFINE INDEX gotcha_item_refs ON gotcha_item FIELDS refs.*;
         DEFINE INDEX gotcha_item_names ON gotcha_item FIELDS names.*;
         CREATE gotcha_tag:a;
         CREATE gotcha_item:1 SET refs = [gotcha_tag:a], names = ['a'];`,
      );
    });

    it('finds nothing with CONTAINS over an element index on record links, but works over strings', async () => {
      expect(
        await rows(
          migrator,
          'SELECT VALUE id FROM gotcha_item WHERE refs CONTAINS gotcha_tag:a',
        ),
      ).toEqual([]);
      expect(
        await rows(
          migrator,
          `SELECT VALUE record::id(id) FROM gotcha_item WHERE names CONTAINS 'a'`,
        ),
      ).toEqual([1]);
    });

    it('uses no index for a query inside a closure', async () => {
      const query =
        'SELECT VALUE id FROM gotcha_item WHERE names CONTAINS $n LIMIT 1 EXPLAIN';
      expect(await plan(`LET $n = 'a'; ${query};`)).toContain('IndexScan');
      const inClosure = await plan(`RETURN ['a'].map(|$n| (${query}));`);
      expect(inClosure).toContain('Iterate Table');
      expect(inClosure).not.toContain('gotcha_item_names');
    });

    it('scans an index from the top when the cursor condition has an OR', async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_log SCHEMALESS;
         DEFINE INDEX gotcha_log_at ON gotcha_log FIELDS status, at;
         CREATE gotcha_log:1 SET status = 'ok', at = 1;`,
      );
      const select = `SELECT id, at FROM gotcha_log WHERE status = 'ok'`;
      const page = 'ORDER BY at DESC LIMIT 1 EXPLAIN';
      expect(await plan(`${select} AND at < 5 ${page}`)).toContain(
        `"access":"['ok'] LessThan 5"`,
      );
      const withOr = await plan(
        `${select} AND (at < 5 OR (at = 5 AND id < gotcha_log:9)) ${page}`,
      );
      expect(withOr).toContain(`"access":"['ok']"`);
      expect(withOr).toContain('Filter');
    });

    it("answers an IF block's one-row SELECT as the row itself", async () => {
      const one = '(SELECT VALUE id FROM gotcha_item WHERE id = gotcha_item:1)';
      const [plain, inIf, flattened] = await run(
        migrator,
        `RETURN ${one}; RETURN IF true { ${one} };
         RETURN array::flatten([IF true { ${one} }]);`,
      );
      expect(plain).toEqual(['gotcha_item:1']);
      expect(inIf).toBe('gotcha_item:1');
      expect(flattened).toEqual(['gotcha_item:1']);
    });
  });

  describe('fields and values', () => {
    it("reads the outer query's record as $parent in a computed field read inside a subquery", async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_owner SCHEMALESS; DEFINE TABLE gotcha_note SCHEMALESS;
         DEFINE FIELD viaParent ON gotcha_note COMPUTED $parent.kind;
         DEFINE FIELD viaOwn ON gotcha_note COMPUTED kind;
         CREATE gotcha_owner:p SET kind = 'owner';
         CREATE gotcha_note:1 SET kind = 'note', owner = gotcha_owner:p;`,
      );
      const [nested] = await rows<{
        notes: { viaParent: string; viaOwn: string }[];
      }>(
        migrator,
        `SELECT (SELECT viaParent, viaOwn FROM gotcha_note WHERE owner = $parent.id) AS notes
         FROM gotcha_owner:p`,
      );
      expect(nested.notes).toEqual([{ viaParent: 'owner', viaOwn: 'note' }]);
    });

    it("lets a caller's bound variable shadow a DEFINE PARAM inside a function", async () => {
      await run(
        migrator,
        `DEFINE PARAM $gotcha_p VALUE 1;
         DEFINE FUNCTION fn::gotcha::read_p() { RETURN $gotcha_p };`,
      );
      const results = await run(
        migrator,
        'RETURN fn::gotcha::read_p(); LET $gotcha_p = 2; RETURN fn::gotcha::read_p();',
      );
      expect([results[0], results[2]]).toEqual([1, 2]);
    });

    it('takes a client value for DEFAULT, never for VALUE; REMOVE FIELD keeps stored values', async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_f SCHEMAFULL;
         DEFINE FIELD d ON gotcha_f TYPE int DEFAULT 1;
         DEFINE FIELD v ON gotcha_f TYPE int VALUE 1;
         DEFINE FIELD gone ON gotcha_f TYPE option<int>;
         CREATE gotcha_f:1 SET d = 7, v = 7, gone = 5;
         REMOVE FIELD gone ON gotcha_f;`,
      );
      expect(await rows(migrator, 'SELECT d, v, gone FROM gotcha_f:1')).toEqual(
        [{ d: 7, v: 1, gone: 5 }],
      );
    });

    it("stores undefined keys in array<object> items (a nested object's are refused)", async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_a SCHEMAFULL;
         DEFINE FIELD arr ON gotcha_a TYPE array<object>;
         DEFINE FIELD arr.*.a ON gotcha_a TYPE int;
         DEFINE FIELD o ON gotcha_a TYPE option<object>;
         DEFINE FIELD o.a ON gotcha_a TYPE option<int>;
         CREATE gotcha_a:1 SET arr = [{ a: 1, b: 2 }];`,
      );
      expect(await rows(migrator, 'SELECT VALUE arr FROM gotcha_a:1')).toEqual([
        [{ a: 1, b: 2 }],
      ]);
      await expect(
        run(migrator, 'CREATE gotcha_a:2 SET arr = [], o = { a: 1, b: 2 }'),
      ).rejects.toThrow(/no such field/);
    });

    it('runs a field VALUE for a nested SET, with the whole new field and the old one', async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_seen SCHEMALESS; DEFINE TABLE gotcha_n SCHEMALESS;
         DEFINE FIELD m ON gotcha_n VALUE {
           CREATE gotcha_seen SET now = $value, before = $before; RETURN $value
         };
         CREATE gotcha_n:1 SET m = { a: 1 };
         DELETE gotcha_seen;
         UPDATE gotcha_n:1 SET m.a = 2;`,
      );
      expect(
        await rows(migrator, 'SELECT now, before FROM gotcha_seen'),
      ).toEqual([{ now: { a: 2 }, before: { a: 1 } }]);
    });
  });

  describe('sessions', () => {
    it('gives a service session $auth but no $auth.id; events run elevated, functions as the caller', async () => {
      await run(
        migrator,
        `DEFINE TABLE gotcha_secret SCHEMALESS PERMISSIONS NONE;
         DEFINE TABLE gotcha_open SCHEMALESS PERMISSIONS FULL;
         DEFINE EVENT gotcha_open_copy ON gotcha_open WHEN $event = 'CREATE' THEN {
           CREATE gotcha_secret SET from = $after.id
         };
         DEFINE FUNCTION fn::gotcha::secrets() { RETURN count(SELECT id FROM gotcha_secret) };`,
      );
      const service = await t.service('api_user');
      const [auth, authId] = await run(
        service,
        'RETURN record::id($auth); RETURN $auth.id;',
      );
      expect(auth).toBe('api_user');
      expect(authId).toBeUndefined(); // NONE

      await run(service, 'CREATE gotcha_open:1');
      expect(await run(migrator, 'RETURN fn::gotcha::secrets()')).toEqual([1]);
      expect(await run(service, 'RETURN fn::gotcha::secrets()')).toEqual([0]);
    });
  });
});

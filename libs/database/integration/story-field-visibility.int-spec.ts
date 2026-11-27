import { rows, TestDatabase } from './support/harness';

/**
 * BE-12 (Joel, 2026-11-27): on `story`, `storyStatusLog` and `storyFile`, everyone may read a
 * published story's row, and then every field on it that has no select rule of its own. So a
 * field added without `PERMISSIONS FOR select ...` would be public at once. This test makes that
 * a choice: every field on those tables either has its own select rule, or is in the list of
 * public fields below, on purpose.
 *
 * It reads the schema the migrator actually loaded (`INFO FOR TABLE ... STRUCTURE`), so a field
 * defined in any schema file, or written across several lines, is seen the way SurrealDB sees it.
 * A field with no select rule shows as `select: true` (FULL); `FOR select FULL` written out looks
 * the same, and needs the list too.
 *
 * Sub-fields (`a.b`, `a.*`) are checked one by one, like any field. SurrealDB makes `a.*` itself
 * for an array field, with no select rule. A private parent hides its sub-fields from those who
 * can't read it, whatever their own rule; a public parent shows each sub-field that has no rule.
 */
const PUBLIC_FIELDS: Record<string, string[]> = {
  story: [
    'currentStatus',
    'image',
    'image.file',
    'mediaFile',
    'primaryFormat',
    'slugHistory',
    'slugHistory.*',
    'themeIds',
    'themeIds.*',
    'themeRefs',
    'themeRefs.*',
    'updatedAt',
    'version',
  ],
  storyStatusLog: ['status', 'story'],
  storyFile: ['format', 'height', 'lengthSeconds', 'thumbnailPath', 'width'],
};

interface FieldInfo {
  name: string;
  permissions: { select: boolean | string };
}

describe('which story fields everyone can read (BE-12)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await TestDatabase.create();
  });
  afterAll(() => t?.close());

  it.each(Object.keys(PUBLIC_FIELDS))(
    'every field on %s has its own select rule or is on the public list',
    async (table) => {
      const [info] = await rows<{ fields: FieldInfo[] }>(
        await t.migrator(),
        `INFO FOR TABLE ${table} STRUCTURE`,
      );
      const fields = info?.fields ?? [];
      expect(fields.length).toBeGreaterThan(0);
      const publicNow = fields
        .filter((f) => f.permissions.select === true)
        .map((f) => f.name)
        .sort();
      const listed = [...(PUBLIC_FIELDS[table] ?? [])].sort();

      const unmarked = publicNow.filter((f) => !listed.includes(f));
      expect(
        unmarked,
        `Everyone can read these ${table} fields of a published story, and nobody chose that: ` +
          `${unmarked.join(', ')}. Give each one its own \`PERMISSIONS FOR select WHERE ...\` in ` +
          `libs/database/schema, or, only if Joel decided it is public, add it to PUBLIC_FIELDS ` +
          `in this test.`,
      ).toEqual([]);

      const stale = listed.filter((f) => !publicNow.includes(f));
      expect(
        stale,
        `PUBLIC_FIELDS lists ${table} fields that are gone or no longer public: ` +
          `${stale.join(', ')}. Take them off the list.`,
      ).toEqual([]);
    },
  );
});

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
 * A select rule only counts as private when every branch of it is one of PRIVATE_RULES (the person
 * the row belongs to, or named services). Any other rule, such as `WHERE true` or "everyone but
 * the nightly clean-up", still lets the public read the field, so that field needs the list too.
 *
 * Sub-fields (`a.b`, `a.*`) are checked one by one, like any field. SurrealDB makes `a.*` itself
 * for an array field, with no select rule. A private parent hides its sub-fields from those who
 * can't read it, whatever their own rule; a public parent shows each sub-field that has no rule.
 */
const PUBLIC_FIELDS: Record<string, string[]> = {
  story: [
    'body',
    'bylineName',
    'currentStatus',
    'description',
    'image',
    'image.file',
    'mediaFile',
    'primaryFormat',
    'slug',
    'slugHistory',
    'slugHistory.*',
    'themeIds',
    'themeIds.*',
    'themeRefs',
    'themeRefs.*',
    'title',
    'updatedAt',
    'version',
  ],
  storyStatusLog: ['publishedAt', 'status', 'story'],
  storyFile: ['format', 'height', 'lengthSeconds', 'thumbnailPath', 'width'],
};

/**
 * The only select conditions that keep a field from the public, as SurrealDB prints them: the
 * person the row belongs to, or one or more of the services that are not the public one
 * (`service:api_public_read` serves anonymous visitors, so a rule naming it is public).
 */
const PRIVATE_SERVICE = 'service:(?:api_user|api_admin|workflow|housekeeping)';
const PRIVATE_RULES = [
  /^(person|submitter|story\.submitter) = \$auth$/,
  new RegExp(`^\\$auth = \\(?${PRIVATE_SERVICE}\\)?$`),
  new RegExp(`^\\$auth INSIDE \\[${PRIVATE_SERVICE}(, ${PRIVATE_SERVICE})*\\]$`),
];

/** Private when every OR branch has at least one AND part that is a private rule. */
function isPrivate(select: boolean | string): boolean {
  if (select === false) return true;
  if (typeof select !== 'string') return false;
  return select.split(/\s+OR\s+/).every((branch) =>
    branch
      .split(/\s+AND\s+/)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .some((part) => PRIVATE_RULES.some((rule) => rule.test(part))),
  );
}

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
        .filter((f) => !isPrivate(f.permissions.select))
        .map((f) => f.name)
        .sort();
      const listed = [...(PUBLIC_FIELDS[table] ?? [])].sort();

      const unmarked = publicNow.filter((f) => !listed.includes(f));
      expect(
        unmarked,
        `Everyone can read these ${table} fields of a published story, and nobody chose that: ` +
          `${unmarked.join(', ')}. Give each one a select rule made only of PRIVATE_RULES in ` +
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

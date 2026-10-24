import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Surreal, SurrealQueryable } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  rows,
  run,
  SCHEMA_DIR,
  TestDatabase,
} from './support/harness';
import { approve, processed, submit } from './support/world';

/**
 * D53: a story is exactly one of three types, each with one main part and one optional part,
 * enforced by the database (event `story_shape`, one definition in `fn::story::shape_problem`):
 *   written → text (body, not blank), no video or audio; optional image
 *   video   → one video media item, optional text; no image
 *   audio   → one audio media item, optional text; no image
 * A draft is created before its upload (CreateDraftStory), so a video or audio story may have no
 * media while it's editable (draft, changes_requested); from submit on (pending, in_review,
 * approved) it needs exactly one. Shapes are real pixel sizes (positive ints), refused beyond
 * 1:3 or 3:1; audio has none. Media items and the image accept only the defined fields, so the
 * removed `aspectRatio` (or any free text) can't be stored. The image is the person's content
 * (D41): api-admin and workflow writes to it are dropped.
 */
describe('story types and shapes (D53)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let pat: Surreal;
  let seq = 0;

  const truth = <T = Record<string, unknown>>(
    sql: string,
    vars?: Record<string, unknown>,
  ) => rows<T>(migrator, sql, vars);

  /** Pat creates a story with these extra fields (SurrealQL object entries); returns its id. */
  const create = async (fields: string, person: SurrealQueryable = pat) => {
    seq += 1;
    const id = `shape_${seq}`;
    const result = await outcome(
      person,
      `CREATE type::record('story', $id) CONTENT {
         submitter: $auth, slug: $id, title: 'A story', description: 'How I came to faith',
         ${fields}
       } RETURN VALUE id`,
      { id },
    );
    return { id, result };
  };
  const created = async (fields: string) => {
    const { id, result } = await create(fields);
    expect(result).toEqual({ ok: true, result: [`story:${id}`] });
    return id;
  };
  const refused = async (fields: string, message: string) => {
    const { id, result } = await create(fields);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(message),
    });
    expect(
      await truth(`SELECT * FROM type::record('story', $id)`, { id }),
    ).toEqual([]);
  };
  const update = (id: string, set: string, db: SurrealQueryable = pat) =>
    outcome(db, `UPDATE type::record('story', $id) SET ${set}`, { id });

  const VIDEO = `{ format: 'video', bunnyVideoId: 'vid', width: 1080, height: 1920 }`;
  const AUDIO = `{ format: 'audio', bunnyVideoId: 'aud', durationSeconds: 60 }`;
  const IMAGE = `{ path: 'images/a.webp', width: 1200, height: 1600, alt: 'A sunrise' }`;
  /** A written story's text, long enough to submit (200 characters). */
  const TEXT = `body: '${'Words of the story. '.repeat(11)}'`;

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await publishDpa(t, 'v1');
    pat = await t.person('user_pat');
    await grantAll(pat);
  });
  afterAll(() => t?.close());

  describe('written', () => {
    it.each([
      ['text only', `primaryFormat: 'written', body: 'My story'`],
      [
        'text and an image',
        `primaryFormat: 'written', body: 'My story', image: ${IMAGE}`,
      ],
      [
        'an image without alt text (readers use a neutral default)',
        `primaryFormat: 'written', body: 'My story', image: { path: 'images/b.webp', width: 800, height: 800 }`,
      ],
      [
        'an image at exactly 1:3',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 500, height: 1500 }`,
      ],
      [
        'an image at exactly 3:1',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 1500, height: 500 }`,
      ],
    ])('allows %s', async (_name, fields) => {
      await created(fields);
    });

    it.each([
      ['no text', `primaryFormat: 'written'`, 'a written story needs its text'],
      [
        'blank text',
        `primaryFormat: 'written', body: ' \n\t '`,
        'a written story needs its text',
      ],
      [
        'a video',
        `primaryFormat: 'written', body: 'x', media: [${VIDEO}]`,
        'a written story has no video or audio',
      ],
      [
        'an audio file',
        `primaryFormat: 'written', body: 'x', media: [${AUDIO}]`,
        'a written story has no video or audio',
      ],
      [
        'an image taller than 1:3',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 500, height: 1501 }`,
        'beyond 1:3 or 3:1',
      ],
      [
        'an image wider than 3:1',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 1501, height: 500 }`,
        'beyond 1:3 or 3:1',
      ],
      [
        'an image of zero width',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 0, height: 500 }`,
        'image.width',
      ],
      [
        'an image without a height',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 500 }`,
        'image.height',
      ],
      [
        'an image without a path',
        `primaryFormat: 'written', body: 'x', image: { width: 500, height: 500 }`,
        'image.path',
      ],
      [
        'an image with an aspect-ratio label',
        `primaryFormat: 'written', body: 'x', image: { path: 'p', width: 5, height: 5, aspectRatio: '1:1' }`,
        'image.aspectRatio',
      ],
    ])('refuses %s', async (_name, fields, message) => {
      await refused(fields, message);
    });
  });

  describe('text length (Joel, 2026-10-23, from the POC)', () => {
    const body = (text: string) =>
      `primaryFormat: 'written', body: ${JSON.stringify(text)}`;
    const chars = (n: number) => 'a'.repeat(n);

    it('stores at most 10,000 characters', async () => {
      await created(body(chars(10_000)));
      await refused(body(chars(10_001)), 'body');
      // Edits are held to the same limit.
      const id = await created(body('Short'));
      expect(await update(id, `body = '${chars(10_001)}'`)).toEqual({
        ok: false,
        error: expect.stringContaining('body'),
      });
    });

    it('saves a short draft, but submits a written story only from 200 characters (trimmed)', async () => {
      const short = await created(body(`  \n${chars(199)} \n `));
      expect(await update(short, `status = 'pending'`)).toEqual({
        ok: false,
        error: expect.stringContaining(
          'a written story needs at least 200 characters before it is submitted',
        ),
      });
      expect(
        await truth(
          `SELECT VALUE status FROM ONLY type::record('story', $short)`,
          {
            short,
          },
        ),
      ).toEqual(['draft']);

      const enough = await created(body(`  ${chars(200)}  `));
      expect(await submit(pat, enough)).toHaveLength(1);
    });

    // One whitespace policy (fn::text::trimmed_length): what JavaScript's trim() strips, which the
    // web uses, plus what string::trim strips. 3.2.4's string::trim keeps U+FEFF (Codex, #58).
    const SUBMIT_REFUSED = 'a written story needs at least 200 characters';
    it.each([
      ['199 characters and a U+FEFF', `${chars(199)}\uFEFF`],
      ['199 characters between U+FEFFs', `\uFEFF${chars(199)}\uFEFF\uFEFF`],
      ['199 characters padded with NBSP', `\u00A0${chars(199)}\u00A0`],
      [
        '199 characters padded with other Unicode spaces',
        `\u3000\u2003${chars(199)}\u2028\u2029\u0085`,
      ],
    ])('refuses to submit %s', async (_name, text) => {
      const id = await created(body(text));
      expect(await update(id, `status = 'pending'`)).toEqual({
        ok: false,
        error: expect.stringContaining(SUBMIT_REFUSED),
      });
    });

    it.each([
      ['only U+FEFF', '\uFEFF\uFEFF\uFEFF'],
      ['only NBSP and U+FEFF', '\u00A0\uFEFF \u3000'],
    ])(
      'refuses a written story of %s, even as a draft',
      async (_name, text) => {
        await refused(body(text), 'a written story needs its text');
      },
    );

    it('submits 200 real characters with invisible padding around them', async () => {
      const id = await created(
        body(`\uFEFF\u00A0 \n${chars(200)}\u3000\uFEFF\u2028`),
      );
      expect(await submit(pat, id)).toHaveLength(1);
    });

    it('needs no minimum for a video or audio story’s text', async () => {
      const id = await created(
        `primaryFormat: 'audio', body: 'A few words', media: [${AUDIO}]`,
      );
      expect(await submit(pat, id)).toHaveLength(1);
    });

    it('refuses a system user’s short written story from submit on, too', async () => {
      expect(
        await outcome(
          migrator,
          `CREATE story CONTENT { submitter: user:pat, slug: 'mig-short', title: 't', description: 'd',
             primaryFormat: 'written', body: 'Too short', status: 'pending' }`,
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('at least 200 characters'),
      });
    });
  });

  describe.each([
    ['video', VIDEO, AUDIO],
    ['audio', AUDIO, VIDEO],
  ])('%s', (format, own, other) => {
    it.each([
      ['a draft before its upload', ``],
      ['its one media item', `media: [${own}]`],
      ['its one media item and text', `media: [${own}], body: 'What happened'`],
    ])('allows %s', async (_name, fields) => {
      await created(`primaryFormat: '${format}', ${fields}`);
    });

    it.each([
      ['two media items', `media: [${own}, ${own}]`, 'exactly one'],
      [
        'the other format',
        `media: [${other}]`,
        `a ${format} story’s media must be ${format}`,
      ],
      [
        'an image',
        `media: [${own}], image: ${IMAGE}`,
        'only a written story can have an image',
      ],
    ])('refuses %s', async (_name, fields, message) => {
      await refused(`primaryFormat: '${format}', ${fields}`, message);
    });

    it('can be submitted only with its media, and withdrawn without it', async () => {
      const id = await created(`primaryFormat: '${format}'`);
      expect(await update(id, `status = 'pending'`)).toEqual({
        ok: false,
        error: expect.stringContaining(`a ${format} story needs its ${format}`),
      });
      expect(await update(id, `media = [${own}]`)).toMatchObject({ ok: true });
      expect(await submit(pat, id)).toHaveLength(1);

      const empty = await created(`primaryFormat: '${format}'`);
      expect(await update(empty, `status = 'withdrawn'`)).toMatchObject({
        ok: true,
      });
    });
  });

  describe('media shape', () => {
    it.each([
      ['portrait 9:16', 1080, 1920],
      ['a tall phone clip 9:19.5', 1080, 2340],
      ['landscape 16:9', 1920, 1080],
      ['wide 2.4:1', 2400, 1000],
      ['square', 1080, 1080],
      ['exactly 1:3', 600, 1800],
    ])('allows %s', async (_name, width, height) => {
      await created(
        `primaryFormat: 'video', media: [{ format: 'video', width: ${width}, height: ${height} }]`,
      );
    });

    it.each([
      ['beyond 1:3', `width: 600, height: 1801`, 'beyond 1:3 or 3:1'],
      ['beyond 3:1', `width: 1801, height: 600`, 'beyond 1:3 or 3:1'],
      ['a width without a height', `width: 600`, 'both width and height'],
      ['a negative height', `width: 600, height: -600`, 'media.*.height'],
      [
        'an aspect-ratio label (D53: replaced)',
        `aspectRatio: '9:16'`,
        'a field the schema doesn’t define',
      ],
      [
        'free text',
        `note: 'testimony text'`,
        'a field the schema doesn’t define',
      ],
    ])('refuses %s', async (_name, fields, message) => {
      await refused(
        `primaryFormat: 'video', media: [{ format: 'video', ${fields} }]`,
        message,
      );
    });

    it('keeps an audio file’s thumbnail size, within 1:3 to 3:1 (Joel, 2026-10-24)', async () => {
      expect(
        await created(
          `primaryFormat: 'audio', media: [{ format: 'audio', bunnyVideoId: 'a',
             thumbnailPath: 'a/thumbnail_0a1b2c3d.jpg', width: 1280, height: 720 }]`,
        ),
      ).toBeTruthy();
      await refused(
        `primaryFormat: 'audio', media: [{ format: 'audio', width: 100, height: 400 }]`,
        'shape is beyond 1:3 or 3:1',
      );
    });

    it('lets workflow store the encode result (width and height) on a video', async () => {
      const id = await created(
        `primaryFormat: 'video', media: [{ format: 'video', bunnyVideoId: 'v' }]`,
      );
      expect(
        await update(
          id,
          `media[0].width = 1920, media[0].height = 1080`,
          workflow,
        ),
      ).toMatchObject({ ok: true });
      expect(
        await truth(`SELECT VALUE media FROM ONLY type::record('story', $id)`, {
          id,
        }),
      ).toEqual([
        { format: 'video', bunnyVideoId: 'v', width: 1920, height: 1080 },
      ]);
      expect(
        await update(
          id,
          `media[0].width = 4000, media[0].height = 1000`,
          workflow,
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('beyond 1:3 or 3:1'),
      });
    });
  });

  describe('changing type', () => {
    it('allows written → video while a draft, once the text-only parts fit', async () => {
      const id = await created(
        `primaryFormat: 'written', body: 'x', image: ${IMAGE}`,
      );
      expect(await update(id, `primaryFormat = 'video'`)).toEqual({
        ok: false,
        error: expect.stringContaining(
          'only a written story can have an image',
        ),
      });
      expect(
        await update(
          id,
          `primaryFormat = 'video', image = NONE, media = [${VIDEO}]`,
        ),
      ).toMatchObject({ ok: true });
    });
  });

  describe('the image is the person’s own content (D41)', () => {
    let id: string;
    beforeAll(async () => {
      id = await created(
        `primaryFormat: 'written', body: 'x', image: ${IMAGE}`,
      );
    });
    const image = async () =>
      (
        await truth(`SELECT VALUE image FROM ONLY type::record('story', $id)`, {
          id,
        })
      )[0];

    it.each([
      ['api_admin', () => admin],
      ['workflow', () => workflow],
    ])('%s writes to it are dropped', async (_name, db) => {
      const before = await image();
      for (const set of [
        `image = NONE`,
        `image = { path: 'other.webp', width: 10, height: 10 }`,
        `image.alt = 'Words the person never wrote'`,
        `image.path = 'someone-elses.webp'`,
      ]) {
        await update(id, set, db());
      }
      expect(await image()).toEqual(before);
    });

    it('the person changes it on a draft, which needs current Art 9 consent', async () => {
      expect(
        await update(id, `image.alt = 'Sunrise over the hills'`),
      ).toMatchObject({ ok: true });
      expect(await image()).toMatchObject({ alt: 'Sunrise over the hills' });

      await createPeople(t, { quinn: 'user_quinn' });
      const quinn = await t.person('user_quinn');
      await grantAll(quinn);
      const { id: q } = await create(
        `primaryFormat: 'written', body: 'x'`,
        quinn,
      );
      await consentEvent(quinn, 'special_category_religious', 'withdrawn');
      expect(await update(q, `image = ${IMAGE}`, quinn)).toEqual({
        ok: false,
        error: expect.stringContaining('current Art 9 consent'),
      });
    });

    it('is locked with the rest of the content after submit', async () => {
      const s = await created(
        `primaryFormat: 'written', ${TEXT}, image: ${IMAGE}`,
      );
      expect(await submit(pat, s)).toHaveLength(1);
      expect(await update(s, `image.alt = 'Changed after submit'`)).toEqual({
        ok: false,
        error: expect.stringContaining('locked after submission'),
      });
    });
  });

  describe('publicStory mirrors the image and media shapes', () => {
    it('publishes a written story with its image, and a video with its size', async () => {
      const w = await created(
        `primaryFormat: 'written', ${TEXT}, image: ${IMAGE}`,
      );
      const v = await created(`primaryFormat: 'video', media: [${VIDEO}]`);
      for (const id of [w, v]) {
        await submit(pat, id);
        await processed(workflow, id);
        await approve(admin, id);
      }
      const reader = await t.service('api_public_read');
      expect(
        await rows(
          reader,
          `SELECT VALUE image FROM ONLY type::record('publicStory', $w)`,
          { w },
        ),
      ).toEqual([
        { path: 'images/a.webp', width: 1200, height: 1600, alt: 'A sunrise' },
      ]);
      expect(
        await rows(
          reader,
          `SELECT VALUE media FROM ONLY type::record('publicStory', $v)`,
          { v },
        ),
      ).toEqual([
        { format: 'video', bunnyVideoId: 'vid', width: 1080, height: 1920 },
      ]);
    });

    it.each([
      ['a different image', `image.alt = 'Words the person never wrote'`],
      ['no image', `image = NONE`],
      ['a different video size', `media[0].width = 1920`],
      ['an extra media field', `media[0].note = 'free text'`],
    ])('refuses a read model with %s', async (_name, set) => {
      const w = await created(
        `primaryFormat: 'written', ${TEXT}, image: ${IMAGE}`,
      );
      const v = await created(`primaryFormat: 'video', media: [${VIDEO}]`);
      for (const id of [w, v]) {
        await submit(pat, id);
        await processed(workflow, id);
        await approve(admin, id);
      }
      const target = set.startsWith('media') ? v : w;
      const before = await truth(
        `SELECT * FROM type::record('publicStory', $target)`,
        {
          target,
        },
      );
      const result = await outcome(
        admin,
        `UPDATE type::record('publicStory', $target) SET ${set}`,
        { target },
      );
      expect(result).toEqual({ ok: false, error: expect.any(String) });
      expect(
        await truth(`SELECT * FROM type::record('publicStory', $target)`, {
          target,
        }),
      ).toEqual(before);
    });

    it('approval refuses a video submitted without its media (set by a system user)', async () => {
      const id = await created(`primaryFormat: 'video', media: [${VIDEO}]`);
      await submit(pat, id);
      expect(
        await outcome(
          migrator,
          `UPDATE type::record('story', $id) SET media = []`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('a video story needs its video'),
      });
    });
  });

  it('applies the same rules to system users (the migrator) as to everyone', async () => {
    expect(
      await outcome(
        migrator,
        `CREATE story CONTENT { submitter: user:pat, slug: 'mig', title: 't', description: 'd',
           primaryFormat: 'written', body: 'x', media: [${VIDEO}] }`,
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('a written story has no video or audio'),
    });
    await run(migrator, 'RETURN true');
  });
});

/**
 * data/0004: a DEFINE doesn't re-check rows written before it, and REMOVE FIELD leaves stored
 * values, so the script fails the migration (nothing rewritten) while a story written earlier
 * breaks D53 or a read-model row still carries `aspectRatio`. Earlier rows are simulated by
 * removing the guard events for a moment, as only the OWNER migrator can.
 */
describe('data/0004: rows written before D53', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let bundle: string;

  beforeAll(async () => {
    t = await TestDatabase.create({ migrate: false });
    bundle = await mkdtemp(join(tmpdir(), 'bundle-before-0004-'));
    await cp(SCHEMA_DIR, bundle, { recursive: true });
    await rm(join(bundle, 'data', '0004-check-story-shapes.surql'));
    await t.migrate(undefined, { bundleDir: bundle });
    await t.createServices();
    await createPeople(t, { old: 'user_old' });
    await publishDpa(t, 'v1');
    await grantAll(await t.person('user_old'));
    migrator = await t.migrator();
  });
  afterAll(async () => {
    await rm(bundle, { recursive: true, force: true });
    await t?.close();
  });

  const applied = () =>
    rows(migrator, 'SELECT VALUE record::id(id) FROM _migration ORDER BY id');

  it('fails while an earlier story or read-model row doesn’t fit, and passes once fixed', async () => {
    await run(
      migrator,
      `REMOVE EVENT story_shape ON story;
       REMOVE EVENT publicStory_mirrors_story ON publicStory;
       CREATE story:old_written CONTENT { submitter: user:old, slug: 'old-written', title: 't',
         description: 'd', primaryFormat: 'written', body: 'x',
         media: [{ format: 'video', aspectRatio: '9:16' }] };
       CREATE story:old_video CONTENT { submitter: user:old, slug: 'old-video', title: 't',
         description: 'd', primaryFormat: 'video', status: 'approved',
         media: [{ format: 'video', width: 1920, height: 1080, durationSeconds: 30, processing: 'ready' }] };
       CREATE publicStory:old_video CONTENT { version: 1, slug: 'old-video', title: 't',
         description: 'd', primaryFormat: 'video', tagRefs: [], publishedAt: time::now(),
         media: [{ format: 'video', aspectRatio: '16:9' }] };`,
    );

    const first = await t.runMigration();
    expect(first.exitCode).toBe(1);
    expect(first.output).toContain('these stories don’t fit');
    expect(first.output).toContain('story:old_written');
    expect(first.output).not.toContain('story:old_video');
    expect(await applied()).not.toContain('0004-check-story-shapes');

    await run(migrator, 'DELETE story:old_written');
    const second = await t.runMigration();
    expect(second.exitCode).toBe(1);
    expect(second.output).toContain(
      'still carry aspectRatio: [publicStory:old_video]',
    );

    // The re-sync api-admin will do: the read model mirrors the story again.
    await run(
      await t.service('api_admin'),
      `UPDATE publicStory:old_video SET media = [{ format: 'video', width: 1920, height: 1080 }]`,
    );
    await t.migrate();
    expect(await applied()).toContain('0004-check-story-shapes');
  });
});

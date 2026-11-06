import { RecordId, type Surreal, type SurrealQueryable } from 'surrealdb';
import {
  createPeople,
  trustSubmitters,
  agreeAll,
  outcome,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { approve, processed, submit } from './support/world';

/**
 * D53: a story is exactly one of three types, each with one main part and one optional part,
 * enforced by the database (event `story_shape`, one definition in `fn::story::shape_problem`):
 *   written → text (body, not blank), no video or audio; optional picture
 *   video   → one video file, optional text; an optional picture (its own thumbnail)
 *   audio   → one audio file, optional text; an optional picture (M2 plan PR 10)
 * R12: the files are storyFile rows the story points at (mediaFile, image.file). A draft is
 * created before its upload (CreateDraftStory), so a video or audio story may have no file while
 * it's editable (draft, changes_requested); from submit on (pending, in_review, approved) it needs
 * it. A file's shape is its real pixel size (positive ints, both or neither), refused beyond 1:3
 * or 3:1, on its row (storyFile_shape); the rows accept only the defined fields, so the removed
 * `aspectRatio` (or any free text) can't be stored. The picture is the person's content (D41):
 * api-admin and workflow writes to it are dropped; its file comes only through an upload (D80,
 * images.int-spec.ts), and the person may change its description or remove it.
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

  /** A file row's fields (SurrealQL object entries); `format` says which kind. */
  type Files = { media?: string; image?: string; alt?: string };
  const VIDEO = `format: 'video', width: 1080, height: 1920`;
  const AUDIO = `format: 'audio', lengthSeconds: 60`;
  const IMAGE = `width: 1200, height: 1600`;
  /** A written story's text, long enough to submit (200 characters). */
  const TEXT = `body: '${'Words of the story. '.repeat(11)}'`;

  /**
   * Pat creates a story with these extra fields (SurrealQL object entries); returns its id. With
   * files, a system user writes their rows and creates the story for Pat: a person's session
   * never writes the file pointers (D80), and the shape rules are the same for every writer.
   */
  const create = async (
    fields: string,
    files: Files = {},
    person?: SurrealQueryable,
  ) => {
    seq += 1;
    const id = `shape_${seq}`;
    const withFiles = files.media !== undefined || files.image !== undefined;
    const writer = person ?? (withFiles ? migrator : pat);
    const result = await outcome(
      writer,
      `BEGIN TRANSACTION;
       ${
         files.media !== undefined
           ? `CREATE type::record('storyFile', $id + '-media') CONTENT {
         story: type::record('story', $id), person: user:pat, contentType: 'video/mp4',
         sizeBytes: 1000, storyVersion: 1, ${files.media} } RETURN NONE;`
           : ''
       }
       ${
         files.image !== undefined
           ? `CREATE type::record('storyFile', $pic) CONTENT {
         story: type::record('story', $id), person: user:pat, format: 'image',
         contentType: 'image/webp', sizeBytes: 1000, storyVersion: 1, ${files.image} } RETURN NONE;`
           : ''
       }
       CREATE type::record('story', $id) CONTENT {
         themeRefs: [theme:common], submitter: $submitter ?? $auth, slug: $id, title: 'A story', description: 'How I came to faith',
         ${files.media !== undefined ? `mediaFile: type::record('storyFile', $id + '-media'),` : ''}
         ${files.image !== undefined ? `image: { file: type::record('storyFile', $pic), alt: $alt },` : ''}
         ${fields}
       } RETURN VALUE id;
       COMMIT TRANSACTION;`,
      {
        id,
        pic: `dev-seed/pic-${seq}.webp`,
        alt: files.alt,
        submitter:
          writer === migrator ? new RecordId('user', 'pat') : undefined,
      },
    );
    return {
      id,
      result:
        result.ok && Array.isArray(result.result)
          ? { ok: true, result: result.result }
          : result,
    };
  };
  const created = async (fields: string, files: Files = {}) => {
    const { id, result } = await create(fields, files);
    expect(result).toMatchObject({ ok: true });
    return id;
  };
  const refused = async (
    fields: string,
    message: string,
    files: Files = {},
  ) => {
    const { id, result } = await create(fields, files);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(message),
    });
    expect(
      await truth(`SELECT * FROM type::record('story', $id)`, { id }),
    ).toEqual([]);
  };
  /** Pat adds a status entry (R6): a submit (pending) or a withdrawal. */
  const toStatus = (id: string, status: string, db: SurrealQueryable = pat) =>
    outcome(
      db,
      `CREATE storyStatusLog CONTENT { story: type::record('story', $id), status: $status }`,
      { id, status },
    );
  const update = (id: string, set: string, db: SurrealQueryable = pat) =>
    outcome(db, `UPDATE type::record('story', $id) SET ${set}`, { id });

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await trustSubmitters(t, 'pat');
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  afterAll(() => t?.close());

  describe('written', () => {
    it.each([
      ['text only', `primaryFormat: 'written', body: 'My story'`, {}],
      [
        'text and a picture',
        `primaryFormat: 'written', body: 'My story'`,
        { image: IMAGE, alt: 'A sunrise' },
      ],
      [
        'a picture without alt text (readers use a neutral default)',
        `primaryFormat: 'written', body: 'My story'`,
        { image: `width: 800, height: 800` },
      ],
      [
        'a picture at exactly 1:3',
        `primaryFormat: 'written', body: 'x'`,
        { image: `width: 500, height: 1500` },
      ],
      [
        'a picture at exactly 3:1',
        `primaryFormat: 'written', body: 'x'`,
        { image: `width: 1500, height: 500` },
      ],
    ])('allows %s', async (_name, fields, files: Files) => {
      await created(fields, files);
    });

    it.each([
      [
        'no text',
        `primaryFormat: 'written'`,
        'a written story needs its text',
        {},
      ],
      [
        'blank text',
        `primaryFormat: 'written', body: ' \n\t '`,
        'a written story needs its text',
        {},
      ],
      [
        'a video',
        `primaryFormat: 'written', body: 'x'`,
        'a written story has no video or audio',
        { media: VIDEO },
      ],
      [
        'an audio file',
        `primaryFormat: 'written', body: 'x'`,
        'a written story has no video or audio',
        { media: AUDIO },
      ],
      [
        'a picture taller than 1:3',
        `primaryFormat: 'written', body: 'x'`,
        'beyond 1:3 or 3:1',
        { image: `width: 500, height: 1501` },
      ],
      [
        'a picture wider than 3:1',
        `primaryFormat: 'written', body: 'x'`,
        'beyond 1:3 or 3:1',
        { image: `width: 1501, height: 500` },
      ],
      [
        'a picture of zero width',
        `primaryFormat: 'written', body: 'x'`,
        'width',
        { image: `width: 0, height: 500` },
      ],
      [
        'a picture without a height',
        `primaryFormat: 'written', body: 'x'`,
        'both width and height',
        { image: `width: 500` },
      ],
      [
        'a picture with an aspect-ratio label',
        `primaryFormat: 'written', body: 'x'`,
        'aspectRatio',
        { image: `width: 5, height: 5, aspectRatio: '1:1'` },
      ],
      [
        'a video file as its picture',
        `primaryFormat: 'written', body: 'x', image: { file: storyFile:⟨vid-as-picture⟩ }`,
        'picture must be an image file',
        {},
      ],
    ])('refuses %s', async (_name, fields, message, files: Files) => {
      if (fields.includes('vid-as-picture')) {
        await run(
          migrator,
          `UPSERT storyFile:⟨vid-as-picture⟩ CONTENT { story: story:nobody, person: user:pat,
             format: 'video', contentType: 'video/mp4', sizeBytes: 1, storyVersion: 1 }`,
        );
        const { result } = await create(fields, files, migrator);
        expect(result).toEqual({
          ok: false,
          error: expect.stringContaining(message),
        });
        return;
      }
      await refused(fields, message, files);
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
      expect(await toStatus(short, 'pending')).toEqual({
        ok: false,
        error: expect.stringContaining(
          'a written story needs at least 200 characters before it is submitted',
        ),
      });
      expect(
        await truth(
          `SELECT VALUE fn::story::status_of($this) FROM ONLY type::record('story', $short)`,
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
      expect(await toStatus(id, 'pending')).toEqual({
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
      const id = await created(`primaryFormat: 'audio', body: 'A few words'`, {
        media: AUDIO,
      });
      expect(await submit(pat, id)).toHaveLength(1);
    });

    it('refuses a system user’s short written story from submit on, too', async () => {
      await run(
        migrator,
        `CREATE story:mig_short CONTENT { themeRefs: [theme:common], submitter: user:pat, slug: 'mig-short', title: 't', description: 'd',
           primaryFormat: 'written', body: 'Too short' }`,
      );
      expect(
        await outcome(
          migrator,
          `CREATE storyStatusLog CONTENT { story: story:mig_short, status: 'pending', actor: 'person' }`,
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('at least 200 characters'),
      });
    });
  });

  it('every type may have a picture: a written story’s, an audio story’s picture, a video’s own thumbnail (M2 plan PR 10)', async () => {
    await created(`primaryFormat: 'video'`, { media: VIDEO, image: IMAGE });
    await created(`primaryFormat: 'audio'`, { media: AUDIO, image: IMAGE });
  });

  describe.each([
    ['video', VIDEO, AUDIO],
    ['audio', AUDIO, VIDEO],
  ])('%s', (format, own, other) => {
    it.each([
      ['a draft before its upload', ``, {}],
      ['its file', ``, { media: own }],
      ['its file and text', `body: 'What happened'`, { media: own }],
    ])('allows %s', async (_name, fields, files: Files) => {
      await created(`primaryFormat: '${format}', ${fields}`, files);
    });

    it('refuses the other format', async () => {
      await refused(
        `primaryFormat: '${format}'`,
        `a ${format} story’s media must be ${format}`,
        { media: other },
      );
    });

    it('can be submitted only with its file, and withdrawn without it', async () => {
      const id = await created(`primaryFormat: '${format}'`);
      expect(await toStatus(id, 'pending')).toEqual({
        ok: false,
        error: expect.stringContaining(`a ${format} story needs its ${format}`),
      });
      // The upload (D80: never the person's own write).
      expect(
        await outcome(
          migrator,
          `CREATE type::record('storyFile', $id + '-later') CONTENT {
             story: type::record('story', $id), person: user:pat, contentType: 'video/mp4',
             sizeBytes: 1000, storyVersion: 1, ${own} };
           UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $id + '-later')`,
          { id },
        ),
      ).toMatchObject({ ok: true });
      expect(await submit(pat, id)).toHaveLength(1);

      const empty = await created(`primaryFormat: '${format}'`);
      expect(await toStatus(empty, 'withdrawn')).toMatchObject({
        ok: true,
      });
    });
  });

  describe('a file’s shape (on its row)', () => {
    it.each([
      ['portrait 9:16', 1080, 1920],
      ['a tall phone clip 9:19.5', 1080, 2340],
      ['landscape 16:9', 1920, 1080],
      ['wide 2.4:1', 2400, 1000],
      ['square', 1080, 1080],
      ['exactly 1:3', 600, 1800],
    ])('allows %s', async (_name, width, height) => {
      await created(`primaryFormat: 'video'`, {
        media: `format: 'video', width: ${width}, height: ${height}`,
      });
    });

    it.each([
      ['beyond 1:3', `width: 600, height: 1801`, 'beyond 1:3 or 3:1'],
      ['beyond 3:1', `width: 1801, height: 600`, 'beyond 1:3 or 3:1'],
      ['a width without a height', `width: 600`, 'both width and height'],
      ['a negative height', `width: 600, height: -600`, 'height'],
      [
        'an aspect-ratio label (D53: replaced)',
        `aspectRatio: '9:16'`,
        'aspectRatio',
      ],
      ['free text', `note: 'testimony text'`, 'note'],
    ])('refuses %s', async (_name, fields, message) => {
      await refused(`primaryFormat: 'video'`, message, {
        media: `format: 'video', ${fields}`,
      });
    });

    it('keeps an audio file’s thumbnail size, within 1:3 to 3:1 (Joel, 2026-10-24)', async () => {
      await created(`primaryFormat: 'audio'`, {
        media: `format: 'audio', width: 1280, height: 720`,
      });
      await refused(`primaryFormat: 'audio'`, 'shape is beyond 1:3 or 3:1', {
        media: `format: 'audio', width: 100, height: 400`,
      });
    });

    it('lets workflow store the encode result (width and height) on a video', async () => {
      const id = await created(`primaryFormat: 'video'`, {
        media: `format: 'video'`,
      });
      const file = `${id}-media`;
      const set = (s: string) =>
        outcome(workflow, `UPDATE type::record('storyFile', $file) SET ${s}`, {
          file,
        });
      expect(await set(`width = 1920, height = 1080`)).toMatchObject({
        ok: true,
      });
      expect(
        await truth(
          `SELECT width, height FROM ONLY type::record('storyFile', $file)`,
          { file },
        ),
      ).toEqual([{ width: 1920, height: 1080 }]);
      expect(await set(`width = 4000, height = 1000`)).toEqual({
        ok: false,
        error: expect.stringContaining('beyond 1:3 or 3:1'),
      });
    });
  });

  describe('changing type', () => {
    it('allows written → video while a draft; the picture stays, as its thumbnail', async () => {
      const id = await created(`primaryFormat: 'written', body: 'x'`, {
        image: IMAGE,
      });
      expect(await update(id, `primaryFormat = 'video'`)).toMatchObject({
        ok: true,
      });
    });
  });

  describe('the picture is the person’s own content (D41)', () => {
    let id: string;
    beforeAll(async () => {
      id = await created(`primaryFormat: 'written', body: 'x'`, {
        image: IMAGE,
        alt: 'A sunrise',
      });
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
        `image = { file: storyFile:⟨dev-seed/other.webp⟩ }`,
        `image.alt = 'Words the person never wrote'`,
        `image.file = storyFile:⟨dev-seed/someone-elses.webp⟩`,
      ]) {
        await update(id, set, db());
      }
      expect(await image()).toEqual(before);
    });

    it('the person changes its description on a draft, never its file', async () => {
      expect(
        await update(id, `image.alt = 'Sunrise over the hills'`),
      ).toMatchObject({ ok: true });
      await update(id, `image.file = storyFile:⟨dev-seed/someone-elses.webp⟩`);
      expect(await image()).toEqual({
        file: `storyFile:⟨dev-seed/pic-${id.split('_')[1]}.webp⟩`,
        alt: 'Sunrise over the hills',
      });
    });

    it('is locked with the rest of the content after submit', async () => {
      const s = await created(`primaryFormat: 'written', ${TEXT}`, {
        image: IMAGE,
      });
      expect(await submit(pat, s)).toHaveLength(1);
      expect(await update(s, `image.alt = 'Changed after submit'`)).toEqual({
        ok: false,
        error: expect.stringContaining('locked after submission'),
      });
    });
  });

  describe('everyone reads a published story’s picture and video through its pointers (R11, R12)', () => {
    it('publishes a written story with its picture, and a video with its size', async () => {
      const w = await created(`primaryFormat: 'written', ${TEXT}`, {
        image: IMAGE,
        alt: 'A sunrise',
      });
      const v = await created(`primaryFormat: 'video'`, { media: VIDEO });
      for (const id of [w, v]) {
        await submit(pat, id);
        await processed(workflow, id);
        await approve(admin, id);
      }
      const reader = await t.service('api_public_read');
      expect(
        await rows(
          reader,
          `SELECT record::id(image.file) AS path, image.file.width AS width,
             image.file.height AS height, image.alt AS alt
           FROM ONLY type::record('story', $w)`,
          { w },
        ),
      ).toEqual([
        {
          path: `dev-seed/pic-${w.split('_')[1]}.webp`,
          width: 1200,
          height: 1600,
          alt: 'A sunrise',
        },
      ]);
      expect(
        await rows(
          reader,
          `SELECT VALUE mediaFile.* FROM ONLY type::record('story', $v)`,
          { v },
        ),
      ).toEqual([
        {
          id: `storyFile:⟨${v}-media⟩`,
          format: 'video',
          width: 1080,
          height: 1920,
          lengthSeconds: 60,
        },
      ]);
    });

    it('a system user can’t take a submitted video’s file away', async () => {
      const id = await created(`primaryFormat: 'video'`, { media: VIDEO });
      await submit(pat, id);
      expect(
        await outcome(
          migrator,
          `UPDATE type::record('story', $id) SET mediaFile = NONE`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('a video story needs its video'),
      });
    });
  });

  it('applies the same rules to system users (the migrator) as to everyone', async () => {
    const { result } = await create(
      `primaryFormat: 'written', body: 'x'`,
      { media: VIDEO },
      migrator,
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('a written story has no video or audio'),
    });
  });
});

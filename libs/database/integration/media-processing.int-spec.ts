import { THUMBNAIL_PATH_CASES } from '@heisreal/contracts/media-paths';
import type { Surreal, SurrealQueryable } from 'surrealdb';
import {
  createPeople,
  trustSubmitters,
  agreeAll,
  outcome,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import {
  answered,
  approve,
  ERASE,
  processed,
  step,
  submit,
  edit,
} from './support/world';

/**
 * A2 (Joel, 2026-10-23): "approval should be blocked until size and processing is completed".
 * R12: a story's files are storyFile rows it points at (mediaFile, image.file), and each row
 * carries `processing` (NONE = not processed yet, then 'processing', 'ready' or 'failed') and the
 * facts processing found. Only workflow (M7) and system users set them: the person and api-admin
 * can't write a file row at all. A new upload is a new row, so it starts unprocessed. The
 * database refuses an approved status entry (R6), whoever adds it, unless every file is 'ready'
 * with its facts: a video its width, height and length, an audio file its length and its
 * thumbnail with that picture's width and height (Joel, 2026-10-24), the picture 'ready'.
 * An approved story is hidden while a file isn't ready, and comes back by itself only with the
 * files its approval recorded (reviewedMediaFile, reviewedImageFile; db review 2, section 6
 * item 1).
 */
describe('approval waits for media processing (A2, R12)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let pat: Surreal;
  let seq = 0;

  const TEXT = `${'Words of the story. '.repeat(11)}`;

  const truth = <T = Record<string, unknown>>(
    sql: string,
    vars?: Record<string, unknown>,
  ) => rows<T>(migrator, sql, vars);
  const statusOf = async (id: string) =>
    (
      await truth<string>(
        `SELECT VALUE fn::story::status_of($this) FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  /** The story's current entry, as the database recorded it. */
  const current = async (id: string) =>
    (
      await truth(
        `SELECT VALUE currentStatus.{ status, actor, hiddenReason, publishedAt,
           reviewedMediaFile, reviewedImageFile }
         FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  /** What the public login sees of the story: its id while it is public (R11). */
  const published = async (id: string) =>
    rows(
      await t.service('api_public_read'),
      `SELECT VALUE id FROM type::record('story', $id)`,
      { id },
    );
  const version = async (id: string) =>
    (
      await truth<number>(
        `SELECT VALUE version FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];

  /**
   * A system user uploads a file for story `id`, as storyFile_attach would (these tests are about
   * processing, not uploads: uploads.int-spec.ts, images.int-spec.ts): a new row, and the story
   * points at it. Answers the row's key. Uploaded a day ago, so its upload link has run out and
   * the moderator's wait for it is over (approval-wait.int-spec.ts).
   */
  const upload = async (
    id: string,
    format: 'video' | 'audio' | 'image',
    db: SurrealQueryable = migrator,
    named?: string,
  ) => {
    seq += 1;
    const key =
      named ??
      (format === 'image'
        ? `stories/${id}/${String(seq).padStart(32, '0')}.webp`
        : `vid${seq}`);
    await run(
      db,
      `CREATE type::record('storyFile', $key) CONTENT {
         story: type::record('story', $id), person: user:pat, format: $format,
         contentType: 'x/y', sizeBytes: 1000, storyVersion: 1, at: time::now() - 1d,
         width: IF $format = 'image' { 1200 }, height: IF $format = 'image' { 1600 } };
       UPDATE type::record('story', $id) SET ${format === 'image' ? `image = { file: type::record('storyFile', $key), alt: 'A sunrise' }` : `mediaFile = type::record('storyFile', $key)`};`,
      { id, key, format },
    );
    return key;
  };
  const create = async (
    fields: string,
    files: ('video' | 'audio' | 'image')[],
  ) => {
    seq += 1;
    const id = `proc_${seq}`;
    const result = await outcome(
      pat,
      `CREATE type::record('story', $id) CONTENT {
         themeRefs: [theme:common], submitter: $auth, slug: $id, title: 'A story', description: 'How I came to faith',
         ${fields}
       } RETURN VALUE id`,
      { id },
    );
    expect(result).toEqual({ ok: true, result: [`story:${id}`] });
    for (const f of files) await upload(id, f);
    return id;
  };
  const video = () => create(`primaryFormat: 'video'`, ['video']);
  const audio = () => create(`primaryFormat: 'audio'`, ['audio']);
  const written = () =>
    create(`primaryFormat: 'written', body: '${TEXT}'`, ['image']);
  /** The key of the story's video/audio file (`media`) or picture (`image`). */
  const fileOf = async (id: string, which: 'media' | 'image' = 'media') =>
    (
      await truth<string>(
        `SELECT VALUE record::id(${which === 'media' ? 'mediaFile' : 'image.file'})
         FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  /** A write to the story's file row (workflow's, by default). */
  const setFile = async (
    id: string,
    set: string,
    db: SurrealQueryable = workflow,
    which: 'media' | 'image' = 'media',
  ) =>
    outcome(db, `UPDATE type::record('storyFile', $key) SET ${set}`, {
      key: await fileOf(id, which),
    });
  const fileRow = async (id: string, which: 'media' | 'image' = 'media') =>
    (
      await truth(
        `SELECT * OMIT id, story, person, at FROM ONLY type::record('storyFile', $key)`,
        { key: await fileOf(id, which) },
      )
    )[0];

  /** The approval must be refused with this message, leaving nothing approved or published. */
  const refusedApproval = async (id: string, message: string) => {
    expect(
      await outcome(
        admin,
        `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'approved',
           by: user:moderator }`,
        { id },
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining(`media_not_ready: ${message}`),
    });
    expect(await statusOf(id)).toBe('pending');
    expect(await published(id)).toEqual([]);
  };

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

  describe('who sets processing', () => {
    it('neither the person nor api-admin can write a file row', async () => {
      const v = await video();
      const w = await written();
      for (const db of [pat, admin]) {
        await setFile(v, `processing = 'ready', lengthSeconds = 30`, db);
        await setFile(w, `processing = 'ready'`, db, 'image');
      }
      expect((await fileRow(v))?.['processing']).toBeUndefined();
      expect((await fileRow(w, 'image'))?.['processing']).toBeUndefined();
    });

    it('workflow can, and a picture’s size stays the person’s', async () => {
      const w = await written();
      expect(
        await setFile(
          w,
          `processing = 'ready', width = 10, height = 10`,
          workflow,
          'image',
        ),
      ).toMatchObject({ ok: true });
      expect(await fileRow(w, 'image')).toMatchObject({
        processing: 'ready',
        width: 1200,
        height: 1600,
      });
    });

    it('api-user marks only the picture a draft shows now as checked, at submit (Joel, 2026-10-30, R3 = A), and approval counts it', async () => {
      const apiUser = await t.service('api_user');
      const w = await written();
      const before = await version(w);
      // Never anything but 'ready', and never a video's row.
      for (const state of ['processing', 'failed']) {
        expect(
          await setFile(w, `processing = '${state}'`, apiUser, 'image'),
        ).toEqual({
          ok: false,
          error: expect.stringContaining('picture_check:'),
        });
      }
      const v = await video();
      await setFile(v, `processing = 'ready'`, apiUser);
      expect((await fileRow(v))?.['processing']).toBeUndefined();
      // The check at submit: marked, and the version the person's page sent still holds.
      expect(
        await setFile(w, `processing = 'ready'`, apiUser, 'image'),
      ).toMatchObject({ ok: true });
      expect((await fileRow(w, 'image'))?.['processing']).toBe('ready');
      expect(await version(w)).toBe(before);
      // Once marked, never again (nor back), and not a picture the story stopped showing.
      expect(
        await setFile(w, `processing = NONE`, apiUser, 'image'),
      ).toMatchObject({ ok: false });
      const old = await upload(w, 'image');
      await upload(w, 'image');
      expect((await fileRow(w, 'image'))?.['processing']).toBeUndefined();
      expect(
        await outcome(
          apiUser,
          `UPDATE type::record('storyFile', $key) SET processing = 'ready'`,
          { key: old },
        ),
      ).toMatchObject({ ok: false });
      // Not once the story is submitted: the mark is part of submitting, not after it.
      expect(await submit(pat, w)).toHaveLength(1);
      expect(
        await setFile(w, `processing = 'ready'`, apiUser, 'image'),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('picture_check:'),
      });
      await refusedApproval(w, 'the story’s image hasn’t finished processing');

      // A picture checked at submit is enough for approval's media rule.
      const ok = await written();
      expect(
        await setFile(ok, `processing = 'ready'`, apiUser, 'image'),
      ).toMatchObject({ ok: true });
      expect(await submit(pat, ok)).toHaveLength(1);
      await approve(admin, ok);
      expect(await statusOf(ok)).toBe('approved');
    });

    it('refuses an unknown processing state', async () => {
      const v = await video();
      expect(await setFile(v, `processing = 'done'`)).toEqual({
        ok: false,
        error: expect.stringContaining('processing'),
      });
    });

    it('a new upload is a new row, not processed yet, even after the old one was', async () => {
      const id = await video();
      await processed(workflow, id);
      const replacement = await upload(id, 'video');
      expect(await fileOf(id)).toBe(replacement);
      expect((await fileRow(id))?.['processing']).toBeUndefined();
      expect(await submit(pat, id)).toHaveLength(1);
      await answered(workflow, id);
      await refusedApproval(
        id,
        'the story’s video or audio hasn’t finished processing',
      );
    });
  });

  describe('approval', () => {
    const pending = async (make: () => Promise<string>, set?: string) => {
      const id = await make();
      expect(await submit(pat, id)).toHaveLength(1);
      await answered(workflow, id);
      if (set) {
        const which = make === written ? 'image' : 'media';
        expect(await setFile(id, set, workflow, which)).toMatchObject({
          ok: true,
        });
      }
      return id;
    };

    it.each([
      [
        'an unprocessed video',
        video,
        undefined,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a video still processing',
        video,
        `processing = 'processing'`,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a video that failed processing',
        video,
        `processing = 'failed'`,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a ready video without its size',
        video,
        `processing = 'ready', lengthSeconds = 30`,
        'a video needs its width, height and length',
      ],
      [
        'a ready video without its length',
        video,
        `processing = 'ready', width = 1080, height = 1920`,
        'a video needs its width, height and length',
      ],
      [
        'an unprocessed audio file',
        audio,
        undefined,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a ready audio file without its length',
        audio,
        `processing = 'ready'`,
        'an audio file needs its length',
      ],
      [
        'a ready audio file with an empty thumbnail path',
        audio,
        `processing = 'ready', lengthSeconds = 30, thumbnailPath = '', width = 1280, height = 720`,
        'an audio file needs its thumbnail and that picture’s width and height',
      ],
      [
        'a ready audio file with a thumbnail outside its own video’s folder',
        audio,
        `processing = 'ready', lengthSeconds = 30,
         thumbnailPath = 'other/thumbnail_0a1b2c3d.jpg', width = 1280, height = 720`,
        'an audio file needs its thumbnail and that picture’s width and height',
      ],
      [
        'a ready audio file without its thumbnail’s size',
        audio,
        `processing = 'ready', lengthSeconds = 30,
         thumbnailPath = record::id(id) + '/thumbnail_0a1b2c3d.jpg'`,
        'an audio file needs its thumbnail and that picture’s width and height',
      ],
      [
        'an unchecked picture',
        written,
        undefined,
        'the story’s image hasn’t finished processing',
      ],
      [
        'a failed picture',
        written,
        `processing = 'failed'`,
        'the story’s image hasn’t finished processing',
      ],
    ])('is refused for %s', async (_name, make, set, message) => {
      await refusedApproval(await pending(make, set), message);
    });

    it.each([
      ['a processed video', video],
      ['a processed audio file', audio],
      ['a written story with a checked picture', written],
    ])('publishes %s, recording the files it reviewed', async (_name, make) => {
      const id = await make();
      expect(await submit(pat, id)).toHaveLength(1);
      await answered(workflow, id);
      await processed(workflow, id);
      await approve(admin, id);
      expect(await published(id)).toEqual([`story:${id}`]);
      expect(await current(id)).toMatchObject(
        make === written
          ? {
              status: 'approved',
              reviewedImageFile: `storyFile:⟨${await fileOf(id, 'image')}⟩`,
            }
          : {
              status: 'approved',
              reviewedMediaFile: `storyFile:${await fileOf(id)}`,
            },
      );
    });

    it.each(THUMBNAIL_PATH_CASES.map((c) => [c.why, c] as const))(
      'an audio thumbnail path: %s',
      async (_why, c) => {
        const id = await create(`primaryFormat: 'audio'`, []);
        // A key as long as the case's video id, so the path keeps its length.
        await upload(
          id,
          'audio',
          migrator,
          `a${seq}`.padEnd(c.videoId.length, '0'),
        );
        expect(await submit(pat, id)).toHaveLength(1);
        await answered(workflow, id);
        const key = await fileOf(id);
        // The cases are written for their own video id; ours is the row's key.
        const path = c.path.split(c.videoId).join(key);
        await setFile(
          id,
          `processing = 'ready', lengthSeconds = 30, width = 1280, height = 720, thumbnailPath = $path`.replace(
            '$path',
            JSON.stringify(path),
          ),
        );
        if (c.ok) {
          expect(await step(admin, id, 'approved')).toHaveLength(1);
        } else {
          await refusedApproval(
            id,
            'an audio file needs its thumbnail and that picture’s width and height',
          );
        }
      },
    );

    it('is refused for system users too (the migrator)', async () => {
      const id = await video();
      expect(await submit(pat, id)).toHaveLength(1);
      await answered(workflow, id);
      expect(
        await outcome(
          migrator,
          `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'approved',
             actor: 'moderator', by: user:moderator }`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('media_not_ready:'),
      });
    });
  });

  describe('an approved story is hidden while a file is not ready', () => {
    const live = async (make: () => Promise<string>) => {
      const id = await make();
      expect(await submit(pat, id)).toHaveLength(1);
      await answered(workflow, id);
      await processed(workflow, id);
      await approve(admin, id);
      expect(await published(id)).toEqual([`story:${id}`]);
      return id;
    };
    const hiddenIds = async () =>
      (
        (await rows(admin, `RETURN fn::story::hidden_by_media()`)).flat() as {
          id: unknown;
        }[]
      ).map((r) => String(r.id));
    const expectHidden = async (id: string, reason = 'media_unavailable') => {
      expect(await current(id)).toMatchObject({
        status: 'hidden',
        actor: 'system',
        hiddenReason: reason,
      });
      expect(await published(id)).toEqual([]);
      expect(await hiddenIds()).toContain(`story:${id}`);
    };
    const expectLive = async (id: string) => {
      expect(await statusOf(id)).toBe('approved');
      expect(await published(id)).toEqual([`story:${id}`]);
      expect(await hiddenIds()).not.toContain(`story:${id}`);
    };

    it.each<[string, () => Promise<string>, string, 'media' | 'image']>([
      ['a video marked failed', video, `processing = 'failed'`, 'media'],
      [
        'a video back to processing',
        video,
        `processing = 'processing'`,
        'media',
      ],
      ['a video losing its length', video, `lengthSeconds = NONE`, 'media'],
      [
        'an audio file losing its thumbnail',
        audio,
        `thumbnailPath = NONE`,
        'media',
      ],
      ['a picture marked failed', written, `processing = 'failed'`, 'image'],
    ])(
      'hides it on %s, and shows it again when the same file is ready',
      async (_name, make, set, which) => {
        const id = await live(make);
        const publishedAt = (await current(id))?.['publishedAt'];
        expect(await setFile(id, set, workflow, which)).toMatchObject({
          ok: true,
        });
        await expectHidden(id);
        await processed(workflow, id);
        await expectLive(id);
        expect(await current(id)).toMatchObject({
          actor: 'system',
          publishedAt,
        });
      },
    );

    it('a system user hides and restores it too', async () => {
      const id = await live(video);
      await setFile(id, `processing = 'failed'`, migrator);
      await expectHidden(id);
      await setFile(id, `processing = 'ready'`, migrator);
      await expectLive(id);
    });

    it('stays hidden while still not ready', async () => {
      const id = await live(video);
      await setFile(id, `processing = 'failed'`);
      await setFile(id, `processing = 'processing'`);
      await expectHidden(id);
      expect(
        (
          await truth<string>(
            `SELECT VALUE status FROM storyStatusLog WHERE story = type::record('story', $id)
             ORDER BY at`,
            { id },
          )
        ).filter((s) => s === 'hidden'),
      ).toHaveLength(1);
    });

    it('the person can’t mark it hidden or shown again; the system’s show-again needs the reviewed files, ready', async () => {
      const id = await live(video);
      expect(
        await outcome(
          pat,
          `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'hiddenBySystem',
             hiddenReason: 'media_unavailable' }`,
          { id },
        ),
      ).toEqual({ ok: true, result: [] }); // refused by the permissions: nothing written
      await setFile(id, `processing = 'failed'`);
      expect(
        await outcome(
          migrator,
          `CREATE storyStatusLog CONTENT { story: type::record('story', $id), action: 'shownBySystem',
             actor: 'system' }`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('story_not_restorable'),
      });
      await expectHidden(id);
    });

    it('other files stay hidden: a moderator must review them, and their approval records them', async () => {
      const id = await live(video);
      await setFile(id, `processing = 'failed'`);
      await expectHidden(id);
      // Only a system user can point a submitted story at another file (content is locked).
      const other = await upload(id, 'video');
      await processed(workflow, id);
      expect(await statusOf(id)).toBe('hidden');
      expect(
        (
          (await rows(admin, `RETURN fn::story::hidden_by_media()`)).flat() as {
            id: string;
            mediaChanged: boolean;
          }[]
        ).find((r) => String(r.id) === `story:${id}`),
      ).toMatchObject({ mediaChanged: true });
      // A moderator's "show again" is their review of what it shows now.
      expect(await step(admin, id, 'shownByModerator')).toHaveLength(1);
      expect(await current(id)).toMatchObject({
        actor: 'moderator',
        reviewedMediaFile: `storyFile:${other}`,
      });
      // And those files are what it comes back with next time (Codex, #61).
      await setFile(id, `processing = 'failed'`);
      await expectHidden(id);
      await processed(workflow, id);
      await expectLive(id);
    });

    it('pointing a published story at another file, even a ready one, hides it (media_changed)', async () => {
      const id = await live(written);
      await run(
        migrator,
        `CREATE storyFile:⟨stories/${id}/ffffffffffffffffffffffffffffffff.webp⟩ CONTENT {
           story: type::record('story', $id), person: user:pat, format: 'image',
           contentType: 'image/webp', sizeBytes: 1, storyVersion: 1, width: 900, height: 900,
           processing: 'ready' };
         UPDATE type::record('story', $id) SET image.file =
           storyFile:⟨stories/${id}/ffffffffffffffffffffffffffffffff.webp⟩;`,
        { id },
      );
      await expectHidden(id, 'media_changed');
    });

    it('a new thumbnail from Bunny on a public story shows at once (D60)', async () => {
      const id = await live(video);
      const key = await fileOf(id);
      expect(
        await setFile(id, `thumbnailPath = '${key}/thumbnail_3.jpg'`),
      ).toMatchObject({ ok: true });
      await expectLive(id);
    });

    it('an unrelated workflow write to a ready picture keeps it published', async () => {
      const id = await live(written);
      expect(
        await setFile(id, `processing = 'ready'`, workflow, 'image'),
      ).toMatchObject({ ok: true });
      await expectLive(id);
    });

    it('a moderator’s hide stays until a moderator shows it again', async () => {
      const id = await live(video);
      expect(await step(admin, id, 'hiddenByModerator')).toHaveLength(1);
      await processed(workflow, id);
      expect(await current(id)).toMatchObject({
        status: 'hidden',
        actor: 'moderator',
      });
      expect(await hiddenIds()).not.toContain(`story:${id}`);
    });

    it('steps the story’s version once to hide and once to show again (D29)', async () => {
      const id = await live(video);
      const before = await version(id);
      await setFile(id, `processing = 'failed'`);
      expect(await version(id)).toBe(before + 1);
      await processed(workflow, id);
      expect(await version(id)).toBe(before + 2);
    });

    it('the owner can take a hidden story down to edit (G2), and then it never comes back by itself', async () => {
      const id = await live(video);
      await setFile(id, `processing = 'failed'`);
      expect(await edit(pat, id)).toHaveLength(1);
      await processed(workflow, id);
      expect(await statusOf(id)).toBe('editing');
      expect(await published(id)).toEqual([]);
    });

    it('erasure takes a hidden story with its log and file rows', async () => {
      await createPeople(t, { hid: 'user_hid' });
      await trustSubmitters(t, 'hid');
      const hid = await t.person('user_hid');
      await agreeAll(hid);
      await run(
        hid,
        `CREATE story:hid_v CONTENT { themeRefs: [theme:common], submitter: $auth, slug: 'hid-v',
           title: 'A story', description: 'd', primaryFormat: 'video' }`,
      );
      await run(
        migrator,
        `CREATE storyFile:hidvid CONTENT { story: story:hid_v, person: user:hid, format: 'video',
           contentType: 'video/mp4', sizeBytes: 1, storyVersion: 1, at: time::now() - 1d };
         UPDATE story:hid_v SET mediaFile = storyFile:hidvid;`,
      );
      expect(await submit(hid, 'hid_v')).toHaveLength(1);
      await answered(workflow, 'hid_v');
      await processed(workflow, 'hid_v');
      await approve(admin, 'hid_v');
      await run(workflow, `UPDATE storyFile:hidvid SET processing = 'failed'`);
      expect(await statusOf('hid_v')).toBe('hidden');
      await run(await t.service('api_user'), ERASE, {
        clerkUserId: 'user_hid',
        reason: 'user_requested',
      });
      expect(
        await truth(
          `RETURN [count(SELECT id FROM story WHERE id = story:hid_v),
             count(SELECT id FROM storyStatusLog WHERE story = story:hid_v),
             count(SELECT id FROM storyFile WHERE story = story:hid_v)]`,
        ),
      ).toEqual([0, 0, 0]);
    });
  });
});

import { randomUUID } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import {
  agreeAll,
  createPeople,
  outcome,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from './support/harness';
import {
  answered,
  draft,
  grantImage,
  grantUpload,
  processed,
  submit,
} from './support/world';

/**
 * An audio story's picture video and the picture Bunny shows (Joel: audio-picture-video.html
 * decision 1B, 2026-11-07; video-bundle-rethink.html part A, 2026-11-06):
 * - the result writer (workflow's login) makes a picture video of an audio file as a new file row
 *   (renderOf), which isn't the person's upload, so the upload limits skip it;
 * - it moves the story from the file to that picture video only while the story still points at
 *   the file, without a new version; nothing else it writes to the pointer is kept;
 * - a video or audio file's thumbnailOf (the picture Bunny shows) must be the story's picture
 *   before a moderator can approve it;
 * - submitting a video or audio story writes a check job, and changing an audio story's picture
 *   writes a render job, in the same write.
 */
describe('picture videos and the picture Bunny shows (1B, part A)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let pat: Surreal;
  let n = 0;

  const truth = <T = Record<string, unknown>>(
    sql: string,
    vars?: Record<string, unknown>,
  ) => rows<T>(migrator, sql, vars);
  const story = async (id: string) =>
    (
      await truth<{ mediaFile?: string; version: number }>(
        `SELECT (IF mediaFile != NONE { <string> record::id(mediaFile) }) AS mediaFile, version FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  const versionOf = async (id: string) => (await story(id)).version;

  /** Pat's audio draft with its uploaded file: the story's id and the file's (video) id. */
  const audioDraft = async () => {
    const id = `pv_${++n}`;
    const audio = randomUUID();
    await draft(pat, id, { primaryFormat: 'audio', body: undefined });
    expect(
      await grantUpload(apiUser, {
        video: audio,
        story: id,
        person: 'pat',
        version: await versionOf(id),
        format: 'audio',
      }),
    ).toMatchObject({ ok: true });
    return { id, audio };
  };

  /** The result writer's row for a picture video of `source` (as its `rendered` route makes it). */
  const makeRender = (
    id: string,
    source: string,
    db: Surreal = workflow,
    extra: Record<string, unknown> = {},
  ) => {
    const render = randomUUID();
    return outcome(
      db,
      `CREATE type::record('storyFile', $render) CONTENT object::extend({
         story: type::record('story', $id), person: user:pat, format: 'audio',
         contentType: 'video/mp4', sizeBytes: 2000, storyVersion: 1,
         renderOf: type::record('storyFile', $source) }, $extra) RETURN VALUE <string> record::id(id)`,
      { id, source, render, extra },
    ).then((r) => ({ ...r, render }));
  };

  /** The writer's pointer move, as its `rendered` route writes it. */
  const move = (id: string, to: string, db: Surreal = workflow) =>
    run(
      db,
      `LET $renderMove = true;
       UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $to) RETURN NONE;`,
      { id, to },
    );

  const openJobs = (file: string) =>
    truth<{ kind: string; reasons: string[] }>(
      `SELECT kind, reasons FROM mediaJob WHERE file = type::record('storyFile', $file)
         AND doneAt = NONE ORDER BY kind`,
      { file },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await trustSubmitters(t, 'pat');
    await run(
      migrator,
      `UPDATE submitterLimits:pat SET openDraftsMax = 100, uploadRequestsPerHour = 100`,
    );
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  afterAll(() => t?.close());

  describe('the writer moves the story to its picture video', () => {
    it('while the story still points at the file: no new version, and the file is detached for the clean-up', async () => {
      const { id, audio } = await audioDraft();
      const before = await versionOf(id);
      const made = await makeRender(id, audio);
      expect(made).toMatchObject({ ok: true });
      await move(id, made.render);
      expect(await story(id)).toEqual({
        mediaFile: made.render,
        version: before,
      });
      expect(
        await truth(
          `SELECT VALUE detachedAt != NONE FROM ONLY type::record('storyFile', $audio)`,
          { audio },
        ),
      ).toEqual([true]);
    });

    it('not once the person has uploaded a new recording: theirs wins', async () => {
      const { id, audio } = await audioDraft();
      const made = await makeRender(id, audio);
      const newer = randomUUID();
      expect(
        await grantUpload(apiUser, {
          video: newer,
          story: id,
          person: 'pat',
          version: await versionOf(id),
          format: 'audio',
        }),
      ).toMatchObject({ ok: true });
      await move(id, made.render);
      expect((await story(id)).mediaFile).toBe(newer);
    });

    it('never to anything but the file’s own picture video, and never off it', async () => {
      const { id, audio } = await audioDraft();
      const other = await audioDraft();
      const elsewhere = await makeRender(other.id, other.audio);
      const before = await story(id);
      await move(id, elsewhere.render);
      await run(
        workflow,
        `LET $renderMove = true; UPDATE type::record('story', $id) SET mediaFile = NONE`,
        { id },
      );
      expect(await story(id)).toEqual(before);
      // The person's session and api-admin can't move it either, even with the parameter.
      const made = await makeRender(id, audio);
      for (const db of [pat, admin]) {
        await move(id, made.render, db).catch(() => undefined);
      }
      expect((await story(id)).mediaFile).toBe(audio);
    });
  });

  describe('picture video rows', () => {
    it('only workflow makes them, of an audio file of the same story', async () => {
      const { id, audio } = await audioDraft();
      const other = await audioDraft();
      expect(await makeRender(id, other.audio)).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          'a picture video is made of an audio file',
        ),
      });
      // Without renderOf, workflow can't make a file row at all.
      expect(
        await outcome(
          workflow,
          `CREATE type::record('storyFile', $key) CONTENT { story: type::record('story', $id),
             person: user:pat, format: 'audio', contentType: 'video/mp4', sizeBytes: 1,
             storyVersion: 1 }`,
          { key: randomUUID(), id },
        ),
      ).toMatchObject({ ok: true, result: [] });
      // api-user's renderOf is dropped: its row is an ordinary upload (storyFile_attach).
      const key = randomUUID();
      await run(
        apiUser,
        `CREATE type::record('storyFile', $key) CONTENT { story: type::record('story', $id),
           person: user:pat, format: 'audio', contentType: 'audio/mpeg', sizeBytes: 1,
           storyVersion: $v, renderOf: type::record('storyFile', $audio) }`,
        { key, id, audio, v: await versionOf(id) },
      );
      expect(
        await truth(
          `SELECT VALUE renderOf = NONE FROM ONLY type::record('storyFile', $key)`,
          { key },
        ),
      ).toEqual([true]);
    });

    it('don’t count towards the person’s upload limits', async () => {
      await run(
        migrator,
        `UPDATE submitterLimits:pat SET trusted = false, uploadsPer7Days = 1000`,
      );
      const { id, audio } = await audioDraft();
      const next = () =>
        rows(
          pat,
          `RETURN fn::upload::next_allowed_at(user:pat, 'audio') = NONE`,
        );
      const counted = await truth<number>(
        `RETURN count(SELECT id FROM storyFile WHERE person = user:pat
           AND format != 'image' AND renderOf = NONE)`,
      );
      // Exactly at the weekly limit with the person's own uploads: one more picture video
      // changes nothing, and the person may still upload once more (D113).
      await run(
        migrator,
        `UPDATE submitterLimits:pat SET uploadsPer7Days = $limit`,
        { limit: counted[0] + 1 },
      );
      expect(await next()).toEqual([true]);
      expect(await makeRender(id, audio)).toMatchObject({ ok: true });
      expect(await next()).toEqual([true]);
      await run(
        migrator,
        `UPDATE submitterLimits:pat SET trusted = true, uploadsPer7Days = NONE`,
      );
    });
  });

  describe('approval needs Bunny to show the story’s picture (thumbnailOf)', () => {
    /** Pat's audio story with a picture and its picture video, processed. */
    const inReview = async () => {
      const { id, audio } = await audioDraft();
      expect(
        await grantImage(apiUser, {
          story: id,
          person: 'pat',
          version: await versionOf(id),
        }),
      ).toMatchObject({ ok: true });
      const made = await makeRender(id, audio, workflow);
      await move(id, made.render);
      await processed(workflow, id);
      return { id, render: made.render };
    };
    /** What keeps the story from being approved (fn::story::approval_problem), or null. */
    const problem = async (id: string) =>
      (
        await truth<string | null>(
          `RETURN fn::story::approval_problem((SELECT * FROM ONLY type::record('story', $id)))`,
          { id },
        )
      )[0] ?? null;

    it('is refused while Bunny shows another picture, and allowed once it shows the story’s', async () => {
      const { id, render } = await inReview();
      await run(
        workflow,
        `UPDATE type::record('storyFile', $render) SET thumbnailOf = NONE`,
        { render },
      );
      expect(await problem(id)).toBe(
        'media_not_ready: Bunny doesn’t show the story’s picture yet',
      );
      await run(
        workflow,
        `LET $s = (SELECT image FROM ONLY type::record('story', $id));
         UPDATE type::record('storyFile', $render) SET thumbnailOf = $s.image.file`,
        { id, render },
      );
      expect(await problem(id)).toBeNull();
    });

    it('is only ever a picture of the file’s own story, written by workflow', async () => {
      const { render } = await inReview();
      const other = await inReview();
      const before = await truth(
        `SELECT VALUE thumbnailOf FROM ONLY type::record('storyFile', $render)`,
        { render },
      );
      expect(
        await outcome(
          workflow,
          `LET $s = (SELECT image FROM ONLY type::record('story', $other));
           UPDATE type::record('storyFile', $render) SET thumbnailOf = $s.image.file`,
          { render, other: other.id },
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('a picture of its own story'),
      });
      await run(
        apiUser,
        `UPDATE type::record('storyFile', $render) SET thumbnailOf = NONE`,
        { render },
      );
      expect(
        await truth(
          `SELECT VALUE thumbnailOf FROM ONLY type::record('storyFile', $render)`,
          { render },
        ),
      ).toEqual(before);
    });
  });

  describe('the jobs a person’s steps write', () => {
    it('submitting a video or audio story writes a check of its file', async () => {
      const { id, audio } = await audioDraft();
      await answered(workflow, id);
      expect(await submit(pat, id)).toHaveLength(1);
      expect(await openJobs(audio)).toEqual([
        { kind: 'check', reasons: ['submitted'] },
      ]);
    });

    it('putting on, replacing or taking off an audio story’s picture writes one render of its file', async () => {
      const { id, audio } = await audioDraft();
      expect(await openJobs(audio)).toEqual([]);
      expect(
        await grantImage(apiUser, {
          story: id,
          person: 'pat',
          version: await versionOf(id),
        }),
      ).toMatchObject({ ok: true });
      expect(await openJobs(audio)).toEqual([
        { kind: 'render', reasons: ['picture_changed'] },
      ]);
      await run(pat, `UPDATE type::record('story', $id) SET image = NONE`, {
        id,
      });
      expect(
        await truth(
          `SELECT VALUE image = NONE FROM ONLY type::record('story', $id)`,
          { id },
        ),
      ).toEqual([true]);
      // Still one open render: the new reason joins it (J1 check a).
      expect(await openJobs(audio)).toEqual([
        { kind: 'render', reasons: ['picture_changed'] },
      ]);
    });
  });
});

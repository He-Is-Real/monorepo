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
import { draft, processed, step, submit } from './support/world';

/**
 * A moderator's approval waits for the media (Joel, 2026-11-07: decision 5 and J6,
 * media-worker-final.html section 3):
 * - the upload cooldown: not while the last upload link signed for the story's video, audio file
 *   or picture could still replace it (an hour for video and audio, 10 minutes for a picture,
 *   from the row's `at` or a resume's `renewedAt`); the refusal says when it can be approved;
 * - an open media job: not while a check or render for those files hasn't ended.
 * An Admin may approve anyway, and the approval records it. Neither rule touches the system
 * hiding or showing again an approved story when its files change.
 */
describe('a moderator’s approval waits for the media (decision 5, J6)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let housekeeping: Surreal;
  let pat: Surreal;
  let n = 0;

  const truth = <T = Record<string, unknown>>(
    sql: string,
    vars?: Record<string, unknown>,
  ) => rows<T>(migrator, sql, vars);

  /**
   * Pat's story, sent for review, its files processed: a video uploaded
   * `video` ago (a SurrealQL duration) and/or a picture uploaded `picture` ago. Answers its id.
   */
  const waiting = async (files: {
    video?: string;
    audio?: string;
    picture?: string;
  }) => {
    const id = `wait_${++n}`;
    const format = files.video ? 'video' : files.audio ? 'audio' : 'written';
    await draft(pat, id, {
      primaryFormat: format,
      ...(format === 'written' ? {} : { body: undefined }),
    });
    const ago = files.video ?? files.audio;
    if (ago) {
      await run(
        migrator,
        `CREATE type::record('storyFile', $id + '-media') CONTENT {
           story: type::record('story', $id), person: user:pat, format: $format,
           contentType: 'x/y', sizeBytes: 1000, storyVersion: 1,
           at: time::now() - <duration> $ago };
         UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $id + '-media');`,
        { id, format, ago },
      );
    }
    if (files.picture) {
      await run(
        migrator,
        `LET $path = 'stories/' + $id + '/' + string::repeat('a', 32) + '.webp';
         CREATE type::record('storyFile', $path) CONTENT {
           story: type::record('story', $id), person: user:pat, format: 'image',
           contentType: 'image/webp', sizeBytes: 1000, storyVersion: 1, width: 900,
           height: 1200, at: time::now() - <duration> $ago };
         UPDATE type::record('story', $id) SET image = { file: type::record('storyFile', $path) };`,
        { id, ago: files.picture },
      );
    }
    expect(await submit(pat, id)).toHaveLength(1);
    // The writer answers the check written at Submit.
    await processed(workflow, id);
    return id;
  };

  /** A moderator's approval, as api-admin adds it (`extra`: e.g. skippedMediaWait). */
  const approve = (id: string, extra: Record<string, unknown> = {}) =>
    outcome(
      admin,
      `CREATE storyStatusLog CONTENT object::extend({ story: type::record('story', $id),
         action: 'approved', by: user:moderator }, $extra)`,
      { id, extra },
    );
  const statusOf = async (id: string) =>
    (
      await truth<string>(
        `SELECT VALUE fn::story::status_of($this) FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  /** The story's file of `which`'s key. */
  const fileOf = async (id: string, which: 'mediaFile' | 'image.file') =>
    (
      await truth<string>(
        `SELECT VALUE record::id(${which}) FROM ONLY type::record('story', $id)`,
        { id },
      )
    )[0];
  /** The moderator's wait at `$now` (a SurrealQL expression), as the approval judges it. */
  const waitAt = async (id: string, now: string) =>
    (
      await truth<string | null>(
        `LET $s = (SELECT * FROM ONLY type::record('story', $id));
         RETURN fn::story::approval_wait($s, ${now});`,
        { id },
      )
    )[0] ?? null;
  /** When the file's link runs out (its `at` plus the link's length). */
  const linkEnds = async (key: string) =>
    (
      await truth<string>(
        `SELECT VALUE <string> time::ceil(at + fn::upload::link_lifetime(format), 1s)
         FROM ONLY type::record('storyFile', $key)`,
        { key },
      )
    )[0];
  /** api-user opens a job for the file (fn::media::queue_job); answers the job's id. */
  const openJob = async (key: string, kind = 'check', reason = 'submitted') =>
    (
      await rows<{ job: string }>(
        apiUser,
        `RETURN fn::media::queue_job(type::record('storyFile', $key), $kind, $reason)`,
        { key, kind, reason },
      )
    )[0].job;
  /** The result writer ends the job. */
  const endJob = (job: string) =>
    run(
      workflow,
      `UPDATE type::record('mediaJob', $job) SET outcome = 'applied', doneAt = time::now()`,
      { job },
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    housekeeping = await t.service('housekeeping');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await trustSubmitters(t, 'pat');
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  afterAll(() => t?.close());

  describe('the upload cooldown', () => {
    it('refuses while the video’s upload link could still be used, saying when it can be approved', async () => {
      const id = await waiting({ video: '30m' });
      expect(await approve(id)).toEqual({
        ok: false,
        error: expect.stringContaining(
          `media_recently_uploaded: the story’s file was uploaded recently; it can be approved after ${await linkEnds(`${id}-media`)}`,
        ),
      });
      expect(await statusOf(id)).toBe('pending');
    });

    it('approves once the video’s hour is up', async () => {
      const id = await waiting({ video: '61m' });
      expect(await approve(id)).toMatchObject({ ok: true });
      expect(await statusOf(id)).toBe('approved');
    });

    it('a picture’s link lasts 10 minutes', async () => {
      const recent = await waiting({ picture: '5m' });
      expect(await approve(recent)).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          `media_recently_uploaded: the story’s file was uploaded recently; it can be approved after ${await linkEnds(await fileOf(recent, 'image.file'))}`,
        ),
      });
      const older = await waiting({ picture: '11m' });
      expect(await approve(older)).toMatchObject({ ok: true });
    });

    it('waits for the later of the story’s two files', async () => {
      const id = await waiting({ video: '2h', picture: '5m' });
      expect(await approve(id)).toMatchObject({
        ok: false,
        error: expect.stringContaining('media_recently_uploaded:'),
      });
    });

    it('a resume’s new link starts the wait again', async () => {
      const id = `wait_${++n}`;
      await draft(pat, id, { primaryFormat: 'video', body: undefined });
      await run(
        migrator,
        `CREATE type::record('storyFile', $id + '-media') CONTENT {
           story: type::record('story', $id), person: user:pat, format: 'video',
           contentType: 'x/y', sizeBytes: 1000, storyVersion: 1, at: time::now() - 1d };
         UPDATE type::record('story', $id) SET mediaFile = type::record('storyFile', $id + '-media');`,
        { id },
      );
      // api-user signs the link again (fn::upload::renew) before the person submits.
      await run(
        apiUser,
        `RETURN fn::upload::renew(type::record('story', $id), user:pat, $id + '-media')`,
        { id },
      );
      await processed(workflow, id);
      await submit(pat, id);
      expect(await approve(id)).toMatchObject({
        ok: false,
        error: expect.stringContaining('media_recently_uploaded:'),
      });
    });

    it('ends exactly when the link does: refused a millisecond before, approved from then', async () => {
      const video = await waiting({ video: '1d' });
      const picture = await waiting({ picture: '1d' });
      for (const [id, key, length] of [
        [video, `${video}-media`, '1h'],
        [picture, await fileOf(picture, 'image.file'), '10m'],
      ]) {
        const at = (
          await truth<string>(
            `SELECT VALUE <string> at FROM ONLY type::record('storyFile', $key)`,
            { key },
          )
        )[0];
        const end = `<datetime> '${at}' + ${length}`;
        expect({ key, before: await waitAt(id, `${end} - 1ms`) }).toEqual({
          key,
          before: expect.stringContaining('media_recently_uploaded:'),
        });
        expect({ key, atEnd: await waitAt(id, end) }).toEqual({
          key,
          atEnd: null,
        });
      }
    });
  });

  describe('an open media job (J6)', () => {
    it('refuses while a job for the story’s video is open, and approves once it ends', async () => {
      const id = await waiting({ video: '1d' });
      const job = await openJob(`${id}-media`);
      expect(await approve(id)).toEqual({
        ok: false,
        error: expect.stringContaining(
          'media_still_processing: the story’s media is still being processed',
        ),
      });
      await endJob(job);
      expect(await approve(id)).toMatchObject({ ok: true });
    });

    it('an audio story whose picture video is still being made can’t be approved', async () => {
      const id = await waiting({ audio: '1d', picture: '1d' });
      const job = await openJob(`${id}-media`, 'render', 'picture_changed');
      expect(await approve(id)).toMatchObject({
        ok: false,
        error: expect.stringContaining('media_still_processing:'),
      });
      await endJob(job);
      expect(await approve(id)).toMatchObject({ ok: true });
    });

    it('a job for the story’s picture counts too', async () => {
      const id = await waiting({ picture: '1d' });
      await openJob(await fileOf(id, 'image.file'));
      expect(await approve(id)).toMatchObject({
        ok: false,
        error: expect.stringContaining('media_still_processing:'),
      });
    });

    it('a video’s picture at Bunny counts until a confirmed write empties its lock, run out or not (T3, T4)', async () => {
      const id = await waiting({ video: '1d' });
      const key = `${id}-media`;
      const lock = (until: string) =>
        run(
          workflow,
          `UPDATE type::record('storyFile', $key) SET thumbnailLockedUntil = ${until}`,
          { key },
        );
      const waits = {
        ok: false,
        error: expect.stringContaining(
          'media_still_processing: the story’s media is still being processed',
        ),
      };
      // A writer at work.
      await lock('time::now() + 2m');
      expect(await approve(id)).toEqual(waits);
      // Run out unfinished (T4 = A, Joel 2026-11-09): Bunny may show another picture; still waits,
      // with no job open.
      await lock('time::now() - 1s');
      expect(await approve(id)).toEqual(waits);
      // An Admin may approve anyway, as with an open job.
      expect(await approve(id, { skippedMediaWait: true })).toMatchObject({
        ok: true,
      });
    });

    it('once the result writer empties the lock (Bunny confirmed), approval goes ahead', async () => {
      const id = await waiting({ video: '1d' });
      const key = `${id}-media`;
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET thumbnailLockedUntil = time::now() - 1s`,
        { key },
      );
      expect(await approve(id)).toMatchObject({ ok: false });
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET thumbnailLockedUntil = NONE`,
        { key },
      );
      expect(await approve(id)).toMatchObject({ ok: true });
    });

    it('the lock is workflow’s to write; only housekeeping also reads it (the nightly re-check)', async () => {
      const id = await waiting({ video: '1d' });
      const key = `${id}-media`;
      const read = (db: Surreal) =>
        rows(
          db,
          `SELECT VALUE thumbnailLockedUntil FROM ONLY type::record('storyFile', $key)`,
          { key },
        );
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET thumbnailLockedUntil = time::now() + 2m`,
        { key },
      );
      for (const db of [apiUser, admin, pat]) {
        // Hidden: no value, whether or not the login sees the row itself.
        expect((await read(db)).filter((v) => v != null)).toEqual([]);
      }
      expect((await read(housekeeping)).filter((v) => v != null)).toHaveLength(
        1,
      );
      for (const db of [apiUser, admin, pat, housekeeping]) {
        await outcome(
          db,
          `UPDATE type::record('storyFile', $key) SET thumbnailLockedUntil = NONE`,
          { key },
        );
      }
      // Still workflow's lock: nobody else's write took.
      expect((await read(workflow)).filter((v) => v != null)).toHaveLength(1);
    });

    it('doesn’t stop the system hiding the story and showing it again', async () => {
      const id = await waiting({ video: '1d' });
      expect(await approve(id)).toMatchObject({ ok: true });
      const key = `${id}-media`;
      await openJob(key, 'check', 'bunny_finished');
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET processing = 'failed'`,
        { key },
      );
      expect(await statusOf(id)).toBe('hidden');
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET processing = 'ready'`,
        { key },
      );
      expect(await statusOf(id)).toBe('approved');
      // A moderator's "show again" is an approval: it waits.
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET processing = 'failed'`,
        { key },
      );
      await run(
        workflow,
        `UPDATE type::record('storyFile', $key) SET processing = 'ready', lengthSeconds = 61`,
        { key },
      );
      await step(admin, id, 'hiddenByModerator');
      expect(
        await outcome(
          admin,
          `CREATE storyStatusLog CONTENT { story: type::record('story', $id),
             action: 'shownByModerator', by: user:moderator }`,
          { id },
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('media_still_processing:'),
      });
    });
  });

  describe('an Admin may skip the wait', () => {
    it('approves during the cooldown with a job open, and the entry records it for api-admin only', async () => {
      const id = await waiting({ video: '5m' });
      await openJob(`${id}-media`);
      expect(await approve(id, { skippedMediaWait: true })).toMatchObject({
        ok: true,
      });
      expect(await statusOf(id)).toBe('approved');
      const entry = `SELECT VALUE currentStatus.skippedMediaWait FROM ONLY type::record('story', $id)`;
      expect(await rows(admin, entry, { id })).toEqual([true]);
      expect(await rows(pat, entry, { id })).toEqual([]);
      expect(
        await rows(await t.service('api_public_read'), entry, { id }),
      ).toEqual([]);
    });

    it('is refused when there is nothing to skip, and on any entry but an approval', async () => {
      const id = await waiting({ video: '1d' });
      expect(await approve(id, { skippedMediaWait: true })).toMatchObject({
        ok: false,
        error: expect.stringContaining('status_step: skippedMediaWait'),
      });
      const other = await waiting({ video: '5m' });
      expect(
        await outcome(
          admin,
          `CREATE storyStatusLog CONTENT { story: type::record('story', $id),
             action: 'changesRequested', comment: 'A note', by: user:moderator,
             skippedMediaWait: true }`,
          { id: other },
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('status_step: skippedMediaWait'),
      });
      expect(await statusOf(id)).toBe('pending');
      expect(await statusOf(other)).toBe('pending');
    });
  });
});

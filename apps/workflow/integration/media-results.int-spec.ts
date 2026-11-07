import {
  agreeAll,
  approve,
  createPeople,
  draft,
  grantUpload,
  rows,
  submit,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import type { Surreal } from 'surrealdb';
import {
  applyMediaResult,
  InvalidMediaResult,
  type MediaResult,
  parseMediaResult,
} from '../src/app/media-results';

/**
 * The result writer (M2 plan item 13, piece 3) against a real SurrealDB, signed in as
 * service:workflow. What matters is what it writes: the storyFile row of the Bunny video the
 * answer is about, only while its story still shows it, never twice; and the database's own
 * rules then hide an approved story whose video failed and show it again once it's ready.
 */
describe('result writer: Bunny video answers → the story’s file row', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let publicRead: Surreal;
  let pat: Surreal;
  let n = 0;

  const guid = () => `0f0e0d0c-0b0a-4908-8706-${String(++n).padStart(12, '0')}`;
  const ready = (
    videoId: string,
    story: string,
    extra: Partial<MediaResult> = {},
  ): MediaResult =>
    ({
      videoId,
      outcome: 'ready',
      title: story,
      width: 1080,
      height: 1920,
      lengthSeconds: 95,
      thumbnailFileName: 'thumbnail.jpg',
      ...extra,
    }) as MediaResult;

  /** A submitted video (or audio) story whose file is the Bunny video `video`, as api-user records it. */
  const videoStory = async (format: 'video' | 'audio' = 'video') => {
    const story = `media_${++n}`;
    const video = guid();
    await draft(pat, story, { primaryFormat: format });
    const version = (
      await rows<number>(
        migrator,
        `SELECT VALUE version FROM ONLY type::record('story', $story)`,
        { story },
      )
    )[0];
    expect(
      await grantUpload(apiUser, {
        video,
        story,
        person: 'pat',
        version,
        format,
      }),
    ).toMatchObject({ ok: true });
    return { story, video };
  };
  /** Replaces the story's video with a new upload (the person chose another file). */
  const replace = async (
    story: string,
    format: 'video' | 'audio' = 'video',
  ) => {
    const video = guid();
    const version = (
      await rows<number>(
        migrator,
        `SELECT VALUE version FROM ONLY type::record('story', $story)`,
        { story },
      )
    )[0];
    expect(
      await grantUpload(apiUser, {
        video,
        story,
        person: 'pat',
        version,
        format,
      }),
    ).toMatchObject({ ok: true });
    return video;
  };
  const file = async (video: string) =>
    (
      await rows(
        migrator,
        `SELECT processing, width, height, lengthSeconds, thumbnailPath, detachedAt
         FROM ONLY type::record('storyFile', $video)`,
        { video },
      )
    )[0];
  const storyRow = async (story: string) =>
    (
      await rows(
        migrator,
        `SELECT version, currentStatus.{ status, actor, hiddenReason } AS current
         FROM ONLY type::record('story', $story)`,
        { story },
      )
    )[0];
  const isPublic = async (story: string) =>
    (
      await rows(
        publicRead,
        `SELECT VALUE id FROM type::record('story', $story)`,
        { story },
      )
    ).length === 1;

  /**
   * When Google's queue took each answer (the push's publishTime): by default each answer is a
   * second newer than the last, as the queue would stamp them in order.
   */
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const next = () => new Date((clock += 1000)).toISOString();
  const answer = (result: MediaResult, publishedAt = next()) =>
    applyMediaResult(workflow, result, publishedAt);
  const checkedAt = async (video: string) =>
    (
      await rows<string>(
        migrator,
        `SELECT VALUE checkedAt FROM ONLY type::record('storyFile', $video)`,
        { video },
      )
    )[0];

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    publicRead = await t.service('api_public_read');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await trustSubmitters(t, 'pat');
    // More uploads than a person may start in an hour (D113): the limit isn't what's tested here.
    await rows(
      migrator,
      `UPDATE submitterLimits:pat SET uploadRequestsPerHour = 100, uploadsPer7Days = 100`,
    );
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  afterAll(() => t?.close());

  it('marks that video’s row ready with Bunny’s facts, and nothing else', async () => {
    const mine = await videoStory();
    const other = await videoStory();

    expect(await answer(ready(mine.video, mine.story))).toBe('written');

    expect(await file(mine.video)).toEqual({
      processing: 'ready',
      width: 1080,
      height: 1920,
      lengthSeconds: 95,
      thumbnailPath: `${mine.video}/thumbnail.jpg`,
    });
    expect(await file(other.video)).toEqual({});
  });

  it('writes nothing twice: the same message again changes nothing', async () => {
    const { story, video } = await videoStory();
    const at = next();
    await answer(ready(video, story), at);
    const before = await storyRow(story);

    // Pub/Sub delivers the same message again: same answer, same publishTime.
    expect(await answer(ready(video, story), at)).toBe('stale');
    expect(await storyRow(story)).toEqual(before);
    // A newer answer with the same facts records only its time; the story doesn't change.
    const later = next();
    expect(await answer(ready(video, story), later)).toBe('unchanged');
    expect(await storyRow(story)).toEqual(before);
    expect(await checkedAt(video)).toBe(later);
  });

  describe('an older answer never undoes a newer one (Joel, 2026-11-07, F1)', () => {
    it('the first answer applies and records its time', async () => {
      const { story, video } = await videoStory();
      expect(await checkedAt(video)).toBeUndefined();
      const at = next();

      expect(await answer(ready(video, story), at)).toBe('written');
      expect(await checkedAt(video)).toBe(at);
    });

    it('ready, then gone, then the ready redelivered: the story stays hidden', async () => {
      const { story, video } = await videoStory();
      const readyAt = next();
      await answer(ready(video, story), readyAt);
      await submit(pat, story);
      await approve(admin, story);
      const goneAt = next();
      await answer({ videoId: video, outcome: 'gone' }, goneAt);
      expect(await isPublic(story)).toBe(false);

      expect(await answer(ready(video, story), readyAt)).toBe('stale');
      expect((await file(video))['processing']).toBe('failed');
      expect(await checkedAt(video)).toBe(goneAt);
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'hidden', hiddenReason: 'media_unavailable' },
      });
      expect(await isPublic(story)).toBe(false);
    });

    it('an answer stamped at the same time as the last one applied is dropped', async () => {
      const { video } = await videoStory();
      const at = next();
      await answer({ videoId: video, outcome: 'encoding' }, at);

      expect(await answer({ videoId: video, outcome: 'failed' }, at)).toBe(
        'stale',
      );
      expect((await file(video))['processing']).toBe('processing');
    });

    it('a newer answer applies after an older one', async () => {
      const { story, video } = await videoStory();
      await answer({ videoId: video, outcome: 'encoding' });
      const at = next();

      expect(await answer(ready(video, story), at)).toBe('written');
      expect((await file(video))['processing']).toBe('ready');
      expect(await checkedAt(video)).toBe(at);
    });

    it('only workflow may write checkedAt', async () => {
      const { video } = await videoStory();
      for (const db of [apiUser, admin, pat]) {
        await rows(
          db,
          `UPDATE type::record('storyFile', $video) SET checkedAt = d'2030-01-01T00:00:00Z'`,
          { video },
        ).catch(() => undefined);
      }
      expect(await checkedAt(video)).toBeUndefined();
      await answer(
        { videoId: video, outcome: 'encoding' },
        '2026-12-01T00:00:00.000Z',
      );
      expect(await checkedAt(video)).toBe('2026-12-01T00:00:00.000Z');
    });
  });

  it('ignores answers about unknown, replaced or another story’s videos', async () => {
    const { story, video: old } = await videoStory();
    const current = await replace(story);

    // Unknown: no file row (a video of another library, or one no story was ever given).
    expect(await answer(ready(guid(), story))).toBe('ignored');
    // Replaced: the old video is detached; its answer changes neither row.
    expect(await answer(ready(old, story))).toBe('ignored');
    expect(await answer({ videoId: old, outcome: 'failed' })).toBe('ignored');
    expect((await file(old))['processing']).toBeUndefined();
    expect(await file(current)).not.toHaveProperty('processing');
    // Titled with another story's id (D69): not this story's video.
    expect(await answer(ready(current, 'someone_else'))).toBe('ignored');
    expect(await file(current)).not.toHaveProperty('processing');
  });

  it('records still encoding, failed, and gone (deleted at Bunny) as not ready', async () => {
    const encoding = await videoStory();
    const failed = await videoStory();
    const gone = await videoStory();

    await answer({
      videoId: encoding.video,
      outcome: 'encoding',
    });
    await answer({
      videoId: failed.video,
      outcome: 'failed',
    });
    await answer({ videoId: gone.video, outcome: 'gone' });

    expect((await file(encoding.video))['processing']).toBe('processing');
    expect((await file(failed.video))['processing']).toBe('failed');
    expect((await file(gone.video))['processing']).toBe('failed');
  });

  it('a published story hides when its video fails and comes back when it is ready again', async () => {
    const { story, video } = await videoStory();
    await answer(ready(video, story));
    await submit(pat, story);
    await approve(admin, story);
    expect(await isPublic(story)).toBe(true);

    await answer({ videoId: video, outcome: 'failed' });
    expect(await storyRow(story)).toMatchObject({
      current: {
        status: 'hidden',
        actor: 'system',
        hiddenReason: 'media_unavailable',
      },
    });
    expect(await isPublic(story)).toBe(false);

    // Re-encoded at Bunny (docs/media-runbook.md): ready again, maybe with another frame.
    await answer(ready(video, story, { thumbnailFileName: 'thumbnail_2.jpg' }));
    expect(await storyRow(story)).toMatchObject({
      current: { status: 'approved', actor: 'system' },
    });
    expect(await isPublic(story)).toBe(true);
  });

  it('an audio file gets its length; its picture is left for the default-picture step', async () => {
    const { story, video } = await videoStory('audio');

    await answer(ready(video, story, { width: 1280, height: 720 }));

    expect(await file(video)).toEqual({
      processing: 'ready',
      lengthSeconds: 95,
    });
  });

  it('refuses a malformed answer before touching the database', () => {
    const story = 'any';
    const video = guid();
    for (const bad of [
      null,
      { videoId: 'storyFile:x', outcome: 'failed' },
      { videoId: video, outcome: 'deleted' },
      { ...ready(video, story), lengthSeconds: 0 },
      { ...ready(video, story), thumbnailFileName: '../other/thumbnail.jpg' },
      { ...ready(video, story), title: undefined },
    ]) {
      expect(() => parseMediaResult(bad)).toThrow(InvalidMediaResult);
    }
    expect(parseMediaResult(ready(video, story))).toEqual(ready(video, story));
  });
});

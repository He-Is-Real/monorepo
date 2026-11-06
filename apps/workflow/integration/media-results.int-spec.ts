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

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    publicRead = await t.service('api_public_read');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await trustSubmitters(t, 'pat');
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  afterAll(() => t?.close());

  it('marks that video’s row ready with Bunny’s facts, and nothing else', async () => {
    const mine = await videoStory();
    const other = await videoStory();

    expect(
      await applyMediaResult(workflow, ready(mine.video, mine.story)),
    ).toBe('written');

    expect(await file(mine.video)).toEqual({
      processing: 'ready',
      width: 1080,
      height: 1920,
      lengthSeconds: 95,
      thumbnailPath: `${mine.video}/thumbnail.jpg`,
    });
    expect(await file(other.video)).toEqual({});
  });

  it('writes nothing twice: the same answer again changes nothing', async () => {
    const { story, video } = await videoStory();
    await applyMediaResult(workflow, ready(video, story));
    const before = await storyRow(story);

    expect(await applyMediaResult(workflow, ready(video, story))).toBe(
      'unchanged',
    );
    expect(await storyRow(story)).toEqual(before);
  });

  it('ignores answers about unknown, replaced or another story’s videos', async () => {
    const { story, video: old } = await videoStory();
    const current = await replace(story);

    // Unknown: no file row (a video of another library, or one no story was ever given).
    expect(await applyMediaResult(workflow, ready(guid(), story))).toBe(
      'ignored',
    );
    // Replaced: the old video is detached; its answer changes neither row.
    expect(await applyMediaResult(workflow, ready(old, story))).toBe('ignored');
    expect(
      await applyMediaResult(workflow, { videoId: old, outcome: 'failed' }),
    ).toBe('ignored');
    expect((await file(old))['processing']).toBeUndefined();
    expect(await file(current)).not.toHaveProperty('processing');
    // Titled with another story's id (D69): not this story's video.
    expect(
      await applyMediaResult(workflow, ready(current, 'someone_else')),
    ).toBe('ignored');
    expect(await file(current)).not.toHaveProperty('processing');
  });

  it('records still encoding, failed, and gone (deleted at Bunny) as not ready', async () => {
    const encoding = await videoStory();
    const failed = await videoStory();
    const gone = await videoStory();

    await applyMediaResult(workflow, {
      videoId: encoding.video,
      outcome: 'encoding',
    });
    await applyMediaResult(workflow, {
      videoId: failed.video,
      outcome: 'failed',
    });
    await applyMediaResult(workflow, { videoId: gone.video, outcome: 'gone' });

    expect((await file(encoding.video))['processing']).toBe('processing');
    expect((await file(failed.video))['processing']).toBe('failed');
    expect((await file(gone.video))['processing']).toBe('failed');
  });

  it('a published story hides when its video fails and comes back when it is ready again', async () => {
    const { story, video } = await videoStory();
    await applyMediaResult(workflow, ready(video, story));
    await submit(pat, story);
    await approve(admin, story);
    expect(await isPublic(story)).toBe(true);

    await applyMediaResult(workflow, { videoId: video, outcome: 'failed' });
    expect(await storyRow(story)).toMatchObject({
      current: {
        status: 'hidden',
        actor: 'system',
        hiddenReason: 'media_unavailable',
      },
    });
    expect(await isPublic(story)).toBe(false);

    // Re-encoded at Bunny (docs/media-runbook.md): ready again, maybe with another frame.
    await applyMediaResult(
      workflow,
      ready(video, story, { thumbnailFileName: 'thumbnail_2.jpg' }),
    );
    expect(await storyRow(story)).toMatchObject({
      current: { status: 'approved', actor: 'system' },
    });
    expect(await isPublic(story)).toBe(true);
  });

  it('an audio file gets its length; its picture is left for the default-picture step', async () => {
    const { story, video } = await videoStory('audio');

    await applyMediaResult(
      workflow,
      ready(video, story, { width: 1280, height: 720 }),
    );

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

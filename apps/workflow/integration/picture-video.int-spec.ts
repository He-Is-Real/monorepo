import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  agreeAll,
  createPeople,
  draft,
  grantImage,
  grantUpload,
  rows,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import { BunnyLibrary, WRITER_BUNNY } from '../src/app/bunny';
import {
  answerJob,
  type MediaAnswer,
  THUMBNAIL_LOCK,
  type ThumbnailLock,
} from '../src/app/media-jobs';
import {
  MEDIA_QUEUE,
  type MediaJobMessage,
  type MediaQueue,
} from '../src/app/media-queue';
import { renderedJob, uploadPassFor } from '../src/app/render';

const LIBRARY = '424242';
const LIBRARY_KEY = 'library-key-for-tests';
const IMAGES_KEY = 'images-key-for-tests';
const IMAGES_HOST = 'images.example.b-cdn.net';
const SOUND_KEY = 'sound-key-for-tests';
const SOUND_HOST = 'sound.example.b-cdn.net';
/** T3's lock, as in production: 2 minutes, with 20 seconds for Bunny's calls. */
const LOCK_MS = 120_000;
const bunnyConfig = {
  libraryId: LIBRARY,
  imagesCdnHost: IMAGES_HOST,
  soundCdnHost: SOUND_HOST,
  libraryKey: async () => LIBRARY_KEY,
  imagesTokenKey: async () => IMAGES_KEY,
  soundTokenKey: async () => SOUND_KEY,
};

/**
 * Bunny's Stream API as the writer calls it, in memory: videos made, read and given a thumbnail.
 * The writer's real client and signing run against it; nothing reaches Bunny.
 */
class FakeStream {
  videos = new Map<string, { title: string; thumbnailFileName: string }>();
  thumbnailUrls: string[] = [];
  refuse = false;
  /** Holds a thumbnail call before Bunny takes it, while the promise it answers is pending. */
  hold?: (source: string) => Promise<void> | undefined;
  /** Holds a read of a video (after a thumbnail call Bunny took) the same way. */
  holdRead?: () => Promise<void> | undefined;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (headers.get('AccessKey') !== LIBRARY_KEY) return json(401, {});
    if (this.refuse) return json(500, {});
    const path = url.pathname.replace(`/library/${LIBRARY}/videos`, '');
    if (init?.method === 'POST' && path === '') {
      const guid = randomUUID();
      const { title } = JSON.parse(String(init.body)) as { title: string };
      this.videos.set(guid, { title, thumbnailFileName: 'thumbnail.jpg' });
      return json(200, { guid });
    }
    const [, id, action] = path.split('/');
    const video = this.videos.get(id);
    if (!video) return json(404, {});
    if (init?.method === 'POST' && action === 'thumbnail') {
      const source = url.searchParams.get('thumbnailUrl') ?? '';
      await this.hold?.(source);
      this.thumbnailUrls.push(source);
      video.thumbnailFileName =
        source === 'thumbnail_1.jpg'
          ? 'thumbnail_1.jpg'
          : 'thumbnail_9f8e7d6c.jpg';
      return json(200, {});
    }
    await this.holdRead?.();
    return json(200, { guid: id, ...video });
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * An audio story's picture video and a video's own picture at Bunny, through the result writer
 * against a real SurrealDB (Joel: audio-picture-video.html decisions 1B, 2 = K1 and 4,
 * 2026-11-07; video-bundle-rethink.html part A, 2026-11-06).
 */
describe('result writer: picture videos and Bunny’s picture', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;
  let pat: Surreal;
  let stream: FakeStream;
  let bunny: BunnyLibrary;
  let n = 0;

  const guid = () => randomUUID();
  const ready = (story: string, extra: Partial<MediaAnswer> = {}) =>
    ({
      outcome: 'ready',
      title: story,
      width: 1024,
      height: 1280,
      lengthSeconds: 95,
      thumbnailFileName: 'thumbnail.jpg',
      ...extra,
    }) as MediaAnswer;
  let clock = Date.parse('2026-11-08T10:00:00Z');
  const next = () => new Date((clock += 1000)).toISOString();
  /**
   * The writer's clock for T3's lock, moved only by the tests; it starts past every upload link's
   * cooldown, so approval is judged at it.
   */
  const writerClock = {
    at: Date.now() + 3 * 3600_000,
    advance(ms: number) {
      this.at += ms;
    },
  };
  const lock: ThumbnailLock = {
    lockMs: LOCK_MS,
    callMs: 20_000,
    now: () => writerClock.at,
  };

  const versionOf = async (story: string) =>
    (
      await rows<number>(
        migrator,
        `SELECT VALUE version FROM ONLY type::record('story', $story)`,
        { story },
      )
    )[0];
  const mediaOf = async (story: string) =>
    (
      await rows<string>(
        migrator,
        `SELECT VALUE <string> record::id(mediaFile) FROM ONLY type::record('story', $story)`,
        { story },
      )
    )[0];
  const file = async (key: string) =>
    (
      await rows(
        migrator,
        `SELECT format, processing, width, height, lengthSeconds, thumbnailPath, sizeBytes,
           contentType, detachedAt != NONE AS detached,
           (IF renderOf != NONE { <string> record::id(renderOf) }) ?? null AS renderOf,
           (IF thumbnailOf != NONE { <string> record::id(thumbnailOf) }) ?? null AS thumbnailOf,
           thumbnailLockedUntil != NONE AS locked
         FROM ONLY type::record('storyFile', $key)`,
        { key },
      )
    )[0];
  const openJob = async (key: string, kind: string) =>
    (
      await rows<{ id: string; reasons: string[] }>(
        migrator,
        `SELECT <string> record::id(id) AS id, reasons FROM mediaJob
           WHERE file = type::record('storyFile', $key) AND kind = $kind AND doneAt = NONE`,
        { key, kind },
      )
    )[0];
  const jobRow = async (id: string) =>
    (
      await rows(
        migrator,
        `SELECT outcome ?? null AS outcome,
           (IF madeFile != NONE { <string> record::id(madeFile) }) AS madeFile
         FROM ONLY type::record('mediaJob', $id)`,
        { id },
      )
    )[0];
  const failures = async (id: string) =>
    (
      await rows<number>(
        migrator,
        `SELECT VALUE failures FROM ONLY type::record('mediaJob', $id)`,
        { id },
      )
    )[0];
  /**
   * Whether a moderator's approval would be refused for the story's media: an open job, a lock
   * not run out or a file not fit to show (fn::story::approval_wait, judged at the writer's
   * clock, after the upload cooldown, and fn::story::approval_problem).
   */
  const approvalBlocked = async (story: string) => {
    const [r] = await rows<{ wait: string | null; problem: string | null }>(
      migrator,
      `LET $s = (SELECT * FROM ONLY type::record('story', $story));
       RETURN { wait: fn::story::approval_wait($s, <datetime> $now) ?? null,
         problem: fn::story::approval_problem($s) ?? null };`,
      { story, now: new Date(writerClock.at).toISOString() },
    );
    return r.wait !== null || r.problem !== null;
  };
  /** api-user's check job for a Bunny notice (fn::media::queue_job): its id. */
  const check = async (key: string, reason = 'bunny_finished') =>
    (
      await rows<{ job: string }>(
        apiUser,
        `RETURN fn::media::queue_job(type::record('storyFile', $key), 'check', $reason)`,
        { key, reason },
      )
    )[0].job;
  const upload = async (story: string, format: 'video' | 'audio') => {
    const video = guid();
    expect(
      await grantUpload(apiUser, {
        video,
        story,
        person: 'pat',
        version: await versionOf(story),
        format,
      }),
    ).toMatchObject({ ok: true });
    return video;
  };
  const picture = async (story: string) => {
    const name = (++n).toString(16).padStart(32, '0');
    expect(
      await grantImage(apiUser, {
        story,
        person: 'pat',
        version: await versionOf(story),
        name,
      }),
    ).toMatchObject({ ok: true });
    return `stories/${story}/${name}.webp`;
  };
  const newStory = async (format: 'video' | 'audio') => {
    const story = `pv_${++n}`;
    await draft(pat, story, { primaryFormat: format, body: undefined });
    return story;
  };
  /** The story's audio file found ready at Bunny: the render job the writer opened. */
  const audioReady = async (story: string, audio: string) => {
    const r = await answerJob(
      workflow,
      await check(audio),
      audio,
      ready(story),
      next(),
    );
    expect(r.outcome).toBe('applied');
    expect(r.render).toMatchObject({ kind: 'render', story, video: audio });
    return (r.render as { job: string }).job;
  };
  /** The worker's whole render: the pass, then "done" with the picture it was given. */
  const render = async (job: string, from: string) => {
    const pass = await uploadPassFor(workflow, bunny, job, from);
    if (pass.outcome !== 'render')
      throw new Error(`no render: ${pass.outcome}`);
    const done = await renderedJob(workflow, job, from, {
      renderVideoId: pass.renderVideoId,
      picture: pass.picture,
      sizeBytes: 207_000,
    });
    return { pass, done };
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    workflow = await t.service('workflow');
    await createPeople(t, { pat: 'user_pat' });
    await trustSubmitters(t, 'pat');
    await rows(
      migrator,
      `UPDATE submitterLimits:pat SET openDraftsMax = 100, uploadRequestsPerHour = 100`,
    );
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  beforeEach(() => {
    stream = new FakeStream();
    bunny = new BunnyLibrary(bunnyConfig, stream.fetch);
  });
  afterAll(() => t?.close());

  describe('the render decision', () => {
    it('an audio upload Bunny hasn’t finished yet: nothing to make until its check finds it ready', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      await picture(story); // a render job, written by the picture change
      const { id } = await openJob(audio, 'render');
      expect(await uploadPassFor(workflow, bunny, id, audio)).toEqual({
        outcome: 'stale',
      });
      expect(stream.videos.size).toBe(0);
    });

    it('a ready audio upload isn’t ready itself: the writer opens its picture video, with the check’s reasons', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const job = await audioReady(story, audio);
      expect(await file(audio)).toMatchObject({
        processing: 'processing',
        lengthSeconds: 95,
      });
      expect(await openJob(audio, 'render')).toEqual({
        id: job,
        reasons: ['bunny_finished'],
      });
    });

    it('a picture video made with the story’s picture needs no other', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const { done } = await render(await audioReady(story, audio), audio);
      const made = await mediaOf(story);
      expect(done.outcome).toBe('applied');
      const r = await answerJob(
        workflow,
        (done.check as { job: string }).job,
        made,
        ready(story),
        next(),
      );
      expect(r).toEqual({ outcome: 'applied', render: null, thumbnail: null });
      expect(await file(made)).toMatchObject({
        processing: 'ready',
        width: 1024,
        height: 1280,
        thumbnailPath: `${made}/thumbnail.jpg`,
      });
    });
  });

  describe('the pass (K1) and the new video (1B)', () => {
    it('makes a new video titled with the story’s id, and passes an hour’s upload to that one video only', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const job = await audioReady(story, audio);
      const before = Math.floor(Date.now() / 1000);
      const pass = await uploadPassFor(workflow, bunny, job, audio);
      const after = Math.floor(Date.now() / 1000);
      if (pass.outcome !== 'render') throw new Error(pass.outcome);

      expect([...stream.videos]).toEqual([
        [pass.renderVideoId, expect.objectContaining({ title: story })],
      ]);
      expect(await jobRow(job)).toEqual({
        outcome: null,
        madeFile: pass.renderVideoId,
      });
      const expires = Number(pass.upload.headers.AuthorizationExpire);
      expect(expires).toBeGreaterThanOrEqual(before + 3600);
      expect(expires).toBeLessThanOrEqual(after + 3600);
      expect(pass.upload).toEqual({
        uploadUrl: 'https://video.bunnycdn.com/tusupload',
        headers: {
          VideoId: pass.renderVideoId,
          LibraryId: LIBRARY,
          AuthorizationExpire: String(expires),
          AuthorizationSignature: createHash('sha256')
            .update(`${LIBRARY}${LIBRARY_KEY}${expires}${pass.renderVideoId}`)
            .digest('hex'),
        },
        expiresAt: new Date(expires * 1000).toISOString(),
      });
      // No picture: the worker uses the site's default background.
      expect(pass).toMatchObject({ picture: null, pictureUrl: null });
      // A retry gets the same video, not a second one.
      const again = await uploadPassFor(workflow, bunny, job, audio);
      expect(again).toMatchObject({ renderVideoId: pass.renderVideoId });
      expect(stream.videos.size).toBe(1);
    });

    it('with the story’s picture: its path and a 10-minute link to it', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const path = await picture(story);
      const job = await audioReady(story, audio);
      // Seconds, as the link's expiry is: it was signed between these two.
      const before = Math.floor(Date.now() / 1000);
      const pass = await uploadPassFor(workflow, bunny, job, audio);
      const after = Math.floor(Date.now() / 1000);
      if (pass.outcome !== 'render') throw new Error(pass.outcome);
      expect(pass.picture).toBe(path);
      const link = new URL(pass.pictureUrl as string);
      expect(`${link.host}${link.pathname}`).toBe(`${IMAGES_HOST}/${path}`);
      const expires = Number(link.searchParams.get('expires'));
      expect(expires).toBeGreaterThanOrEqual(before + 600);
      expect(expires).toBeLessThanOrEqual(after + 600);
    });

    it('done: the new row, the story moved to it without a new version, the audio file detached, its check opened', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const path = await picture(story);
      const job = await audioReady(story, audio);
      const version = await versionOf(story);
      const { pass, done } = await render(job, audio);
      if (pass.outcome !== 'render') throw new Error(pass.outcome);
      const made = pass.renderVideoId;

      expect(done).toEqual({
        outcome: 'applied',
        check: expect.objectContaining({ kind: 'check', story, video: made }),
      });
      expect(await mediaOf(story)).toBe(made);
      expect(await versionOf(story)).toBe(version);
      expect(await file(made)).toMatchObject({
        format: 'audio',
        contentType: 'video/mp4',
        sizeBytes: 207_000,
        renderOf: audio,
        thumbnailOf: path,
        detached: false,
      });
      expect(await file(audio)).toMatchObject({ detached: true });
      expect(await openJob(made, 'check')).toMatchObject({
        reasons: ['rendered'],
      });
      expect(await jobRow(job)).toEqual({ outcome: 'applied', madeFile: made });
    });

    it('a new recording uploaded meanwhile wins: the picture video is dropped', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const job = await audioReady(story, audio);
      const pass = await uploadPassFor(workflow, bunny, job, audio);
      if (pass.outcome !== 'render') throw new Error(pass.outcome);
      const newer = await upload(story, 'audio');

      expect(
        await renderedJob(workflow, job, audio, {
          renderVideoId: pass.renderVideoId,
          picture: null,
          sizeBytes: 1000,
        }),
      ).toEqual({ outcome: 'gone', check: null });
      expect(await mediaOf(story)).toBe(newer);
      expect(await file(pass.renderVideoId)).toBeUndefined();
    });

    it('the picture changed after the picture video: a new one is made from it, and the story moves on', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const { done } = await render(await audioReady(story, audio), audio);
      const first = await mediaOf(story);
      await answerJob(
        workflow,
        (done.check as { job: string }).job,
        first,
        ready(story),
        next(),
      );

      const path = await picture(story);
      const { id } = await openJob(first, 'render');
      const second = await render(id, first);
      if (second.pass.outcome !== 'render')
        throw new Error(second.pass.outcome);
      expect(second.pass.picture).toBe(path);
      expect(await mediaOf(story)).toBe(second.pass.renderVideoId);
      expect(await file(second.pass.renderVideoId)).toMatchObject({
        renderOf: first,
        thumbnailOf: path,
      });
      expect(await file(first)).toMatchObject({ detached: true });
    });

    it('refuses a "done" for any video but the one the pass was for', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const job = await audioReady(story, audio);
      await uploadPassFor(workflow, bunny, job, audio);
      await expect(
        renderedJob(workflow, job, audio, {
          renderVideoId: guid(),
          picture: null,
          sizeBytes: 1000,
        }),
      ).rejects.toThrow(/picture video/);
      expect(await mediaOf(story)).toBe(audio);
    });
  });

  describe('the routes the worker calls', () => {
    let app: INestApplication;
    let url: string;
    const published: MediaJobMessage[] = [];
    const queue: MediaQueue = {
      publish: async (job) => {
        published.push(job);
      },
    };
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    beforeAll(async () => {
      stream = new FakeStream();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SURREAL)
        .useValue(workflow)
        .overrideProvider(SECRET_MANAGER_CLIENT)
        .useValue({})
        .overrideProvider(SECRETS_PROJECT)
        .useValue('test-project')
        .overrideProvider(WRITER_BUNNY)
        .useFactory({
          factory: () =>
            new BunnyLibrary(bunnyConfig, (input, init) =>
              stream.fetch(input, init),
            ),
        })
        .overrideProvider(MEDIA_QUEUE)
        .useValue(queue)
        .overrideProvider(THUMBNAIL_LOCK)
        .useValue(lock)
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.listen(0);
      url = await app.getUrl();
    });
    afterAll(() => app?.close());

    it('answer → render job sent; upload-pass → the pass; rendered → the new video’s check sent', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      published.length = 0;
      const job = await check(audio);

      expect(
        await post(`/v1/media-jobs/${job}/answer`, {
          videoId: audio,
          ...ready(story),
        }),
      ).toEqual({ status: 200, body: { outcome: 'applied' } });
      const renderJob = (await openJob(audio, 'render')).id;
      expect(published).toEqual([
        { jobId: renderJob, kind: 'render', videoId: audio },
      ]);

      const pass = await post(`/v1/media-jobs/${renderJob}/upload-pass`, {
        videoId: audio,
      });
      expect(pass).toMatchObject({
        status: 200,
        body: { outcome: 'render', picture: null, pictureUrl: null },
      });
      const made = pass.body.renderVideoId as string;
      expect(pass.body.upload.headers.VideoId).toBe(made);

      expect(
        await post(`/v1/media-jobs/${renderJob}/rendered`, {
          videoId: audio,
          renderVideoId: made,
          picture: null,
          sizeBytes: 1234,
        }),
      ).toEqual({ status: 200, body: { outcome: 'applied' } });
      expect(published.at(-1)).toEqual({
        jobId: (await openJob(made, 'check')).id,
        kind: 'check',
        videoId: made,
      });
      // Called again (the worker's retry): the job's outcome, nothing written twice.
      expect(
        await post(`/v1/media-jobs/${renderJob}/upload-pass`, {
          videoId: audio,
        }),
      ).toEqual({ status: 200, body: { outcome: 'applied' } });
    });

    it('a video’s own picture goes to Bunny with every ready answer; taken off, Bunny’s frame comes back', async () => {
      const story = await newStory('video');
      const video = await upload(story, 'video');
      const path = await picture(story);
      stream.videos.set(video, {
        title: story,
        thumbnailFileName: 'thumbnail.jpg',
      });

      expect(
        await post(`/v1/media-jobs/${await check(video)}/answer`, {
          videoId: video,
          ...ready(story),
        }),
      ).toEqual({ status: 200, body: { outcome: 'applied' } });
      const sent = new URL(stream.thumbnailUrls.at(-1) as string);
      expect(`${sent.host}${sent.pathname}`).toBe(`${IMAGES_HOST}/${path}`);
      expect(await file(video)).toMatchObject({
        processing: 'ready',
        thumbnailOf: path,
        thumbnailPath: `${video}/thumbnail_9f8e7d6c.jpg`,
      });

      // Set again, even though the database says Bunny already shows it.
      const calls = stream.thumbnailUrls.length;
      await post(`/v1/media-jobs/${await check(video)}/answer`, {
        videoId: video,
        ...ready(story, { thumbnailFileName: 'thumbnail_9f8e7d6c.jpg' }),
      });
      expect(stream.thumbnailUrls).toHaveLength(calls + 1);
      expect(await file(video)).toMatchObject({ thumbnailOf: path });

      await rows(pat, `UPDATE type::record('story', $story) SET image = NONE`, {
        story,
      });
      await post(`/v1/media-jobs/${await check(video)}/answer`, {
        videoId: video,
        ...ready(story),
      });
      expect(stream.thumbnailUrls.at(-1)).toBe('thumbnail_1.jpg');
      expect(await file(video)).toMatchObject({
        thumbnailOf: null,
        thumbnailPath: `${video}/thumbnail_1.jpg`,
      });
    });

    it('Bunny took a picture whose database write then failed, and the picture was taken off: the next check puts Bunny’s frame back', async () => {
      const story = await newStory('video');
      const video = await upload(story, 'video');
      const path = await picture(story);
      stream.videos.set(video, {
        title: story,
        thumbnailFileName: 'thumbnail.jpg',
      });
      // An earlier answer's Bunny call went through, then its transaction failed: Bunny shows
      // the picture, the database still says it doesn't (thumbnailOf NONE).
      await bunny.setThumbnail(video, path);
      expect(stream.videos.get(video)?.thumbnailFileName).toBe(
        'thumbnail_9f8e7d6c.jpg',
      );
      expect(await file(video)).toMatchObject({ thumbnailOf: null });

      await rows(pat, `UPDATE type::record('story', $story) SET image = NONE`, {
        story,
      });
      expect(
        await post(`/v1/media-jobs/${await check(video)}/answer`, {
          videoId: video,
          ...ready(story),
        }),
      ).toEqual({ status: 200, body: { outcome: 'applied' } });
      expect(stream.thumbnailUrls.at(-1)).toBe('thumbnail_1.jpg');
      expect(stream.videos.get(video)?.thumbnailFileName).toBe(
        'thumbnail_1.jpg',
      );
      expect(await file(video)).toMatchObject({
        thumbnailOf: null,
        thumbnailPath: `${video}/thumbnail_1.jpg`,
      });
    });

    /** A gate a fake Bunny call waits at: `reached` once the call is there, until `open()`. */
    const gate = () => {
      let reached!: () => void;
      let open!: () => void;
      const at = new Promise<void>((r) => (reached = r));
      const opened = new Promise<void>((r) => (open = r));
      return { at, open, wait: () => (reached(), opened) };
    };
    const picturesSent = () =>
      stream.thumbnailUrls.map((u) =>
        u === 'thumbnail_1.jpg' ? 'frame' : new URL(u).pathname.slice(1),
      );
    const videoStory = async () => {
      const story = await newStory('video');
      const video = await upload(story, 'video');
      const path = await picture(story);
      stream.videos.set(video, {
        title: story,
        thumbnailFileName: 'thumbnail.jpg',
      });
      return { story, video, path };
    };
    const takePictureOff = (story: string) =>
      rows(pat, `UPDATE type::record('story', $story) SET image = NONE`, {
        story,
      });

    /** A moderator's approval would be refused at every step below (judged at the writer's clock). */
    const blocked = async (story: string) => {
      expect(await approvalBlocked(story)).toBe(true);
    };
    /** Holds the next call setting a story picture (not Bunny's frame) at Bunny. */
    const holdPicture = () => {
      const atBunny = gate();
      stream.hold = (source) => {
        if (source === 'thumbnail_1.jpg') return undefined;
        stream.hold = undefined;
        return atBunny.wait();
      };
      return atBunny;
    };
    const answer = (job: string, video: string, story: string) =>
      post(`/v1/media-jobs/${job}/answer`, { videoId: video, ...ready(story) });
    const retry = { status: 200, body: { retry: true } };
    const applied = { status: 200, body: { outcome: 'applied' } };

    it('Codex round 2: a second delivery while the first is setting the picture waits for the lock; the first puts Bunny right', async () => {
      const { story, video, path } = await videoStory();
      // Delivery A takes the lock, reads picture P, and its call to Bunny waits.
      const atBunny = holdPicture();
      const job = await check(video);
      const a = answer(job, video, story);
      await atBunny.at;
      expect(await file(video)).toMatchObject({
        locked: true,
        thumbnailOf: null,
      });
      await blocked(story);

      // The picture is taken off; delivery B of the same job finds the lock held: "try again
      // later", without calling Bunny.
      await takePictureOff(story);
      expect(await check(video)).toBe(job);
      expect(await answer(job, video, story)).toEqual(retry);
      expect(picturesSent()).toEqual([]);
      expect(await openJob(video, 'check')).toMatchObject({ id: job });
      await blocked(story);

      // A's P lands, A finds the picture gone, sends Bunny's frame under the same lock, records
      // it and closes the job.
      atBunny.open();
      expect(await a).toEqual(applied);
      expect(picturesSent()).toEqual([path, 'frame']);
      expect(stream.videos.get(video)?.thumbnailFileName).toBe(
        'thumbnail_1.jpg',
      );
      expect(await file(video)).toMatchObject({
        locked: false,
        thumbnailOf: null,
        thumbnailPath: `${video}/thumbnail_1.jpg`,
      });
      expect(await openJob(video, 'check')).toBeUndefined();
      expect(await approvalBlocked(story)).toBe(false);
    });

    it('Codex round 4 (1): a third delivery can’t close the job while the first is still talking to Bunny', async () => {
      const { story, video, path } = await videoStory();
      const atBunny = holdPicture();
      const job = await check(video);
      const a = answer(job, video, story);
      await atBunny.at;
      await takePictureOff(story);
      // Deliveries B and C: both wait for the lock; the job stays open.
      expect(await answer(job, video, story)).toEqual(retry);
      expect(await answer(job, video, story)).toEqual(retry);
      expect(await openJob(video, 'check')).toMatchObject({ id: job });
      expect(picturesSent()).toEqual([]);
      await blocked(story);

      atBunny.open();
      expect(await a).toEqual(applied);
      expect(picturesSent()).toEqual([path, 'frame']);
      expect(await approvalBlocked(story)).toBe(false);

      // C comes back after A ended the job: it opens a check of the file first, then sets
      // Bunny again under the lock and closes it.
      expect(await answer(job, video, story)).toEqual(applied);
      expect(picturesSent()).toEqual([path, 'frame', 'frame']);
      expect(await openJob(video, 'check')).toBeUndefined();
      expect(await approvalBlocked(story)).toBe(false);
    });

    it('Codex round 4 (2): a redelivery of an ended job opens a check before Bunny; Bunny refusing leaves it open until a later delivery', async () => {
      const { story, video, path } = await videoStory();
      const job = await check(video);
      expect(await answer(job, video, story)).toEqual(applied);
      expect(await openJob(video, 'check')).toBeUndefined();
      await takePictureOff(story);

      // The redelivery: Bunny refuses. A check of the file is open (with the job's reasons), no
      // failure counted, and the lock is left to run out.
      stream.refuse = true;
      try {
        expect(await answer(job, video, story)).toEqual(retry);
      } finally {
        stream.refuse = false;
      }
      const reopened = await openJob(video, 'check');
      expect(reopened).toMatchObject({ reasons: ['bunny_finished'] });
      expect(await failures(reopened.id)).toBe(0);
      expect(await file(video)).toMatchObject({
        locked: true,
        thumbnailOf: path,
      });
      await blocked(story);

      // Until the lock runs out, another delivery waits.
      expect(await answer(reopened.id, video, story)).toEqual(retry);
      await blocked(story);
      expect(picturesSent()).toEqual([path]);

      writerClock.advance(LOCK_MS);
      await blocked(story);
      expect(await answer(reopened.id, video, story)).toEqual(applied);
      expect(picturesSent()).toEqual([path, 'frame']);
      expect(await file(video)).toMatchObject({
        locked: false,
        thumbnailOf: null,
      });
      expect(await openJob(video, 'check')).toBeUndefined();
      expect(await approvalBlocked(story)).toBe(false);
    });

    it('a lock that runs out during the call: the late writer records nothing and leaves the job open', async () => {
      const { story, video, path } = await videoStory();
      const atBunny = holdPicture();
      const job = await check(video);
      const a = answer(job, video, story);
      await atBunny.at;
      await takePictureOff(story);

      // A's lock runs out while its call waits; B takes it and puts Bunny's frame.
      writerClock.advance(LOCK_MS);
      await blocked(story);
      expect(await answer(job, video, story)).toEqual(applied);
      expect(picturesSent()).toEqual(['frame']);
      expect(await openJob(video, 'check')).toBeUndefined();

      // A's P lands late (Bunny applying it more than the margin after we gave up is the one
      // assumption T3 keeps); A no longer holds the lock, so it records nothing: "try again".
      atBunny.open();
      expect(await a).toEqual(retry);
      expect(picturesSent()).toEqual(['frame', path]);
      expect(await file(video)).toMatchObject({
        locked: false,
        thumbnailOf: null,
      });
    });

    it('a redelivery of an ended job sets Bunny’s picture again before it is acknowledged', async () => {
      const { story, video, path } = await videoStory();
      const job = await check(video);
      expect(await answer(job, video, story)).toEqual(applied);
      // Bunny lost the picture somehow (a failed write after Bunny took another, say).
      await bunny.setThumbnail(video, null);
      expect(await answer(job, video, story)).toEqual(applied);
      expect(picturesSent().at(-1)).toBe(path);
      expect(stream.videos.get(video)?.thumbnailFileName).toBe(
        'thumbnail_9f8e7d6c.jpg',
      );
      expect(await openJob(video, 'check')).toBeUndefined();
    });

    it('Bunny refusing the picture keeps the job open and counts no failure: "try again later"', async () => {
      const { story, video } = await videoStory();
      const job = await check(video);
      stream.refuse = true;
      try {
        expect(await answer(job, video, story)).toEqual(retry);
      } finally {
        stream.refuse = false;
      }
      expect(await file(video)).toMatchObject({
        locked: true,
        thumbnailOf: null,
      });
      expect(await openJob(video, 'check')).toMatchObject({ id: job });
      expect(await failures(job)).toBe(0);
      await blocked(story);
    });

    it('sound-link: a 2-minute link to the one MP4 copy asked for, only after the pass, and nothing once the job has ended', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const job = await check(audio);
      await post(`/v1/media-jobs/${job}/answer`, {
        videoId: audio,
        ...ready(story),
      });
      const renderJob = (await openJob(audio, 'render')).id;
      const link = (height: unknown) =>
        post(`/v1/media-jobs/${renderJob}/sound-link`, {
          videoId: audio,
          height,
        });
      // Not before the pass: the worker asks for the sound only once it is making the video.
      expect(await link(720)).toMatchObject({ status: 400 });

      const pass = await post(`/v1/media-jobs/${renderJob}/upload-pass`, {
        videoId: audio,
      });
      const before = Math.floor(Date.now() / 1000);
      const reply = await link(720);
      const after = Math.floor(Date.now() / 1000);
      expect(reply).toMatchObject({ status: 200, body: { outcome: 'sound' } });
      const url = new URL(reply.body.url as string);
      expect(`${url.host}${url.pathname}`).toBe(
        `${SOUND_HOST}/${audio}/play_720p.mp4`,
      );
      const expires = Number(url.searchParams.get('expires'));
      expect(expires).toBeGreaterThanOrEqual(before + 120);
      expect(expires).toBeLessThanOrEqual(after + 120);
      expect(url.searchParams.get('token')).toBe(
        `HS256-${createHmac('sha256', SOUND_KEY)
          .update(`/${audio}/play_720p.mp4${expires}`)
          .digest('base64url')}`,
      );
      // A height Bunny doesn't make, or another video than the job's: refused.
      expect(await link(721)).toMatchObject({ status: 400 });
      expect(
        await post(`/v1/media-jobs/${renderJob}/sound-link`, {
          videoId: guid(),
          height: 720,
        }),
      ).toMatchObject({
        status: 400,
        body: expect.objectContaining({ code: 'video_mismatch' }),
      });

      await post(`/v1/media-jobs/${renderJob}/rendered`, {
        videoId: audio,
        renderVideoId: pass.body.renderVideoId,
        picture: null,
        sizeBytes: 1234,
      });
      expect(await link(720)).toEqual({
        status: 200,
        body: { outcome: 'applied' },
      });
    });

    it('400 for a "done" naming another video than the pass’s', async () => {
      const story = await newStory('audio');
      const audio = await upload(story, 'audio');
      const job = await check(audio);
      await post(`/v1/media-jobs/${job}/answer`, {
        videoId: audio,
        ...ready(story),
      });
      const renderJob = (await openJob(audio, 'render')).id;
      await post(`/v1/media-jobs/${renderJob}/upload-pass`, { videoId: audio });
      expect(
        await post(`/v1/media-jobs/${renderJob}/rendered`, {
          videoId: audio,
          renderVideoId: guid(),
          picture: null,
          sizeBytes: 1,
        }),
      ).toMatchObject({
        status: 400,
        body: expect.objectContaining({ code: 'validation_failed' }),
      });
    });
  });
});

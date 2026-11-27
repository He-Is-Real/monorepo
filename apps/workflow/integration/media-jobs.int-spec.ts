import {
  agreeAll,
  createPeople,
  draft,
  grantUpload,
  loadApproval,
  rows,
  submit,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
import { wideEvents } from '@heisreal/http';
import { LOG_SINKS, type LogSink } from '@heisreal/logging/event';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';
import {
  answerJob as writeAnswer,
  InvalidMediaJobCall,
  MAX_FAILURES,
  ANSWER_SQL,
  answerFailed,
  answerVars,
  failJob,
  MediaJobNotFound,
  MediaJobWrongVideo,
  parseFailure,
  parseMediaAnswer,
  type WriterAnswer,
} from '../src/app/media-jobs';
import { BunnyCallFailed, type BunnyVideoStatus } from '../src/app/bunny';

/** The writer's answer, as its outcome (the render jobs it opens: picture-video.int-spec.ts). */
const answerJob = async (...args: Parameters<typeof writeAnswer>) =>
  (await writeAnswer(...args)).outcome;

/**
 * The result writer (media-worker-final.html) against a real SurrealDB, signed in as
 * service:workflow. What matters is what it writes: the storyFile row of the job's file, only
 * while its story still shows it and only if no newer answer is in, together with the job's end,
 * in one transaction; failures counted until the job gives up; and the database's own rules
 * then hide an approved story whose video failed and show it again once it's ready.
 */
describe('result writer: the worker’s answers → the job’s file row and the job', () => {
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
    story: string,
    extra: Record<string, unknown> = {},
  ): WriterAnswer =>
    ({
      outcome: 'ready',
      title: story,
      width: 1080,
      height: 1920,
      lengthSeconds: 95,
      thumbnailFileName: 'thumbnail.jpg',
      ...extra,
    }) as WriterAnswer;

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
   * When each answer reached the writer: by default each a second after the last, as the worker's
   * calls would arrive one after another.
   */
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const next = () => new Date((clock += 1000)).toISOString();
  /** api-user's write when Bunny's notice comes (fn::media::queue_job): the job's id. */
  const queue = async (video: string, reason = 'bunny_finished') =>
    (
      await rows<{ job: string }>(
        apiUser,
        `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', $reason)`,
        { video, reason },
      )
    )[0].job;
  /** A new job for `video`, answered. */
  const answer = async (
    video: string,
    result: WriterAnswer,
    arrivedAt = next(),
  ) => answerJob(workflow, await queue(video), video, result, arrivedAt);
  const job = async (id: string) =>
    (
      await rows(
        migrator,
        `SELECT reasons, sends, failures, lastError, outcome, errorType, doneAt != NONE AS done
         FROM ONLY type::record('mediaJob', $id)`,
        { id },
      )
    )[0];
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

  it('marks that video’s row ready with Bunny’s facts and ends the job as applied', async () => {
    const mine = await videoStory();
    const other = await videoStory();
    const id = await queue(mine.video);

    expect(
      await answerJob(workflow, id, mine.video, ready(mine.story), next()),
    ).toBe('applied');

    expect(await file(mine.video)).toEqual({
      processing: 'ready',
      width: 1080,
      height: 1920,
      lengthSeconds: 95,
      // A person's video's thumbnailPath is api-user's, at send (RE-2 B): never the writer's.
    });
    expect(await file(other.video)).toEqual({});
    expect(await job(id)).toEqual({
      reasons: ['bunny_finished'],
      sends: 0,
      failures: 0,
      outcome: 'applied',
      done: true,
    });
  });

  it('the same answer again changes nothing; the job keeps its outcome', async () => {
    const { story, video } = await videoStory();
    const id = await queue(video);
    const at = next();
    await answerJob(workflow, id, video, ready(story), at);
    const before = await storyRow(story);

    // The queue delivered the job twice, and the second answer reached the writer at the same time.
    expect(await answerJob(workflow, id, video, ready(story), at)).toBe(
      'stale',
    );
    expect(await storyRow(story)).toEqual(before);
    // A later answer with the same facts records only its time; the story doesn't change.
    const later = next();
    expect(await answerJob(workflow, id, video, ready(story), later)).toBe(
      'applied',
    );
    expect(await storyRow(story)).toEqual(before);
    expect(await checkedAt(video)).toBe(later);
    expect(await job(id)).toMatchObject({ outcome: 'applied', done: true });
  });

  describe('an older answer never undoes a newer one (Joel, 2026-11-07, F1)', () => {
    it('ready, then gone, then an answer that arrived before the gone: the story stays hidden', async () => {
      const { story, video } = await videoStory();
      const readyAt = next();
      await answer(video, ready(story), readyAt);
      await submit(pat, story);
      // Uploaded moments ago, which no moderator may approve yet (decision 5, G11 B): the
      // approval is loaded as given.
      await loadApproval(migrator, story);
      const goneAt = next();
      await answer(video, { outcome: 'gone' }, goneAt);
      expect(await isPublic(story)).toBe(false);

      const late = await queue(video);
      expect(
        await answerJob(workflow, late, video, ready(story), readyAt),
      ).toBe('stale');
      expect(await job(late)).toMatchObject({ outcome: 'stale', done: true });
      expect((await file(video))['processing']).toBe('processing');
      expect(await checkedAt(video)).toBe(goneAt);
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'hidden', hiddenReason: 'media_unavailable' },
      });
      expect(await isPublic(story)).toBe(false);
    });

    it('overlapping answers: an older one committing in between can’t win (round 3 fix)', async () => {
      const { story, video } = await videoStory();
      const first = await queue(video);
      const olderAt = next();
      const newerAt = next();
      // The newer answer ("ready") reads and writes inside its transaction...
      const tx = await workflow.beginTransaction();
      await tx
        .query(ANSWER_SQL, answerVars(first, video, ready(story), newerAt))
        .collect();
      // ...while an older one ("encoding", from an earlier job's check) commits in between.
      const second = await queue(video, 'bunny_failed');
      expect(second).toBe(first); // the same open job: one per file and kind
      await expect(
        answerJob(workflow, first, video, { outcome: 'encoding' }, olderAt),
      ).resolves.toBe('applied');
      // The newer answer's commit conflicts; the writer re-runs it, which then applies it.
      await expect(tx.commit()).rejects.toThrow(/conflict/i);
      expect(
        await answerJob(workflow, first, video, ready(story), newerAt),
      ).toBe('applied');
      expect((await file(video))['processing']).toBe('ready');
      expect(await checkedAt(video)).toBe(newerAt);

      // The other order: the newer one commits first, then the older one is stale.
      const third = await queue(video);
      expect(
        await answerJob(
          workflow,
          third,
          video,
          { outcome: 'encoding' },
          olderAt,
        ),
      ).toBe('stale');
      expect((await file(video))['processing']).toBe('ready');
      expect(await job(third)).toMatchObject({ outcome: 'stale' });
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
      await answer(video, { outcome: 'encoding' }, '2026-12-01T00:00:00.000Z');
      expect(await checkedAt(video)).toBe('2026-12-01T00:00:00.000Z');
    });
  });

  it('a replaced video, or a ready answer titled with another story’s id, ends the job as gone', async () => {
    const { story, video: old } = await videoStory();
    const oldJob = await queue(old);
    const current = await replace(story);

    expect(await answerJob(workflow, oldJob, old, ready(story), next())).toBe(
      'gone',
    );
    expect(await job(oldJob)).toMatchObject({ outcome: 'gone', done: true });
    expect((await file(old))['processing']).toBeUndefined();
    // Titled with another story's id (D69): not this story's video.
    expect(await answer(current, ready('someone_else'))).toBe('gone');
    expect(await file(current)).not.toHaveProperty('processing');
  });

  it('records still encoding, failed (RE-1 A: at once, no re-encode), and gone (deleted at Bunny)', async () => {
    const encoding = await videoStory();
    const unusable = await videoStory();
    const gone = await videoStory();

    expect(await answer(encoding.video, { outcome: 'encoding' })).toBe(
      'applied',
    );
    const last = await queue(unusable.video);
    expect(
      await answerJob(
        workflow,
        last,
        unusable.video,
        { outcome: 'failed' },
        next(),
      ),
    ).toBe('gave_up');
    const lost = await queue(gone.video);
    expect(
      await answerJob(workflow, lost, gone.video, { outcome: 'gone' }, next()),
    ).toBe('gave_up');

    expect((await file(encoding.video))['processing']).toBe('processing');
    // Part 1a, RE-1 A: Bunny's failure makes the file failed at once, and the job says why.
    expect((await file(unusable.video))['processing']).toBe('failed');
    expect(await job(last)).toMatchObject({
      outcome: 'gave_up',
      errorType: 'file_unusable',
    });
    // A video Bunny no longer has is never the person's fault.
    expect((await file(gone.video))['processing']).toBe('processing');
    expect(await job(lost)).toMatchObject({
      outcome: 'gave_up',
      errorType: 'other',
      lastError: 'bunny_video_gone',
    });
  });

  it('a published story hides while Bunny has lost its video and comes back when it is ready again', async () => {
    const { story, video } = await videoStory();
    await answer(video, ready(story));
    await submit(pat, story);
    // Uploaded moments ago, which no moderator may approve yet (decision 5, G11 B): the
    // approval is loaded as given.
    await loadApproval(migrator, story);
    expect(await isPublic(story)).toBe(true);

    await answer(video, { outcome: 'gone' });
    expect(await storyRow(story)).toMatchObject({
      current: {
        status: 'hidden',
        actor: 'system',
        hiddenReason: 'media_unavailable',
      },
    });
    expect(await isPublic(story)).toBe(false);

    // Back at Bunny (docs/media-runbook.md): ready again, maybe with another frame.
    await answer(video, ready(story, { thumbnailFileName: 'thumbnail_2.jpg' }));
    expect(await storyRow(story)).toMatchObject({
      current: { status: 'approved', actor: 'system' },
    });
    expect(await isPublic(story)).toBe(true);
  });

  it('a person’s audio file gets its length but isn’t ready: its picture video is made next (1B)', async () => {
    const { story, video } = await videoStory('audio');

    await answer(video, ready(story, { width: 1280, height: 720 }));

    expect(await file(video)).toEqual({
      processing: 'processing',
      lengthSeconds: 95,
    });
  });

  // Part 1a (Joel, 2026-11-10): the worker's "failed" is believed only once Bunny tells the writer
  // the same; then the file is unusable and the story goes back at once (RE-1 A, Joel,
  // 2026-11-17: no automatic re-encode). Bunny is a fake here: what matters is what's written.
  // Codex review r6 (P1-9, Joel, 2026-11-14: "Retries must be capped"): a queue copy delivered
  // late, after a waiting story's check and its 3 nightly retries gave up on our side, never
  // opens a render: "a problem on our side" stays.
  describe('a late redelivery after the nightly retries are used', () => {
    const openJobs = (video: string) =>
      rows<string>(
        migrator,
        `SELECT VALUE <string> record::id(id) FROM mediaJob
           WHERE file = type::record('storyFile', $video) AND doneAt = NONE`,
        { video },
      );
    const giveUp = async (video: string) => {
      for (const id of await openJobs(video)) {
        await rows(
          workflow,
          `UPDATE type::record('mediaJob', $id) SET outcome = 'gave_up', doneAt = time::now(),
             errorType = 'other'`,
          { id },
        );
      }
    };
    const ours = async (video: string) =>
      (
        await rows<{ ours: boolean }>(
          admin,
          `RETURN fn::media::our_problem(type::record('storyFile', $video))`,
          { video },
        )
      )[0].ours;
    /** A sent story whose submit check and 3 nightly retries gave up: the first check's id. */
    const capped = async (format: 'video' | 'audio') => {
      const { story, video } = await videoStory(format);
      await submit(pat, story);
      const [first] = await openJobs(video);
      await giveUp(video);
      for (let night = 1; night <= 3; night++) {
        await rows(
          housekeeping,
          `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', 'resent')`,
          { video },
        );
        await giveUp(video);
      }
      expect(await ours(video)).toBe(true);
      return { story, video, first };
    };
    let housekeeping: Surreal;
    beforeAll(async () => {
      housekeeping = await t.service('housekeeping');
    });

    it('a ready audio file: no render of its picture video', async () => {
      const { story, video, first } = await capped('audio');
      const result = await writeAnswer(
        workflow,
        first,
        video,
        ready(story),
        next(),
      );
      expect(result.render).toBeNull();
      expect(await openJobs(video)).toEqual([]);
      expect(await ours(video)).toBe(true);
    });
  });

  describe('a "failed" answer (Part 1a)', () => {
    const fakeBunny = (status: BunnyVideoStatus | Error) => {
      const calls: string[] = [];
      return {
        calls,
        videoStatus: async (video: string) => {
          calls.push(`status ${video}`);
          if (status instanceof Error) throw status;
          return status;
        },
      };
    };
    const entries = async (story: string) =>
      rows<{ action: string; actor: string }>(
        migrator,
        `SELECT action, actor, at FROM storyStatusLog WHERE story = type::record('story', $story)
           ORDER BY at`,
        { story },
      );

    it('unless Bunny says failed too, nothing is written and the worker tries again later', async () => {
      const { video } = await videoStory();
      const id = await queue(video);
      for (const status of ['ready', 'encoding', 'gone'] as const) {
        const bunny = fakeBunny(status);
        expect(await answerFailed(workflow, bunny, id, video, next())).toEqual({
          retry: true,
        });
        expect(bunny.calls).toEqual([`status ${video}`]);
      }
      expect(await file(video)).toEqual({});
      expect(await job(id)).toMatchObject({ failures: 0, done: false });
    });

    it('asks Bunny nothing for a job that isn’t an open check of the video', async () => {
      const { video } = await videoStory();
      const other = (await videoStory()).video;
      const id = await queue(video);
      const bunny = fakeBunny('failed');
      await expect(
        answerFailed(workflow, bunny, id, other, next()),
      ).rejects.toThrow(MediaJobWrongVideo);
      await expect(
        answerFailed(
          workflow,
          bunny,
          '01KAAAAAAAAAAAAAAAAAAAAAAA',
          video,
          next(),
        ),
      ).rejects.toThrow(MediaJobNotFound);
      await failJob(workflow, id, video, 'bunny_unreachable');
      await writeAnswer(workflow, id, video, { outcome: 'encoding' }, next());
      expect(
        await answerFailed(workflow, bunny, id, video, next()),
      ).toMatchObject({ outcome: 'stale' });
      expect(bunny.calls).toEqual([]);
      expect(await file(other)).toEqual({});
    });

    it('a waiting story: Bunny’s failure sends it back at once (file_unusable), with no re-encode', async () => {
      const { story, video } = await videoStory();
      await submit(pat, story);
      const id = await queue(video, 'bunny_failed');
      const bunny = fakeBunny('failed');

      expect(
        await answerFailed(workflow, bunny, id, video, next()),
      ).toMatchObject({ outcome: 'gave_up' });
      expect(bunny.calls).toEqual([`status ${video}`]);
      expect((await file(video))['processing']).toBe('failed');
      expect(await job(id)).toMatchObject({
        outcome: 'gave_up',
        errorType: 'file_unusable',
      });
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'editing', actor: 'system' },
      });
      expect((await entries(story)).map((e) => e.action)).toEqual([
        'sent',
        'fileUnusable',
      ]);
      // No follow-up check is left open.
      expect(
        await rows(
          migrator,
          `SELECT VALUE id FROM mediaJob WHERE file = type::record('storyFile', $video)
             AND doneAt = NONE`,
          { video },
        ),
      ).toEqual([]);
    });

    it('a published story leaves the site and goes back to its owner at once (G2, RE-1 A)', async () => {
      const { story, video } = await videoStory();
      await answer(video, ready(story));
      await submit(pat, story);
      await loadApproval(migrator, story);
      expect(await isPublic(story)).toBe(true);
      const bunny = fakeBunny('failed');

      expect(
        await answerFailed(
          workflow,
          bunny,
          await queue(video, 'bunny_failed'),
          video,
          next(),
        ),
      ).toMatchObject({ outcome: 'gave_up' });
      expect(bunny.calls).toEqual([`status ${video}`]);
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'editing', actor: 'system' },
      });
      expect(await isPublic(story)).toBe(false);
      expect((await entries(story)).map((e) => e.action)).toEqual([
        'sent',
        'approved',
        'fileUnusable',
      ]);
    });

    it('a Bunny call that fails counts as the job’s failure (ours: bunny_unavailable at the third)', async () => {
      const { video } = await videoStory();
      const id = await queue(video);
      const bunny = fakeBunny(new BunnyCallFailed('bunny_unreachable'));
      for (let n = 1; n < MAX_FAILURES; n++) {
        expect(await answerFailed(workflow, bunny, id, video, next())).toEqual({
          retry: true,
        });
      }
      expect(await answerFailed(workflow, bunny, id, video, next())).toEqual({
        retry: false,
        outcome: 'gave_up',
      });
      expect(await job(id)).toMatchObject({
        errorType: 'bunny_unavailable',
      });
      expect(await file(video)).toEqual({});
    });
  });

  describe('failures (J4: the table replaces dead letters)', () => {
    it('says "try again" twice, then gives up on the third and drops later calls', async () => {
      const { video } = await videoStory();
      const id = await queue(video);

      for (let n = 1; n < MAX_FAILURES; n++) {
        expect(await failJob(workflow, id, video, 'bunny_unreachable')).toEqual(
          {
            retry: true,
          },
        );
      }
      expect(await job(id)).toMatchObject({
        failures: 2,
        lastError: 'bunny_unreachable',
        done: false,
      });
      expect(await failJob(workflow, id, video, 'bunny_timeout')).toEqual({
        retry: false,
        outcome: 'gave_up',
      });
      expect(await job(id)).toMatchObject({
        failures: 3,
        lastError: 'bunny_timeout',
        outcome: 'gave_up',
        // Part 1a: ours, never the file's.
        errorType: 'bunny_unavailable',
        done: true,
      });
      // Delivered again: nothing more is counted.
      expect(await failJob(workflow, id, video, 'bunny_timeout')).toEqual({
        retry: false,
        outcome: 'gave_up',
      });
      expect(await job(id)).toMatchObject({ failures: 3 });
      // The file is untouched; a new notice opens a new job.
      expect(await file(video)).toEqual({});
      expect(await queue(video)).not.toBe(id);
    });

    it('a job an answer already ended counts no failure', async () => {
      const { story, video } = await videoStory();
      const id = await queue(video);
      await answerJob(workflow, id, video, ready(story), next());

      expect(await failJob(workflow, id, video, 'bunny_unreachable')).toEqual({
        retry: false,
        outcome: 'applied',
      });
      expect(await job(id)).toMatchObject({ failures: 0 });
    });
  });

  describe('one open job per file and kind (J1 check a)', () => {
    it('a new reason joins the open job; once it has ended, the next opens a new one', async () => {
      const { story, video } = await videoStory();
      const id = await queue(video, 'bunny_finished');

      expect(await queue(video, 'bunny_deleted')).toBe(id);
      expect(await queue(video, 'bunny_finished')).toBe(id);
      expect(await job(id)).toMatchObject({
        reasons: ['bunny_finished', 'bunny_deleted'],
      });
      await answerJob(workflow, id, video, ready(story), next());

      const again = await queue(video, 'bunny_failed');
      expect(again).not.toBe(id);
      expect(await job(again)).toMatchObject({
        reasons: ['bunny_failed'],
        done: false,
      });
    });

    it('a second open job for the same file and kind is refused, whoever writes it', async () => {
      const { video } = await videoStory();
      await queue(video);
      for (const db of [apiUser, workflow]) {
        await expect(
          rows(
            db,
            `CREATE mediaJob CONTENT { file: type::record('storyFile', $video), kind: 'check',
               reasons: ['submitted'] }`,
            { video },
          ),
        ).rejects.toThrow(/media_job_open/);
      }
      expect(
        await rows(
          migrator,
          `SELECT VALUE id FROM mediaJob WHERE file = type::record('storyFile', $video)`,
          { video },
        ),
      ).toHaveLength(1);
    });
  });

  it('a job that doesn’t exist (gone with its file) is not found', async () => {
    await expect(
      answerJob(
        workflow,
        '01JC0000000000000000000000',
        guid(),
        { outcome: 'gone' },
        next(),
      ),
    ).rejects.toThrow(MediaJobNotFound);
    await expect(
      failJob(
        workflow,
        '01JC0000000000000000000000',
        guid(),
        'bunny_unreachable',
      ),
    ).rejects.toThrow(MediaJobNotFound);
  });

  it('refuses a malformed answer or failure before touching the database', () => {
    for (const bad of [
      null,
      { outcome: 'deleted' },
      { ...ready('any'), lengthSeconds: 0 },
      { ...ready('any'), thumbnailFileName: '../other/thumbnail.jpg' },
      { ...ready('any'), title: undefined },
    ]) {
      expect(() => parseMediaAnswer(bad)).toThrow(InvalidMediaJobCall);
    }
    expect(parseMediaAnswer(ready('any'))).toEqual(ready('any'));
    for (const bad of [
      null,
      {},
      { code: 'Bunny said: <file contents>' },
      { code: 'x'.repeat(65) },
    ]) {
      expect(() => parseFailure(bad)).toThrow(InvalidMediaJobCall);
    }
    expect(parseFailure({ code: 'bunny_unreachable' })).toBe(
      'bunny_unreachable',
    );
  });

  describe('the routes the worker calls', () => {
    let app: INestApplication;
    let url: string;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    // The job events the calls write (wideEvents in main.ts), caught instead of printed.
    type Entry = Record<string, unknown>;
    const entries: Entry[] = [];
    const waiting: (() => void)[] = [];
    const sink: LogSink = {
      write: (_severity, entry) => {
        entries.push(entry);
        waiting.splice(0).forEach((wake) => wake());
      },
    };
    const sinksBefore = [...LOG_SINKS];
    /** The first entry matching `pick`, once it has been written. */
    async function written(pick: (e: Entry) => boolean) {
      while (!entries.some(pick)) {
        await new Promise<void>((wake) => waiting.push(wake));
      }
      return entries.find(pick) as Entry;
    }
    const jobOf = (e: Entry) => (e['job'] ?? {}) as Record<string, unknown>;

    /**
     * A query whose SurrealQL contains `sql` runs, then its answer is held back until `release`
     * (the worker can hang up meanwhile); `reached` says it has run.
     */
    let holding: {
      sql: string;
      reached: () => void;
      release: Promise<void>;
    } | null = null;
    const holdable = (db: Surreal) =>
      new Proxy(db, {
        get(target, prop) {
          if (prop !== 'query') {
            // Bound to the real client: its private fields don't work through the proxy.
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string, vars?: Record<string, unknown>) => {
            const query = target.query(sql, vars);
            const hold = holding;
            if (!hold || !sql.includes(hold.sql)) return query;
            holding = null;
            // runQuery reads `query(…).json().responses()`: answer once released.
            return {
              json: () => ({
                responses: async () => {
                  const answer = await query.json().responses();
                  hold.reached();
                  await hold.release;
                  return answer;
                },
              }),
            };
          };
        },
      });

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SURREAL)
        .useValue(holdable(workflow))
        .overrideProvider(SECRET_MANAGER_CLIENT)
        .useValue({})
        .overrideProvider(SECRETS_PROJECT)
        .useValue('test-project')
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      LOG_SINKS.splice(0, LOG_SINKS.length, sink);
      app.use(wideEvents('workflow', 'job'));
      await app.listen(0);
      url = await app.getUrl();
    });
    afterAll(async () => {
      await app?.close();
      LOG_SINKS.splice(0, LOG_SINKS.length, ...sinksBefore);
    });

    it('answer: 200 with the outcome, stamped with the call’s arrival', async () => {
      const { story, video } = await videoStory();
      const id = await queue(video);

      expect(
        await post(`/v1/media-jobs/${id}/answer`, {
          videoId: video,
          ...ready(story),
        }),
      ).toEqual({
        status: 200,
        body: { outcome: 'applied' },
      });
      const stamped = (await checkedAt(video)) as string;
      expect(Date.parse(stamped)).toBeGreaterThan(Date.now() - 60_000);
      // The job event keeps the arrival time stale answers are ordered by (F1).
      const event = await written(
        (e) => e['event'] === 'job' && jobOf(e)['id'] === id,
      );
      expect(jobOf(event)).toMatchObject({
        name: 'media',
        video_id: video,
        answer: 'ready',
        result: 'applied',
      });
      expect(Date.parse(jobOf(event)['arrived_at'] as string)).toBe(
        Date.parse(stamped),
      );
    });

    it('keeps the job’s ending in the logs when the worker hangs up before the answer', async () => {
      const { video } = await videoStory();
      const id = await queue(video);
      let reached!: () => void;
      let release!: () => void;
      const counted = new Promise<void>((r) => (reached = r));
      holding = {
        sql: 'lastError = $code',
        reached,
        release: new Promise<void>((r) => (release = r)),
      };
      const hangUp = new AbortController();
      const asked = fetch(`${url}/v1/media-jobs/${id}/failed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: video, code: 'bunny_unreachable' }),
        signal: hangUp.signal,
      }).catch(() => undefined);
      // The failure is counted; the worker hangs up before the answer.
      await counted;
      hangUp.abort();
      await asked;
      const event = await written(
        (e) => e['event'] === 'job' && jobOf(e)['id'] === id,
      );
      expect(jobOf(event)['retry']).toBeUndefined();
      release();
      const line = await written(
        (e) =>
          e['event'] === undefined &&
          jobOf(e)['id'] === id &&
          jobOf(e)['retry'] !== undefined,
      );
      expect(line).toMatchObject({
        ref: event['ref'],
        service: { name: 'workflow' },
        job: {
          name: 'media',
          id,
          video_id: video,
          failure_code: 'bunny_unreachable',
          retry: true,
        },
      });
      expect(await job(id)).toMatchObject({ failures: 1, done: false });
    });

    it('answer "failed" with Bunny off: 503, nothing written (Part 1a: the writer must confirm it with Bunny)', async () => {
      const { video } = await videoStory();
      const id = await queue(video);
      expect(
        await post(`/v1/media-jobs/${id}/answer`, {
          videoId: video,
          outcome: 'failed',
        }),
      ).toMatchObject({ status: 503 });
      expect(await file(video)).toEqual({});
      expect(await job(id)).toMatchObject({ done: false, failures: 0 });
    });

    it('failed: 200 with "try again", then "give up" on the third', async () => {
      const { video } = await videoStory();
      const id = await queue(video);
      const fail = () =>
        post(`/v1/media-jobs/${id}/failed`, {
          videoId: video,
          code: 'bunny_unreachable',
        });

      for (let i = 1; i < MAX_FAILURES; i++) {
        expect(await fail()).toEqual({ status: 200, body: { retry: true } });
      }
      expect(await fail()).toEqual({
        status: 200,
        body: { retry: false, outcome: 'gave_up' },
      });
    });

    it('refuses an answer or failure naming another video than the job’s (400 video_mismatch), writing nothing', async () => {
      const { story, video } = await videoStory();
      const other = await videoStory();
      const id = await queue(video);
      const refused = {
        status: 400,
        body: expect.objectContaining({ code: 'video_mismatch' }),
      };

      expect(
        await post(`/v1/media-jobs/${id}/answer`, {
          videoId: other.video,
          ...ready(story),
        }),
      ).toEqual(refused);
      expect(
        await post(`/v1/media-jobs/${id}/failed`, {
          videoId: other.video,
          code: 'bunny_unreachable',
        }),
      ).toEqual(refused);
      expect(await file(video)).toEqual({});
      expect(await file(other.video)).toEqual({});
      expect(await job(id)).toMatchObject({ failures: 0, done: false });
    });

    it('404 for a job that doesn’t exist; 400 for a malformed call', async () => {
      const missing = '01JC0000000000000000000000';
      const videoId = guid();
      const status = async (path: string, body: unknown) =>
        (await post(`/v1/media-jobs/${path}`, body)).status;

      expect(
        await status(`${missing}/answer`, { videoId, outcome: 'gone' }),
      ).toBe(404);
      expect(await status(`${missing}/failed`, { videoId, code: 'x_y' })).toBe(
        404,
      );
      expect(
        await status(`not-a-job/answer`, { videoId, outcome: 'gone' }),
      ).toBe(400);
      expect(
        await status(`${missing}/answer`, { videoId, outcome: 'maybe' }),
      ).toBe(400);
      expect(
        await status(`${missing}/failed`, { videoId, code: 'Not Short!' }),
      ).toBe(400);
      // Every call names the job's video.
      expect(await status(`${missing}/answer`, { outcome: 'gone' })).toBe(400);
      expect(
        await status(`${missing}/failed`, { videoId: '../x', code: 'x_y' }),
      ).toBe(400);
    });
  });
});

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
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SURREAL } from '@heisreal/database';
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
  REENCODED,
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
      thumbnailPath: `${mine.video}/thumbnail.jpg`,
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
      // Uploaded moments ago: an Admin approves during the upload cooldown (decision 5).
      await approve(admin, story, { superAdminSkip: true });
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

  it('records still encoding, re-encoding after a failure, failed for good, and gone (deleted at Bunny)', async () => {
    const encoding = await videoStory();
    const reencoding = await videoStory();
    const unusable = await videoStory();
    const gone = await videoStory();

    expect(await answer(encoding.video, { outcome: 'encoding' })).toBe(
      'applied',
    );
    const first = await queue(reencoding.video);
    expect(
      await answerJob(
        workflow,
        first,
        reencoding.video,
        { outcome: 'failed', final: false },
        next(),
      ),
    ).toBe('applied');
    const last = await queue(unusable.video);
    expect(
      await answerJob(
        workflow,
        last,
        unusable.video,
        { outcome: 'failed', final: true },
        next(),
      ),
    ).toBe('gave_up');
    const lost = await queue(gone.video);
    expect(
      await answerJob(workflow, lost, gone.video, { outcome: 'gone' }, next()),
    ).toBe('gave_up');

    expect((await file(encoding.video))['processing']).toBe('processing');
    // Part 1a: only Bunny's final failure makes the file failed, and the job says why.
    expect((await file(reencoding.video))['processing']).toBe('processing');
    expect(await job(first)).toMatchObject({
      outcome: 'applied',
      lastError: REENCODED,
    });
    expect(await job(first)).not.toHaveProperty('errorType');
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

  it('a published story hides while its video is re-encoded and comes back when it is ready again', async () => {
    const { story, video } = await videoStory();
    await answer(video, ready(story));
    await submit(pat, story);
    // Uploaded moments ago: an Admin approves during the upload cooldown (decision 5).
    await approve(admin, story, { superAdminSkip: true });
    expect(await isPublic(story)).toBe(true);

    await answer(video, { outcome: 'failed', final: false });
    expect(await storyRow(story)).toMatchObject({
      current: {
        status: 'hidden',
        actor: 'system',
        hiddenReason: 'media_unavailable',
      },
    });
    expect(await isPublic(story)).toBe(false);

    // Re-encoded at Bunny (docs/media-runbook.md): ready again, maybe with another frame.
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
  // the same; the first such failure gets one automatic re-encode, the next makes the file
  // unusable and sends the story back. Bunny is a fake here: what matters is what's written.
  describe('a "failed" answer (Part 1a)', () => {
    /**
     * `whileReencoding` runs inside the re-encode request, before it returns: what happens at the
     * same time (Bunny's notice arriving, or the request failing), with no timing involved.
     */
    const fakeBunny = (
      status: BunnyVideoStatus | Error,
      whileReencoding?: () => Promise<void>,
    ) => {
      const calls: string[] = [];
      return {
        calls,
        videoStatus: async (video: string) => {
          calls.push(`status ${video}`);
          if (status instanceof Error) throw status;
          return status;
        },
        reencode: async (video: string) => {
          calls.push(`reencode ${video}`);
          await whileReencoding?.();
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

    it('a waiting story: one re-encode, then Bunny’s second failure sends it back (file_unusable)', async () => {
      const { story, video } = await videoStory();
      await submit(pat, story);
      const first = await queue(video, 'bunny_failed');
      const bunny = fakeBunny('failed');

      expect(
        await answerFailed(workflow, bunny, first, video, next()),
      ).toMatchObject({ outcome: 'applied' });
      expect(bunny.calls).toEqual([`status ${video}`, `reencode ${video}`]);
      expect((await file(video))['processing']).toBe('processing');
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'pending' },
      });

      // Bunny's notice when the re-encode fails opens the next check.
      const second = await queue(video, 'bunny_failed');
      expect(second).not.toBe(first);
      bunny.calls.length = 0;
      expect(
        await answerFailed(workflow, bunny, second, video, next()),
      ).toMatchObject({ outcome: 'gave_up' });
      expect(bunny.calls).toEqual([`status ${video}`]);
      expect((await file(video))['processing']).toBe('failed');
      expect(await job(second)).toMatchObject({
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
    });

    it('a published story leaves the site while Bunny re-encodes, and is sent back at once when that fails (G2)', async () => {
      const { story, video } = await videoStory();
      await answer(video, ready(story));
      await submit(pat, story);
      await approve(admin, story, { superAdminSkip: true });
      const bunny = fakeBunny('failed');

      await answerFailed(workflow, bunny, await queue(video), video, next());
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'hidden', hiddenReason: 'media_unavailable' },
      });
      expect(await isPublic(story)).toBe(false);

      await answerFailed(
        workflow,
        bunny,
        await queue(video, 'bunny_failed'),
        video,
        next(),
      );
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'editing', actor: 'system' },
      });
      expect(await isPublic(story)).toBe(false);
      expect((await entries(story)).map((e) => e.action)).toEqual([
        'sent',
        'approved',
        'hiddenBySystem',
        'fileUnusable',
      ]);
    });

    it('Bunny’s notice that arrives while the re-encode is being asked for still gets checked (Codex r1, finding 1)', async () => {
      const { story, video } = await videoStory();
      await submit(pat, story);
      const first = await queue(video, 'bunny_failed');
      let notice: string | undefined;
      // The re-encode fails at once: Bunny's notice reaches api-user before the request returns.
      const bunny = fakeBunny('failed', async () => {
        notice = await queue(video, 'bunny_failed');
      });

      expect(
        await answerFailed(workflow, bunny, first, video, next()),
      ).toMatchObject({ outcome: 'applied' });
      // The notice joined a job still open (not the first, which had already ended).
      expect(notice).toBeDefined();
      expect(notice).not.toBe(first);
      expect(await job(notice as string)).toMatchObject({ done: false });

      expect(
        await answerFailed(
          workflow,
          fakeBunny('failed'),
          notice as string,
          video,
          next(),
        ),
      ).toMatchObject({ outcome: 'gave_up' });
      expect((await file(video))['processing']).toBe('failed');
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'editing', actor: 'system' },
      });
    });

    it('asking for the re-encode isn’t proof it ran: a failure before Bunny’s notice is not final (Codex r1, finding 2)', async () => {
      const { story, video } = await videoStory();
      await submit(pat, story);
      const first = await queue(video, 'bunny_failed');
      // The request to Bunny fails: counted on the follow-up job, which stays open.
      const refused = fakeBunny('failed', async () => {
        throw new BunnyCallFailed('bunny_unreachable');
      });
      expect(
        await answerFailed(workflow, refused, first, video, next()),
      ).toMatchObject({ outcome: 'applied' });

      // The follow-up is sent again (18:00 resend) while Bunny still shows the first failure:
      // the writer only reads Bunny's status (never a second re-encode) and waits.
      const followUp = await queue(video, 'resent');
      expect(followUp).not.toBe(first);
      expect(await job(followUp)).toMatchObject({
        failures: 1,
        lastError: 'bunny_unreachable',
        done: false,
      });
      const bunny = fakeBunny('failed');
      expect(
        await answerFailed(workflow, bunny, followUp, video, next()),
      ).toEqual({ retry: true });
      expect(bunny.calls).toEqual([`status ${video}`]);
      expect((await file(video))['processing']).toBe('processing');
      // Counted, so the wait ends (as ours) if Bunny's notice never comes.
      expect(await job(followUp)).toMatchObject({
        failures: 2,
        lastError: 'bunny_reencode_pending',
        done: false,
      });
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'pending' },
      });

      // The re-encode runs and fails: Bunny's notice joins the open job, and now it is final.
      expect(await queue(video, 'bunny_failed')).toBe(followUp);
      bunny.calls.length = 0;
      expect(
        await answerFailed(workflow, bunny, followUp, video, next()),
      ).toMatchObject({ outcome: 'gave_up' });
      expect(bunny.calls).toEqual([`status ${video}`]);
      expect(await job(followUp)).toMatchObject({
        errorType: 'file_unusable',
      });
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'editing', actor: 'system' },
      });
    });

    it('Bunny is asked to re-encode a file once only: with no notice, the follow-up gives up as ours (Codex r2)', async () => {
      const { story, video } = await videoStory();
      await submit(pat, story);
      const first = await queue(video, 'bunny_failed');
      const bunny = fakeBunny('failed');
      const result = await answerFailed(workflow, bunny, first, video, next());
      const followUp = (result as { followUp?: string }).followUp as string;
      expect(followUp).toBeDefined();

      // Bunny's notice never comes; the worker keeps reporting "failed" for the follow-up.
      for (let n = 1; n < MAX_FAILURES; n++) {
        expect(
          await answerFailed(workflow, bunny, followUp, video, next()),
        ).toEqual({ retry: true });
      }
      expect(
        await answerFailed(workflow, bunny, followUp, video, next()),
      ).toEqual({ retry: false, outcome: 'gave_up' });
      expect(bunny.calls.filter((c) => c.startsWith('reencode'))).toEqual([
        `reencode ${video}`,
      ]);
      expect(await job(followUp)).toMatchObject({
        errorType: 'bunny_unavailable',
      });
      expect((await file(video))['processing']).toBe('processing');
      expect(await storyRow(story)).toMatchObject({
        current: { status: 'pending' },
      });
    });

    it('a Bunny call that fails counts as the job’s failure (ours: bunny_unavailable at the fifth)', async () => {
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
    it('says "try again" four times, then gives up on the fifth and drops later calls', async () => {
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
        failures: 4,
        lastError: 'bunny_unreachable',
        done: false,
      });
      expect(await failJob(workflow, id, video, 'bunny_timeout')).toEqual({
        retry: false,
        outcome: 'gave_up',
      });
      expect(await job(id)).toMatchObject({
        failures: 5,
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
      expect(await job(id)).toMatchObject({ failures: 5 });
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
      // Part 1a: the writer's own re-encode marker is never a worker's code.
      { code: REENCODED },
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

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SURREAL)
        .useValue(workflow)
        .overrideProvider(SECRET_MANAGER_CLIENT)
        .useValue({})
        .overrideProvider(SECRETS_PROJECT)
        .useValue('test-project')
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.listen(0);
      url = await app.getUrl();
    });
    afterAll(() => app?.close());

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
      expect(Date.parse((await checkedAt(video)) as string)).toBeGreaterThan(
        Date.now() - 60_000,
      );
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

    it('failed: 200 with "try again", then "give up" on the fifth', async () => {
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

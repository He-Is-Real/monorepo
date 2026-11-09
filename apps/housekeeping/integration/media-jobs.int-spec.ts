import { randomUUID } from 'node:crypto';
import {
  agreeAll,
  createPeople,
  grantUpload,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import type { Surreal } from 'surrealdb';
import { RUNS } from '../src/app/chores';
import { housekeepingConfig, RefusedError } from '../src/app/config';
import type { MediaJobMessage, MediaJobs } from '../src/app/media-jobs';
import { runTasks, type Task, type TaskContext } from '../src/app/tasks';

/** Google's media-jobs queue, in memory: what was sent, in order. */
class FakeQueue implements MediaJobs {
  sent: { job: MediaJobMessage; orderingKey: string }[] = [];
  failing = false;
  async publish(job: MediaJobMessage, orderingKey: string) {
    if (this.failing) throw new Error('14 UNAVAILABLE');
    this.sent.push({ job, orderingKey });
  }
}

/**
 * The media job table's chores (Joel, 2026-11-07), against a real SurrealDB as
 * service:housekeeping: the 18:00 run sends every unfinished job last sent over 12 hours ago
 * again, in the same message api-user sends, and records it; the nightly run never resends, and
 * deletes ended jobs 30 days after they ended (J2).
 */
describe('housekeeping: media jobs', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let housekeeping: Surreal;
  let pat: Surreal;
  let queue: FakeQueue;
  const logs: Record<string, unknown>[] = [];
  let n = 0;

  /** A video draft of pat's with an open check job (api-user's write): its ids. */
  const openJob = async () => {
    const story = `hk_${++n}`;
    const video = randomUUID();
    await run(
      pat,
      `CREATE type::record('story', $story) CONTENT { themeRefs: [theme:common],
         submitter: $auth, slug: $story, title: 'A story', description: 'How I came to faith',
         primaryFormat: 'video' }`,
      { story },
    );
    expect(
      await grantUpload(apiUser, { video, story, person: 'pat', version: 1 }),
    ).toMatchObject({ ok: true });
    const [queued] = await rows<{ job: string }>(
      apiUser,
      `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', 'bunny_finished')`,
      { video },
    );
    return { job: queued.job, story, video };
  };
  /** As api-user records its send, `ago` (a SurrealQL duration) ago. */
  const sent = (job: string, ago: string) =>
    run(
      migrator,
      `UPDATE type::record('mediaJob', $job) SET sends += 1,
         sentAt = time::now() - <duration> $ago`,
      { job, ago },
    );
  /** As the result writer ends it (`ago` ago: only a system user may say when). */
  const ended = (job: string, outcome: string, ago = '0s') =>
    run(
      migrator,
      `UPDATE type::record('mediaJob', $job) SET outcome = $outcome,
         doneAt = time::now() - <duration> $ago`,
      { job, outcome, ago },
    );
  const job = async (id: string) =>
    (
      await rows<{
        sends: number;
        reasons: string[];
        sentRecently: boolean;
      }>(
        migrator,
        `SELECT sends, reasons, sentAt > time::now() - 1m AS sentRecently
         FROM ONLY type::record('mediaJob', $id)`,
        { id },
      )
    )[0];
  const sweep = (chores: readonly Task[], over: Partial<TaskContext> = {}) =>
    runTasks(
      chores,
      {
        db: housekeeping,
        stream: null,
        mediaJobs: queue,
        dryRun: false,
        maxDeletions: 50,
        now: new Date(),
        ...over,
      },
      (entry) => logs.push(entry),
    );
  const lastLog = (task: string) =>
    [...logs].reverse().find((l) => l['task'] === task);

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    housekeeping = await t.service('housekeeping');
    await createPeople(t, { pat: 'user_pat' });
    await trustSubmitters(t, 'pat');
    // More drafts and uploads than a person may have at once (D94, D113): not what's tested here.
    await run(
      migrator,
      `UPDATE submitterLimits:pat SET openDraftsMax = 100, uploadRequestsPerHour = 100,
         uploadsPer7Days = 100`,
    );
    pat = await t.person('user_pat');
    await agreeAll(pat);
  });
  beforeEach(() => {
    queue = new FakeQueue();
  });
  afterAll(() => t?.close());

  describe('the 18:00 resend', () => {
    it('sends again only open jobs last sent over 12 hours ago, as api-user sends them, and records it', async () => {
      const due = await openJob();
      await sent(due.job, '13h');
      const recent = await openJob();
      await sent(recent.job, '11h');
      const done = await openJob();
      await sent(done.job, '13h');
      await ended(done.job, 'applied');
      const gaveUp = await openJob();
      await sent(gaveUp.job, '13h');
      await ended(gaveUp.job, 'gave_up');
      // Written moments ago, its send not recorded yet (api-user is still sending it).
      const fresh = await openJob();

      expect(await sweep(RUNS['media-resend'])).toBe(0);

      expect(queue.sent).toEqual([
        {
          job: { jobId: due.job, kind: 'check', videoId: due.video },
          orderingKey: due.story,
        },
      ]);
      expect(await job(due.job)).toEqual({
        sends: 2,
        reasons: ['bunny_finished', 'resent'],
        sentRecently: true,
      });
      for (const other of [recent, done, gaveUp]) {
        expect(await job(other.job)).toMatchObject({
          sends: 1,
          reasons: ['bunny_finished'],
        });
      }
      expect(await job(fresh.job)).toMatchObject({ sends: 0 });
      expect(lastLog('media-resend')).toMatchObject({
        selected: 1,
        deleted: 1,
        failed: 0,
        ids: [due.job],
      });

      // Sent now: the next evening's run doesn't send it again before its 12 hours are up.
      queue = new FakeQueue();
      await sweep(RUNS['media-resend']);
      expect(queue.sent).toEqual([]);
    });

    it('a dry run only logs; a failed send leaves the job for the next evening', async () => {
      const a = await openJob();
      await sent(a.job, '2d');

      await sweep(RUNS['media-resend'], { dryRun: true });
      expect(queue.sent).toEqual([]);
      expect(lastLog('media-resend')).toMatchObject({
        dryRun: true,
        ids: [a.job],
      });
      expect(await job(a.job)).toMatchObject({ sends: 1 });

      queue.failing = true;
      expect(await sweep(RUNS['media-resend'])).toBe(1);
      expect(lastLog('media-resend')).toMatchObject({
        failed: 1,
        failedIds: [a.job],
      });
      expect(await job(a.job)).toMatchObject({
        sends: 1,
        reasons: ['bunny_finished'],
      });

      queue.failing = false;
      await sweep(RUNS['media-resend']);
      expect(queue.sent.map((s) => s.job.jobId)).toEqual([a.job]);
      await ended(a.job, 'applied');
    });

    it('the nightly run never resends', async () => {
      const due = await openJob();
      await sent(due.job, '13h');
      const before = logs.length;
      await sweep(RUNS.nightly);
      expect(queue.sent).toEqual([]);
      expect(
        logs.slice(before).filter((l) => l['task'] === 'media-resend'),
      ).toEqual([]);
      expect(await job(due.job)).toMatchObject({ sends: 1 });
      await ended(due.job, 'applied');
    });
  });

  it('the nightly run deletes ended jobs 30 days after they ended, and nothing else', async () => {
    const old = await openJob();
    await ended(old.job, 'applied', '31d');
    const oldGaveUp = await openJob();
    await ended(oldGaveUp.job, 'gave_up', '31d');
    const recent = await openJob();
    await ended(recent.job, 'stale', '29d');
    const open = await openJob();
    await sent(open.job, '40d');

    expect(await sweep(RUNS.nightly)).toBe(0);

    expect(await job(old.job)).toBeUndefined();
    expect(await job(oldGaveUp.job)).toBeUndefined();
    expect(await job(recent.job)).toBeDefined();
    expect(await job(open.job)).toBeDefined();
    expect(lastLog('old-media-jobs')).toMatchObject({ deleted: 2 });
    expect(
      [...(lastLog('old-media-jobs')?.['ids'] as string[])].sort(),
    ).toEqual([old.job, oldGaveUp.job].sort());
  });

  it('the nightly run opens a check of each video whose picture at Bunny is unfinished (T4), and only those', async () => {
    /** The result writer's lock on the video, until `delta` from now (SurrealQL). */
    const lockUntil = (video: string, delta: string) =>
      run(
        migrator,
        `UPDATE type::record('storyFile', $video) SET thumbnailLockedUntil = time::now() ${delta}`,
        { video },
      );
    const openCheck = async (video: string) =>
      (
        await rows<{ id: string; reasons: string[] }>(
          migrator,
          `SELECT <string> record::id(id) AS id, reasons FROM mediaJob
             WHERE file = type::record('storyFile', $video) AND kind = 'check'
               AND doneAt = NONE`,
          { video },
        )
      )[0];
    // Unfinished: its check gave up, and the lock ran out.
    const gaveUp = await openJob();
    await ended(gaveUp.job, 'gave_up');
    await lockUntil(gaveUp.video, '- 1h');
    // A writer still at work (lock ahead), and one unfinished whose check is still open.
    const atWork = await openJob();
    await ended(atWork.job, 'gave_up');
    await lockUntil(atWork.video, '+ 1m');
    const stillOpen = await openJob();
    await lockUntil(stillOpen.video, '- 1h');

    await sweep(RUNS.nightly, { dryRun: true });
    expect(lastLog('unfinished-pictures')).toMatchObject({
      dryRun: true,
      ids: [gaveUp.video],
    });
    expect(await openCheck(gaveUp.video)).toBeUndefined();

    expect(await sweep(RUNS.nightly)).toBe(0);
    expect(lastLog('unfinished-pictures')).toMatchObject({
      selected: 1,
      deleted: 1,
      ids: [gaveUp.video],
    });
    // The 18:00 resend sends it; nothing is sent at night.
    expect(await openCheck(gaveUp.video)).toMatchObject({
      reasons: ['resent'],
    });
    expect(queue.sent).toEqual([]);
    expect(await openCheck(atWork.video)).toBeUndefined();
    expect(await openCheck(stillOpen.video)).toMatchObject({
      id: stillOpen.job,
      reasons: ['bunny_finished'],
    });

    // Housekeeping may open only that: a check with its own reason.
    for (const [kind, reason] of [
      ['check', 'bunny_finished'],
      ['render', 'resent'],
    ]) {
      await expect(
        rows(
          housekeeping,
          `RETURN fn::media::queue_job(type::record('storyFile', $video), $kind, $reason)`,
          { video: atWork.video, kind, reason },
        ),
      ).rejects.toThrow();
    }
  });

  it('a run is the nightly one unless it says media-resend, which needs the topic', () => {
    const env = {
      GCP_PROJECT: 'p',
      SURREAL_URL: 'ws://db:8000',
      SURREAL_NAMESPACE: 'n',
      SURREAL_DATABASE: 'd',
      SURREAL_USER: 'housekeeping',
      SURREAL_PASSWORD_SECRET: 's',
      BUNNY_STREAM_LIBRARY_ID: '1',
      BUNNY_STREAM_API_KEY_SECRET: 'k',
    };
    expect(housekeepingConfig(env)).toMatchObject({
      run: 'nightly',
      mediaJobsTopic: null,
    });
    expect(
      housekeepingConfig({
        ...env,
        HOUSEKEEPING_CHORES: 'media-resend',
        MEDIA_JOBS_TOPIC: 'media-jobs',
      }),
    ).toMatchObject({ run: 'media-resend', mediaJobsTopic: 'media-jobs' });
    expect(() =>
      housekeepingConfig({ ...env, HOUSEKEEPING_CHORES: 'media-resend' }),
    ).toThrow(RefusedError);
    expect(() =>
      housekeepingConfig({ ...env, HOUSEKEEPING_CHORES: 'everything' }),
    ).toThrow(RefusedError);
  });
});

import { randomUUID } from 'node:crypto';
import type { Surreal } from 'surrealdb';
import {
  agreeAll,
  createPeople,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from './support/harness';
import { draft, edit, ERASE, grantUpload, submit } from './support/world';

/**
 * The mediaJob table (media ready; Joel, 2026-11-07, media-worker-final.html section 3): only the
 * services see or write it, only the result writer ends a job, done jobs go after 30 days, and a
 * person's erasure leaves none of their jobs behind.
 */
describe('mediaJob: who may do what', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let housekeeping: Surreal;
  let publicRead: Surreal;
  let pat: Surreal;
  let n = 0;

  /** A video draft of pat's with an open check job: the job's id. */
  const jobFor = async () => {
    const story = `mj_${++n}`;
    const video = randomUUID();
    await draft(pat, story, { primaryFormat: 'video', body: undefined });
    expect(
      await grantUpload(apiUser, { video, story, person: 'pat', version: 1 }),
    ).toMatchObject({ ok: true });
    const [queued] = await rows<{ job: string }>(
      apiUser,
      `RETURN fn::media::queue_job(type::record('storyFile', $video), 'check', 'bunny_finished')`,
      { video },
    );
    return queued.job;
  };
  const job = async (id: string) =>
    (
      await rows(
        migrator,
        `SELECT sends, failures, outcome FROM ONLY type::record('mediaJob', $id)`,
        { id },
      )
    )[0];

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    housekeeping = await t.service('housekeeping');
    publicRead = await t.service('api_public_read');
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
  afterAll(() => t?.close());

  it('no person’s session or the public sees a job; api-admin reads them for the queue (Part 1a)', async () => {
    const id = await jobFor();
    for (const db of [pat, publicRead]) {
      expect(
        await rows(db, `SELECT id FROM type::record('mediaJob', $id)`, { id }),
      ).toEqual([]);
    }
    for (const db of [apiUser, workflow, housekeeping, admin]) {
      expect(
        await rows(db, `SELECT VALUE id FROM type::record('mediaJob', $id)`, {
          id,
        }),
      ).toHaveLength(1);
    }
  });

  it('api-user and housekeeping record sends but can’t count failures or end a job', async () => {
    const id = await jobFor();
    for (const db of [apiUser, housekeeping]) {
      await run(
        db,
        `UPDATE type::record('mediaJob', $id) SET sends += 1, sentAt = time::now(),
           failures = 9, outcome = 'applied', doneAt = time::now()`,
        { id },
      );
    }
    expect(await job(id)).toEqual({ sends: 2, failures: 0 });
  });

  it('a job ends once: its outcome and end don’t change after', async () => {
    const id = await jobFor();
    await run(
      workflow,
      `UPDATE type::record('mediaJob', $id) SET outcome = 'gone', doneAt = time::now()`,
      { id },
    );
    await run(
      workflow,
      `UPDATE type::record('mediaJob', $id) SET outcome = 'applied', doneAt = NONE`,
      { id },
    );
    expect(await job(id)).toMatchObject({ outcome: 'gone' });
  });

  // Part 1a (Joel, 2026-11-10; P1a-4 A): why a job gave up, from a fixed list, written only by the
  // result writer, set with gave_up and only then, read only by api-admin.
  describe('errorType (Part 1a)', () => {
    const giveUp = (db: Surreal, id: string, errorType: unknown) =>
      rows(
        db,
        `UPDATE type::record('mediaJob', $id) SET outcome = 'gave_up', doneAt = time::now(),
           errorType = $errorType RETURN NONE`,
        { id, errorType },
      ).then(
        () => ({ ok: true }),
        (err: Error) => ({ ok: false, error: err.message }),
      );
    const errorTypeOf = async (id: string, db: Surreal = migrator) =>
      (
        await rows(
          db,
          `SELECT VALUE errorType FROM ONLY type::record('mediaJob', $id)`,
          { id },
        )
      )[0];

    it('takes only the four values, and only with gave_up', async () => {
      for (const value of [
        'file_unusable',
        'bunny_unavailable',
        'worker_error',
        'other',
      ]) {
        const id = await jobFor();
        expect(await giveUp(workflow, id, value)).toEqual({ ok: true });
        expect(await errorTypeOf(id)).toBe(value);
      }
      const odd = await jobFor();
      expect(await giveUp(workflow, odd, 'disk_full')).toMatchObject({
        ok: false,
      });
      expect(await giveUp(workflow, odd, undefined)).toEqual({
        ok: false,
        error: expect.stringContaining('errorType when, and only when'),
      });
      const applied = await jobFor();
      await expect(
        rows(
          workflow,
          `UPDATE type::record('mediaJob', $id) SET outcome = 'applied', doneAt = time::now(),
             errorType = 'other'`,
          { id: applied },
        ),
      ).rejects.toThrow(/errorType when, and only when/);
    });

    it('only the result writer writes it, once; only api-admin reads it', async () => {
      const id = await jobFor();
      for (const db of [apiUser, housekeeping]) {
        await run(
          db,
          `UPDATE type::record('mediaJob', $id) SET errorType = 'file_unusable'`,
          { id },
        );
      }
      expect(await errorTypeOf(id)).toBeUndefined();
      expect(await giveUp(workflow, id, 'worker_error')).toEqual({ ok: true });
      await run(
        workflow,
        `UPDATE type::record('mediaJob', $id) SET errorType = 'file_unusable'`,
        { id },
      );
      expect(await errorTypeOf(id)).toBe('worker_error');
      expect(await errorTypeOf(id, admin)).toBe('worker_error');
      for (const db of [apiUser, workflow, housekeeping]) {
        expect(await errorTypeOf(id, db)).toBeUndefined();
      }
    });
  });

  // P1-9 (Joel, 2026-11-14: "Retries must be capped"): every path that opens a job of a file meets
  // the one cap in the database (mediaJob_rules, fn::media::retries_used). After the original
  // check and 3 nightly retries gave up on our side, a waiting story's file gets no new job,
  // whoever opens it, and the moderators' "a problem on our side" stays.
  describe('the nightly retry cap holds for every opener (Part 1a, P1-9)', () => {
    const queueAs = (
      db: Surreal,
      video: string,
      kind: string,
      reason: string,
    ) =>
      rows(
        db,
        `RETURN fn::media::queue_job(type::record('storyFile', $video), $kind, $reason)`,
        { video, kind, reason },
      ).then((r) => r[0]);
    const openJobs = (video: string) =>
      rows<string>(
        migrator,
        `SELECT VALUE <string> record::id(id) FROM mediaJob
           WHERE file = type::record('storyFile', $video) AND doneAt = NONE`,
        { video },
      );
    const ours = async (video: string) =>
      (
        await rows<{ ours: boolean }>(
          admin,
          `RETURN fn::media::our_problem(type::record('storyFile', $video))`,
          { video },
        )
      )[0].ours;
    /** Each open job of `video` gives up on our side (as the result writer ends it). */
    const giveUp = async (video: string) => {
      for (const id of await openJobs(video)) {
        await run(
          workflow,
          `UPDATE type::record('mediaJob', $id) SET outcome = 'gave_up', doneAt = time::now(),
             errorType = 'other'`,
          { id },
        );
      }
    };
    /** pat's video story, sent (its submit check open): its id and file. */
    const sent = async () => {
      const story = `cap_${++n}`;
      const video = randomUUID();
      await draft(pat, story, { primaryFormat: 'video', body: undefined });
      expect(
        await grantUpload(apiUser, { video, story, person: 'pat', version: 1 }),
      ).toMatchObject({ ok: true });
      await submit(pat, story);
      return { story, video };
    };
    /** Its submit check and the 3 nightly retries all gave up: the cap is reached. */
    const capped = async (video: string) => {
      await giveUp(video);
      for (let night = 1; night <= 3; night++) {
        expect(
          await queueAs(housekeeping, video, 'check', 'resent'),
        ).toBeTruthy();
        await giveUp(video);
      }
      expect(await ours(video)).toBe(true);
    };

    it('before the cap, each opener still opens a check', async () => {
      const { video } = await sent();
      await giveUp(video);
      expect(await ours(video)).toBe(false);
      for (const [db, reason] of [
        [housekeeping, 'resent'],
        [apiUser, 'bunny_finished'],
        [workflow, 'resent'],
      ] as const) {
        expect(await queueAs(db, video, 'check', reason)).toMatchObject({
          video,
        });
        await giveUp(video);
      }
      // That was the third retry: now the cap holds.
      expect(await ours(video)).toBe(true);
    });

    it('after it: no check from Bunny’s notice, the result writer or the nightly chores', async () => {
      const { video } = await sent();
      await capped(video);
      for (const [db, reason] of [
        [apiUser, 'bunny_finished'],
        [apiUser, 'bunny_failed'],
        [workflow, 'resent'],
        [workflow, 'bunny_finished'],
        [housekeeping, 'resent'],
      ] as const) {
        expect(await queueAs(db, video, 'check', reason)).toBeUndefined();
      }
      // Nor a render (an audio file's picture video), which the result writer would open.
      expect(
        await queueAs(workflow, video, 'render', 'picture_changed'),
      ).toBeUndefined();
      expect(await openJobs(video)).toEqual([]);
      expect(await ours(video)).toBe(true);
    });

    it('after it: the owner editing and sending the same file again opens no check', async () => {
      const { story, video } = await sent();
      await capped(video);
      await edit(pat, story);
      await submit(pat, story);
      expect(await openJobs(video)).toEqual([]);
      expect(await ours(video)).toBe(true);
    });

    it('a new file is a fresh start: its first check opens', async () => {
      const { story, video } = await sent();
      await capped(video);
      await edit(pat, story);
      const version = (
        await rows<number>(
          migrator,
          `SELECT VALUE version FROM ONLY type::record('story', $story)`,
          { story },
        )
      )[0];
      const fresh = randomUUID();
      expect(
        await grantUpload(apiUser, {
          video: fresh,
          story,
          person: 'pat',
          version,
        }),
      ).toMatchObject({ ok: true });
      await submit(pat, story);
      expect(await openJobs(fresh)).toHaveLength(1);
    });

    it('a story back with its owner is outside the cap (it applies while waiting or taken off by the site)', async () => {
      const { story, video } = await sent();
      await capped(video);
      await edit(pat, story);
      expect(
        await queueAs(apiUser, video, 'check', 'bunny_finished'),
      ).toMatchObject({
        video,
      });
    });
  });

  it('housekeeping deletes a job only 30 days after it ended', async () => {
    const open = await jobFor();
    const recent = await jobFor();
    const old = await jobFor();
    await run(
      migrator,
      `UPDATE type::record('mediaJob', $recent) SET outcome = 'applied', doneAt = time::now() - 29d;
       UPDATE type::record('mediaJob', $old) SET outcome = 'applied', doneAt = time::now() - 31d;`,
      { recent, old },
    );
    for (const db of [apiUser, workflow]) {
      await run(db, `DELETE type::record('mediaJob', $old)`, { old });
    }
    expect(await job(old)).toBeDefined();
    await run(
      housekeeping,
      `DELETE type::record('mediaJob', $open); DELETE type::record('mediaJob', $recent);
       DELETE type::record('mediaJob', $old);`,
      { open, recent, old },
    );
    expect(await job(open)).toBeDefined();
    expect(await job(recent)).toBeDefined();
    expect(await job(old)).toBeUndefined();
  });

  it('erasure deletes the person’s jobs with their files', async () => {
    const id = await jobFor();
    await run(apiUser, ERASE, {
      clerkUserId: 'user_pat',
      reason: 'clerk_user_deleted',
    });
    expect(await rows(migrator, `SELECT VALUE id FROM mediaJob`)).toEqual([]);
    expect(await job(id)).toBeUndefined();
  });
});

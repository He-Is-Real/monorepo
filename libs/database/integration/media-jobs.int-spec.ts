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
import { draft, ERASE, grantUpload } from './support/world';

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

  it('no person’s session, api-admin or the public sees a job', async () => {
    const id = await jobFor();
    for (const db of [pat, admin, publicRead]) {
      expect(
        await rows(db, `SELECT id FROM type::record('mediaJob', $id)`, { id }),
      ).toEqual([]);
    }
    for (const db of [apiUser, workflow, housekeeping]) {
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

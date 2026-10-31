import { ERASE_ACCOUNT } from '@heisreal/database';
import { type SecretAccessor, SecretsService } from '@heisreal/secrets';
import {
  consentEvent,
  createPeople,
  grantAll,
  grantImage,
  grantUpload,
  outcome,
  publishDpa,
  publishForm,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import type { Surreal, SurrealTransaction } from 'surrealdb';
import { CHORES } from '../src/app/chores';
import type { ClerkUsers } from '../src/app/clerk';
import { erasureRequestsTask, pendingDeletionsTask } from '../src/app/erasure';
import type { ImageZone } from '../src/app/images';
import { startHousekeeping } from '../src/app/start';
import type { LibraryVideo, StreamLibrary } from '../src/app/stream';
import { runTasks, type TaskContext } from '../src/app/tasks';

/**
 * The nightly housekeeping Job against a real SurrealDB, signed in as service:housekeeping, with
 * a stand-in for Bunny's library. What matters is what it deletes: drafts untouched for 6 months
 * (D71) and story videos nothing refers to, and never anything else.
 */

/** Bunny's library, in memory: the list and the deletes. */
class FakeLibrary implements StreamLibrary {
  deleted: string[] = [];
  constructor(public videos: LibraryVideo[]) {}
  async list() {
    return { videos: [...this.videos], complete: true };
  }
  async delete(guid: string) {
    this.deleted.push(guid);
    this.videos = this.videos.filter((v) => v.guid !== guid);
  }
}

/** The images zone, in memory: the story folders it was asked to delete. */
class FakeZone implements ImageZone {
  deleted: string[] = [];
  async deleteFolder(folder: string) {
    this.deleted.push(folder);
  }
}

const NOW = new Date();
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000);
let n = 0;
const guid = () => `0f0e0d0c-0b0a-4908-8706-${String(++n).padStart(12, '0')}`;
/** A story id as RequestUpload titles a video (a ULID, D69). */
const storyTitle = () => `01J${String(n).padStart(23, '0')}`;
const story = (
  g: string,
  created: Date | null,
  extra: Partial<LibraryVideo> = {},
): LibraryVideo => ({
  guid: g,
  title: storyTitle(),
  created,
  collectionId: null,
  ...extra,
});

/** As a system user may (the schema lets only those set it): when the story was last touched. */
const touch = (
  migrator: Surreal,
  id: string,
  daysAgo: number,
  fields: Record<string, unknown> = {},
) =>
  run(
    migrator,
    `UPDATE type::record('story', $id) MERGE object::extend($fields, {
       updatedAt: time::now() - type::duration($ago) })`,
    { id, fields, ago: `${daysAgo}d` },
  );
const createDraft = (
  person: Surreal,
  id: string,
  format: 'written' | 'video',
) =>
  run(
    person,
    `CREATE type::record('story', $id) CONTENT {
       themeRefs: [theme:common], submitter: $auth, slug: $id, title: 'Story ' + $id, description: 'How I came to faith',
       body: $body, primaryFormat: $format }`,
    {
      id,
      format,
      body:
        format === 'written'
          ? `Text of ${id}. ${'Filler words. '.repeat(20)}`
          : undefined,
    },
  );

describe('housekeeping: abandoned drafts and orphaned videos', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let housekeeping: Surreal;
  let library: FakeLibrary;
  const V = {} as Record<string, string>;
  const logs: Record<string, unknown>[] = [];
  const OLD_PICTURE = `stories/old_written_draft/${'c'.repeat(32)}.webp`;
  const YOUNG_PICTURE = `stories/young_draft/${'d'.repeat(32)}.webp`;
  const queued = () =>
    rows(migrator, `SELECT kind, ref FROM pendingDeletion ORDER BY ref`);

  const exists = async (id: string) =>
    (await rows(migrator, `SELECT id FROM type::record('story', $id)`, { id }))
      .length === 1;
  const touched = (
    id: string,
    daysAgo: number,
    fields: Record<string, unknown> = {},
  ) => touch(migrator, id, daysAgo, fields);
  const media = (v: string) => ({
    media: [{ format: 'video', bunnyVideoId: v }],
  });
  const draft = createDraft;
  const sweep = (over: Partial<TaskContext> = {}) =>
    runTasks(
      CHORES,
      {
        db: housekeeping,
        stream: library,
        dryRun: false,
        maxDeletions: 50,
        now: NOW,
        ...over,
      },
      (entry) => logs.push(entry),
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    housekeeping = await t.service('housekeeping');
    const apiUser = await t.service('api_user');
    await createPeople(t, { ann: 'user_ann', bob: 'user_bob' });
    await publishDpa(t, 'v1');
    await trustSubmitters(t, 'ann', 'bob');
    const ann = await t.person('user_ann');
    const bob = await t.person('user_bob');
    await grantAll(ann);
    await grantAll(bob);

    for (const k of [
      'expired',
      'youngRef',
      'pendingRef',
      'orphanOld',
      'orphanNew',
    ])
      V[k] = guid();
    // Drafts: two abandoned (200 and 190 days), and one touched 184 days ago: inside the forms'
    // 6 months, counted as 186 days.
    await draft(ann, 'old_video_draft', 'video');
    await touched('old_video_draft', 200, media(V.expired));
    await draft(ann, 'old_written_draft', 'written');
    expect(
      await grantImage(apiUser, {
        story: 'old_written_draft',
        person: 'ann',
        version: 1,
        path: OLD_PICTURE,
      }),
    ).toMatchObject({ ok: true });
    await touched('old_written_draft', 190);
    await draft(ann, 'young_draft', 'video');
    expect(
      await grantImage(apiUser, {
        story: 'young_draft',
        person: 'ann',
        version: 1,
        path: YOUNG_PICTURE,
      }),
    ).toMatchObject({ ok: true });
    await touched('young_draft', 184, media(V.youngRef));
    // Never a draft: submitted 200 days ago, and withdrawn 200 days ago.
    await draft(bob, 'old_pending', 'video');
    await touched('old_pending', 0, media(V.pendingRef));
    await run(bob, `UPDATE story:old_pending SET status = 'pending'`);
    await touched('old_pending', 200);
    await draft(bob, 'old_withdrawn', 'written');
    await run(bob, `UPDATE story:old_withdrawn SET status = 'pending'`);
    await run(bob, `UPDATE story:old_withdrawn SET status = 'withdrawn'`);
    await touched('old_withdrawn', 200);
    // RequestUpload twice on Bob's video draft: the first video is replaced, its grant recent.
    await draft(bob, 'bob_video', 'video');
    for (const k of ['replaced', 'current']) {
      V[k] = guid();
      const [{ version }] = await rows<{ version: number }>(
        migrator,
        `SELECT version FROM story:bob_video`,
      );
      await run(
        apiUser,
        `CREATE type::record('uploadGrant', $video) CONTENT {
           story: story:bob_video, person: user:bob, format: 'video', contentType: 'video/mp4',
           sizeBytes: 1000000, durationSeconds: 60, storyVersion: $version }`,
        { video: V[k], version },
      );
    }
    for (const k of ['young', 'site', 'devSeed', 'undated']) V[k] = guid();

    library = new FakeLibrary([
      story(V.expired, ago(240)),
      story(V.youngRef, ago(240)),
      story(V.pendingRef, ago(240)),
      story(V.replaced, ago(240)), // older than its grant: Bunny's clock isn't ours
      story(V.current, ago(240)),
      story(V.orphanOld, ago(480)),
      story(V.orphanNew, ago(120)),
      story(V.young, ago(1)), // an upload in progress
      story(V.site, ago(2000), { collectionId: 'site-assets-collection' }),
      story(V.devSeed, ago(2000), { title: 'dev-seed/clip-01' }),
      story(V.undated, null),
    ]);
  });
  afterAll(() => t?.close());

  it('lets housekeeping read ids, status, dates and media, never what a person wrote', async () => {
    const [s] = await rows(
      housekeeping,
      `SELECT status, updatedAt, media, title, description, body, bylineName, slug
       FROM story:young_draft`,
    );
    expect(s).toMatchObject({
      status: 'draft',
      media: [{ bunnyVideoId: V.youngRef }],
    });
    for (const field of [
      'title',
      'description',
      'body',
      'bylineName',
      'slug',
    ]) {
      expect(s[field]).toBeUndefined();
    }
  });

  it('refuses its delete of a draft touched in the last 6 months, or of any non-draft, and any other write', async () => {
    await run(
      housekeeping,
      `DELETE story:young_draft; DELETE story:old_pending; DELETE story:old_withdrawn`,
    );
    await run(
      housekeeping,
      `UPDATE story:young_draft SET updatedAt = time::now() - 400d`,
    );
    await run(housekeeping, `DELETE uploadGrant`);
    // Nor may it queue a live story's picture, or anything but a picture, for deletion.
    await run(
      housekeeping,
      `CREATE pendingDeletion CONTENT { kind: 'image', ref: $young };
       CREATE pendingDeletion CONTENT { kind: 'image', ref: 'stories/none/x.webp' }`,
      { young: YOUNG_PICTURE },
    );
    expect(await queued()).toEqual([]);
    expect(await exists('young_draft')).toBe(true);
    expect(await exists('old_pending')).toBe(true);
    expect(await exists('old_withdrawn')).toBe(true);
    expect(await rows(migrator, `SELECT id FROM uploadGrant`)).toHaveLength(4);
    const [young] = await rows<{ days: number }>(
      migrator,
      `SELECT VALUE duration::days(time::now() - updatedAt) FROM story:young_draft`,
    );
    expect(young).toBe(184);
  });

  it('in a dry run, only reports what it would delete', async () => {
    expect(await sweep({ dryRun: true })).toBe(0);
    expect(logs.slice(-2)).toEqual([
      expect.objectContaining({
        task: 'expired-drafts',
        dryRun: true,
        selected: 2,
        deleted: 0,
        ids: ['old_video_draft', 'old_written_draft'],
      }),
      // The abandoned draft still shows its video, so it isn't an orphan yet.
      expect.objectContaining({
        task: 'orphan-videos',
        dryRun: true,
        selected: 2,
        deleted: 0,
        ids: [V.orphanOld, V.orphanNew],
      }),
    ]);
    expect(await exists('old_video_draft')).toBe(true);
    expect(library.deleted).toEqual([]);
  });

  it('deletes at most maxDeletions per chore, oldest first', async () => {
    expect(await sweep({ maxDeletions: 1 })).toBe(0);
    expect(logs.slice(-2)).toEqual([
      expect.objectContaining({
        task: 'expired-drafts',
        deleted: 1,
        more: true,
        ids: ['old_video_draft'],
      }),
      expect.objectContaining({
        task: 'orphan-videos',
        deleted: 1,
        more: true,
        ids: [V.orphanOld],
      }),
    ]);
    expect(await exists('old_video_draft')).toBe(false);
    expect(await exists('old_written_draft')).toBe(true);
  });

  it('then deletes the rest, the deleted draft’s video included, and nothing it must keep', async () => {
    expect(await sweep()).toBe(0);
    expect(await exists('old_written_draft')).toBe(false);
    expect(library.deleted.sort()).toEqual(
      [V.orphanOld, V.expired, V.orphanNew].sort(),
    );
    for (const id of [
      'young_draft',
      'old_pending',
      'old_withdrawn',
      'bob_video',
    ]) {
      expect(await exists(id)).toBe(true);
    }
    expect(library.videos.map((v) => v.guid).sort()).toEqual(
      [
        V.youngRef,
        V.pendingRef,
        V.replaced,
        V.current,
        V.young,
        V.site,
        V.devSeed,
        V.undated,
      ].sort(),
    );
  });

  it('queues the deleted drafts’ picture folders, and deletes them once the images zone can be used, the last time after a PUT link’s 10 minutes', async () => {
    const folders = ['stories/old_video_draft/', 'stories/old_written_draft/'];
    expect(await queued()).toEqual(
      folders.map((ref) => ({ kind: 'image', ref })),
    );
    const zone = new FakeZone();
    expect(await sweep({ images: zone, dryRun: true })).toBe(0);
    expect(zone.deleted).toEqual([]);
    // Straight away: deleted, but a PUT link signed before the draft went may still be used, so
    // the rows wait for their final pass (fn::erasure::final_pass_after), tries unchanged.
    expect(await sweep({ images: zone })).toBe(0);
    expect(zone.deleted.sort()).toEqual(folders);
    expect(
      await rows(
        migrator,
        `SELECT VALUE [attempts, nextAttemptAt = finalPassAt, finalPassAt > time::now() + 14m]
         FROM pendingDeletion`,
      ),
    ).toEqual([
      [0, true, true],
      [0, true, true],
    ]);
    expect(await sweep({ images: zone })).toBe(0);
    expect(zone.deleted).toHaveLength(2);
    // Fifteen minutes on: the final pass deletes them again, and they're done.
    await run(
      migrator,
      `UPDATE pendingDeletion SET finalPassAt = time::now() - 1s, nextAttemptAt = time::now() - 1s`,
    );
    expect(await sweep({ images: zone })).toBe(0);
    expect(zone.deleted.slice(2).sort()).toEqual(folders);
    expect(await queued()).toEqual([]);
  });

  it('is safe to run again: nothing left to do', async () => {
    const before = library.deleted.length;
    expect(await sweep()).toBe(0);
    expect(logs.slice(-2)).toEqual([
      expect.objectContaining({
        task: 'expired-drafts',
        selected: 0,
        deleted: 0,
      }),
      expect.objectContaining({
        task: 'orphan-videos',
        selected: 0,
        deleted: 0,
      }),
    ]);
    expect(library.deleted).toHaveLength(before);
  });
});

/**
 * The deletions racing what can make a draft no longer expired (Codex review, round 1). Each test
 * interleaves two sessions deterministically, as libs/database's concurrency suite does: A begins
 * and writes (uncommitted), B runs and commits, then A commits and fails with a retryable
 * conflict. Exactly one of them wins, and the loser's retry sees the winner's write.
 */
describe('housekeeping racing a resumed upload or a form publication', () => {
  const CONFLICT = /Transaction conflict.*can be retried/s;
  let t: TestDatabase;
  let migrator: Surreal;
  let housekeeping: Surreal;
  let apiUser: Surreal;
  let cat: Surreal;
  const commit = async (tx: SurrealTransaction) => {
    try {
      await tx.commit();
      return 'committed';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const exists = async (id: string) =>
    (await rows(migrator, `SELECT id FROM type::record('story', $id)`, { id }))
      .length === 1;
  /** As the expired-drafts chore deletes one. */
  const DELETE = `DELETE type::record('story', $id) WHERE fn::story::draft_expired(id) RETURN BEFORE`;
  /** As api-user renews a grant before signing its link again (Uploads.request, resume). */
  const RENEW = `RETURN fn::upload::renew(type::record('story', $id), user:cat, $video)`;
  /** Cat's video draft with its upload granted, then left for 200 days: expired. */
  async function abandonedVideoDraft(id: string): Promise<string> {
    const video = guid();
    await createDraft(cat, id, 'video');
    const [{ version }] = await rows<{ version: number }>(
      migrator,
      `SELECT version FROM type::record('story', $id)`,
      { id },
    );
    await run(
      apiUser,
      `CREATE type::record('uploadGrant', $video) CONTENT {
         story: type::record('story', $id), person: user:cat, format: 'video',
         contentType: 'video/mp4', sizeBytes: 1000000, durationSeconds: 60,
         storyVersion: $version }`,
      { video, id, version },
    );
    await touch(migrator, id, 200);
    return video;
  }
  const sweep = (library: StreamLibrary) =>
    runTasks(
      CHORES,
      {
        db: housekeeping,
        stream: library,
        dryRun: false,
        maxDeletions: 50,
        now: NOW,
      },
      () => undefined,
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    housekeeping = await t.service('housekeeping');
    apiUser = await t.service('api_user');
    await createPeople(t, { cat: 'user_cat' });
    await publishDpa(t, 'v1');
    await trustSubmitters(t, 'cat');
    cat = await t.person('user_cat');
    await grantAll(cat);
  });
  afterAll(() => t?.close());

  it('a resume that commits first keeps the draft and its video: the deletion conflicts, and its retry finds the draft touched', async () => {
    const video = await abandonedVideoDraft('resumed_first');
    const deleting = await housekeeping.beginTransaction();
    expect(
      await rows(deleting as unknown as Surreal, DELETE, {
        id: 'resumed_first',
      }),
    ).toHaveLength(1); // uncommitted
    const [renewed] = await run(apiUser, RENEW, { id: 'resumed_first', video });
    expect(renewed).toBeTruthy(); // committed: api-user may sign the link
    expect(await commit(deleting)).toMatch(CONFLICT);

    // The next run (or the chore's own retry) leaves the draft, and so its video.
    const library = new FakeLibrary([story(video, ago(240))]);
    expect(await sweep(library)).toBe(0);
    expect(await exists('resumed_first')).toBe(true);
    expect(library.deleted).toEqual([]);
  });

  it('a deletion that commits first refuses the resume: its retry finds no draft, so no link is signed', async () => {
    const video = await abandonedVideoDraft('deleted_first');
    const renewing = await apiUser.beginTransaction();
    const [renewed] = await run(renewing as unknown as Surreal, RENEW, {
      id: 'deleted_first',
      video,
    });
    expect(renewed).toBeTruthy(); // uncommitted
    expect(
      await rows(housekeeping, DELETE, { id: 'deleted_first' }),
    ).toHaveLength(1);
    expect(await commit(renewing)).toMatch(CONFLICT);

    expect(
      await outcome(apiUser, RENEW, { id: 'deleted_first', video }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('nothing_to_resume'),
    });
    expect(await exists('deleted_first')).toBe(false);
    const [grant] = await rows(
      migrator,
      `SELECT renewedAt FROM type::record('uploadGrant', $video)`,
      { video },
    );
    expect(grant.renewedAt ?? null).toBeNull();
  });

  it('a form published with a longer retention while a deletion is open: the deletion conflicts, and its retry keeps the draft', async () => {
    await createDraft(cat, 'outlived', 'written');
    await touch(migrator, 'outlived', 200); // past 6 months, inside 12
    const deleting = await housekeeping.beginTransaction();
    expect(
      await rows(deleting as unknown as Surreal, DELETE, { id: 'outlived' }),
    ).toHaveLength(1); // uncommitted, on the 6 months it read
    await publishForm(t, 'testimony', 'v2', { draftRetentionMonths: 12 });
    expect(await commit(deleting)).toMatch(CONFLICT);

    expect(await sweep(new FakeLibrary([]))).toBe(0);
    expect(await exists('outlived')).toBe(true);
  });
});

/**
 * What erasure left to do (D39, D40, D88): a withdrawal api-user never got to erase, and
 * deletions at Bunny and Clerk that failed. Housekeeping retries them every night, at most
 * maxDeletions each, and a row that keeps failing waits longer each time instead of holding up
 * the rest.
 */
describe('housekeeping: erasure requests and queued deletions', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let housekeeping: Surreal;
  let library: FakeLibrary;
  /** Clerk's users, in memory: the deletes, and which of them fail. */
  class FakeClerk implements ClerkUsers {
    deleted: string[] = [];
    failing = new Set<string>();
    async delete(id: string) {
      if (this.failing.has(id)) throw new Error('Clerk answered 503');
      this.deleted.push(id);
    }
  }
  const clerk = new FakeClerk();
  const logs: Record<string, unknown>[] = [];
  const EVA_VIDEO = guid();
  const FRED_VIDEO = guid();

  const sweep = (over: Partial<TaskContext> = {}) =>
    runTasks(
      [erasureRequestsTask, pendingDeletionsTask],
      {
        db: housekeeping,
        stream: library,
        clerk,
        dryRun: false,
        maxDeletions: 50,
        now: NOW,
        ...over,
      },
      (entry) => logs.push(entry),
    );
  // Their stories' picture folders wait too (no images zone here): the describes either side.
  const queued = () =>
    rows<{ ref: string; attempts: number }>(
      migrator,
      `SELECT ref, attempts FROM pendingDeletion WHERE kind != 'image' ORDER BY ref`,
    );
  const erased = async (who: string) =>
    (
      await rows(
        migrator,
        `SELECT VALUE gdprDeletedAt != NONE FROM ONLY type::record('user', $who)`,
        { who },
      )
    )[0];

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    housekeeping = await t.service('housekeeping');
    const apiUser = await t.service('api_user');
    await publishDpa(t, 'v1');
    await createPeople(t, { eva: 'user_eva', fred: 'user_fred' });
    await trustSubmitters(t, 'eva', 'fred');
    for (const [who, video] of [
      ['eva', EVA_VIDEO],
      ['fred', FRED_VIDEO],
    ]) {
      const person = await t.person(`user_${who}`);
      await grantAll(person);
      await createDraft(person, `${who}_video`, 'video');
      expect(
        await grantUpload(apiUser, {
          video,
          story: `${who}_video`,
          person: who,
          version: 1,
        }),
      ).toMatchObject({ ok: true });
    }
    // Eva withdrew her testimony consent, and api-user stopped before erasing her.
    await consentEvent(
      await t.person('user_eva'),
      'special_category_religious',
      'withdrawn',
    );
    // Fred deleted his account; Bunny and Clerk couldn't be reached, so both deletions wait.
    await run(apiUser, ERASE_ACCOUNT, {
      clerkUserId: 'user_fred',
      reason: 'account_deleted',
    });
    library = new FakeLibrary([
      story(EVA_VIDEO, ago(1)),
      story(FRED_VIDEO, ago(1)),
    ]);
  });
  afterAll(() => t?.close());

  it('in a dry run, only reports what it would do', async () => {
    expect(await sweep({ dryRun: true })).toBe(0);
    expect(logs.slice(-2)).toEqual([
      expect.objectContaining({
        task: 'erasure-requests',
        selected: 1,
        deleted: 0,
        ids: ['eva'],
      }),
      expect.objectContaining({
        task: 'pending-deletions',
        selected: 2,
        deleted: 0,
      }),
    ]);
    expect(await erased('eva')).toBe(false);
    expect(await queued()).toHaveLength(2);
  });

  it('without Clerk’s key, leaves Clerk deletions waiting, untried', async () => {
    expect(await sweep({ clerk: null, maxDeletions: 1, dryRun: true })).toBe(0);
    expect(logs.at(-1)).toMatchObject({
      task: 'pending-deletions',
      selected: 1,
      more: false,
    });
  });

  it('erases whoever is still requested, then works through the queue, a failure pushed back', async () => {
    clerk.failing.add('user_fred');
    expect(await sweep()).toBe(1);
    expect(await erased('eva')).toBe(true);
    expect(
      await rows(
        migrator,
        `SELECT service, reason FROM auditLog WHERE entity = user:eva AND action = 'EraseAccount'`,
      ),
    ).toEqual([{ service: 'housekeeping', reason: 'consent_withdrawn' }]);
    expect(await rows(migrator, `SELECT VALUE id FROM erasureRequest`)).toEqual(
      [],
    );
    // Eva's erasure queued her video and Clerk account; both go the same night.
    expect(library.deleted.sort()).toEqual([EVA_VIDEO, FRED_VIDEO].sort());
    expect(clerk.deleted).toEqual(['user_eva']);
    expect(await queued()).toEqual([{ ref: 'user_fred', attempts: 1 }]);
    expect(logs.at(-1)).toMatchObject({
      task: 'pending-deletions',
      selected: 4,
      deleted: 3,
      failed: 1,
    });
  });

  it('doesn’t try a pushed-back row again before its time, and does once it’s due', async () => {
    clerk.failing.clear();
    expect(await sweep()).toBe(0);
    expect(logs.at(-1)).toMatchObject({
      task: 'pending-deletions',
      selected: 0,
    });
    expect(clerk.deleted).toEqual(['user_eva']);

    await run(
      migrator,
      `UPDATE pendingDeletion SET nextAttemptAt = time::now()`,
    );
    expect(await sweep()).toBe(0);
    expect(clerk.deleted).toEqual(['user_eva', 'user_fred']);
    expect(await queued()).toEqual([]);
  });

  it('can see and change nothing of the queue but its retries', async () => {
    await run(
      housekeeping,
      `CREATE pendingDeletion CONTENT { kind: 'clerk_user', ref: 'user_x' }`,
    );
    expect(await queued()).toEqual([]);
  });
});

/**
 * Startup with Clerk's key unreadable (Codex review, round 2): the erasure requests and Bunny
 * deletions don't need Clerk, so they still go; only the Clerk deletions wait, and the run
 * reports the key as an error and answers 1.
 */
describe('housekeeping startup without Clerk’s or Bunny’s key', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  const PROJECT = 'heisreal-test';
  const secret = (id: string) =>
    `projects/${PROJECT}/secrets/${id}/versions/latest`;
  const GUS_VIDEO = guid();
  const HAL_VIDEO = guid();
  const HAL_PICTURE = `stories/hal_video/${'e'.repeat(32)}.webp`;
  const FOLDERS = ['stories/gus_video/', 'stories/hal_video/'];

  const disabled = () => {
    throw new Error(
      '9 FAILED_PRECONDITION: Secret Version is in DISABLED state.',
    );
  };
  /**
   * Secret Manager, in memory: the DB password reads; Clerk's and Bunny's keys and the images
   * zone's password as given.
   */
  const start = (
    clerkKey: () => string,
    bunnyKey = () => 'bunny-key',
    zonePassword: () => string = disabled,
  ) => {
    const payloads: Record<string, string> = {
      [secret('surreal-password-housekeeping')]:
        t.servicePasswords.get('housekeeping') ?? '',
    };
    const client = {
      accessSecretVersion: async ({ name }: { name: string }) => [
        {
          payload: {
            data:
              name === secret('clerk-secret-key')
                ? clerkKey()
                : name === secret('bunny-stream-api-key')
                  ? bunnyKey()
                  : name === secret('bunny-storage-password')
                    ? zonePassword()
                    : payloads[name],
          },
        },
      ],
    } as unknown as SecretAccessor;
    const library = new FakeLibrary([
      story(GUS_VIDEO, ago(1)),
      story(HAL_VIDEO, ago(1)),
    ]);
    const clerkMade: string[] = [];
    const zone = new FakeZone();
    const zoneMade: { name: string; host: string }[] = [];
    const logs: Record<string, unknown>[] = [];
    const exitCode = startHousekeeping({
      config: {
        project: PROJECT,
        database: {
          url: t.url,
          namespace: t.namespace,
          database: t.database,
          username: 'housekeeping',
          passwordSecret: 'surreal-password-housekeeping',
        },
        stream: { libraryId: '1', keySecret: 'bunny-stream-api-key' },
        clerkKeySecret: 'clerk-secret-key',
        images: {
          zone: 'test-zone',
          s3Host: 'uk-s3.storage.bunnycdn.com',
          passwordSecret: 'bunny-storage-password',
        },
        dryRun: false,
        maxDeletions: 50,
      },
      secrets: new SecretsService(client, PROJECT),
      log: (entry) => logs.push(entry),
      stream: () => library,
      clerk: (key) => {
        clerkMade.push(key);
        throw new Error('Clerk must not be used');
      },
      images: ({ name, host }) => {
        zoneMade.push({ name, host });
        return zone;
      },
    });
    return { exitCode, library, logs, clerkMade, zone, zoneMade };
  };
  const queued = () =>
    rows<{ kind: string; ref: string; attempts: number }>(
      migrator,
      `SELECT kind, ref, attempts FROM pendingDeletion ORDER BY ref`,
    );

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    const apiUser = await t.service('api_user');
    await publishDpa(t, 'v1');
    await createPeople(t, { gus: 'user_gus', hal: 'user_hal' });
    await trustSubmitters(t, 'gus', 'hal');
    for (const [who, video] of [
      ['gus', GUS_VIDEO],
      ['hal', HAL_VIDEO],
    ]) {
      const person = await t.person(`user_${who}`);
      await grantAll(person);
      await createDraft(person, `${who}_video`, 'video');
      expect(
        await grantUpload(apiUser, {
          video,
          story: `${who}_video`,
          person: who,
          version: 1,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      await grantImage(apiUser, {
        story: 'hal_video',
        person: 'hal',
        version: 2,
        path: HAL_PICTURE,
      }),
    ).toMatchObject({ ok: true });
    // Gus withdrew his testimony consent and wasn't erased; Hal deleted his account and all his
    // deletions wait.
    await consentEvent(
      await t.person('user_gus'),
      'special_category_religious',
      'withdrawn',
    );
    await run(apiUser, ERASE_ACCOUNT, {
      clerkUserId: 'user_hal',
      reason: 'account_deleted',
    });
  });
  afterAll(() => t?.close());

  // First: the later cases delete the videos this one leaves queued.
  it('with no usable Bunny key either, still erases, and leaves the video deletions queued, untried', async () => {
    const { exitCode, library, logs, zone } = start(disabled, () => '');
    expect(await exitCode).toBe(1);
    expect(logs[0]).toEqual({
      severity: 'ERROR',
      error: expect.stringContaining('bunny-stream-api-key'),
    });
    expect(logs[2]).toEqual({
      severity: 'ERROR',
      error: expect.stringContaining('bunny-storage-password'),
    });
    expect(logs[3]).toMatchObject({
      stream: false,
      clerk: false,
      images: false,
    });
    expect(zone.deleted).toEqual([]);
    expect(
      await rows(migrator, `SELECT VALUE gdprDeletedAt != NONE FROM user:gus`),
    ).toEqual([true]);
    expect(library.deleted).toEqual([]);
    expect(await queued()).toEqual(
      expect.arrayContaining([
        { kind: 'bunny_video', ref: GUS_VIDEO, attempts: 0 },
        { kind: 'bunny_video', ref: HAL_VIDEO, attempts: 0 },
        { kind: 'image', ref: FOLDERS[0], attempts: 0 },
        { kind: 'image', ref: FOLDERS[1], attempts: 0 },
        { kind: 'clerk_user', ref: 'user_gus', attempts: 0 },
        { kind: 'clerk_user', ref: 'user_hal', attempts: 0 },
      ]),
    );
  });

  it('with no enabled version of the key, erases and deletes at Bunny, and leaves Clerk’s deletions queued, untried', async () => {
    const { exitCode, library, logs, clerkMade } = start(disabled);
    expect(await exitCode).toBe(1);
    expect(logs[0]).toEqual({
      severity: 'ERROR',
      error: expect.stringContaining('clerk-secret-key'),
    });
    expect(logs[2]).toMatchObject({ clerk: false, images: false });
    expect(clerkMade).toEqual([]);
    expect(
      await rows(migrator, `SELECT VALUE gdprDeletedAt != NONE FROM user:gus`),
    ).toEqual([true]);
    expect(library.deleted.sort()).toEqual([GUS_VIDEO, HAL_VIDEO].sort());
    expect(await queued()).toEqual([
      ...FOLDERS.map((ref) => ({ kind: 'image', ref, attempts: 0 })),
      { kind: 'clerk_user', ref: 'user_gus', attempts: 0 },
      { kind: 'clerk_user', ref: 'user_hal', attempts: 0 },
    ]);
  });

  it('with a value that isn’t a Clerk key, does the same and never logs the value', async () => {
    const { exitCode, logs, clerkMade } = start(() => 'not-a-clerk-key');
    expect(await exitCode).toBe(1);
    expect(logs[0]).toMatchObject({ severity: 'ERROR' });
    expect(JSON.stringify(logs)).not.toContain('not-a-clerk-key');
    expect(clerkMade).toEqual([]);
    expect(await queued()).toHaveLength(4);
  });

  it('once the images zone’s password can be read, deletes the erased people’s picture folders, never logging the password', async () => {
    const { exitCode, logs, zone, zoneMade } = start(
      disabled,
      undefined,
      () => 'zone-password-value',
    );
    expect(await exitCode).toBe(1); // Clerk's key still can't be used
    expect(zoneMade).toEqual([
      { name: 'test-zone', host: 'uk-s3.storage.bunnycdn.com' },
    ]);
    expect(logs[1]).toMatchObject({ images: true });
    expect(zone.deleted.sort()).toEqual(FOLDERS);
    expect(JSON.stringify(logs)).not.toContain('zone-password-value');
    // Deleted, and their final passes still to come.
    expect((await queued()).map((r) => r.kind)).toEqual([
      'image',
      'image',
      'clerk_user',
      'clerk_user',
    ]);
  });
});

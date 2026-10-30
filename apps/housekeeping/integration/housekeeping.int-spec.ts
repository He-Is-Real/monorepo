import {
  createPeople,
  grantAll,
  publishDpa,
  rows,
  run,
  TestDatabase,
  trustSubmitters,
} from '@heisreal/database/integration-testing';
import type { Surreal } from 'surrealdb';
import { CHORES } from '../src/app/chores';
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

describe('housekeeping: abandoned drafts and orphaned videos', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let housekeeping: Surreal;
  let library: FakeLibrary;
  const V = {} as Record<string, string>;
  const logs: Record<string, unknown>[] = [];

  const exists = async (id: string) =>
    (await rows(migrator, `SELECT id FROM type::record('story', $id)`, { id }))
      .length === 1;
  /** As a system user may (the schema lets only those set it): when the story was last touched. */
  const touched = (
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
  const media = (v: string) => ({
    media: [{ format: 'video', bunnyVideoId: v }],
  });
  const draft = (person: Surreal, id: string, format: 'written' | 'video') =>
    run(
      person,
      `CREATE type::record('story', $id) CONTENT {
         submitter: $auth, slug: $id, title: 'Story ' + $id, description: 'How I came to faith',
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
    await touched('old_written_draft', 190);
    await draft(ann, 'young_draft', 'video');
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
    expect(await exists('young_draft')).toBe(true);
    expect(await exists('old_pending')).toBe(true);
    expect(await exists('old_withdrawn')).toBe(true);
    expect(await rows(migrator, `SELECT id FROM uploadGrant`)).toHaveLength(2);
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

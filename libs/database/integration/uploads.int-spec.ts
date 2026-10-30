import type { Surreal } from 'surrealdb';
import {
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { draft, grantUpload, processed } from './support/world';

/**
 * Video and audio uploads (M2 plan PR 7; D65, D80, D113). api-user's own login creates an upload
 * grant once it has created the video at Bunny, and the grant's event puts it on the person's
 * draft. The database refuses everything else: a person's session never writes media, no Bunny id
 * reaches a story without a grant for that story, and the per-person upload limits hold whatever
 * happens to stories or videos afterwards.
 */
describe('uploads: grants, server-assigned media and their limits (D65, D80, D113)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;

  async function person(p: string): Promise<Surreal> {
    await createPeople(t, { [p]: `user_${p}` });
    const s = await t.person(`user_${p}`);
    await grantAll(s);
    return s;
  }
  const video = (s: Surreal, id: string) =>
    draft(s, id, { primaryFormat: 'video', body: undefined });
  const story = async (id: string) =>
    (
      await rows<{
        version: number;
        media: Record<string, unknown>[];
      }>(migrator, `SELECT version, media FROM type::record('story', $id)`, {
        id,
      })
    )[0];
  const settings = (fields: Record<string, unknown>) =>
    run(
      admin,
      `UPDATE submissionSettings:current MERGE object::extend($fields, { changedBy: user:admin })`,
      { fields },
    );
  const limits = (p: string, fields: Record<string, unknown>) =>
    run(
      admin,
      `UPSERT type::record('submitterLimits', $p) MERGE object::extend($fields, {
         user: type::record('user', $p), changedBy: user:admin })`,
      { p, fields },
    );
  const error = (o: { ok: boolean; error?: string }) => (o.ok ? '' : o.error);
  let n = 0;
  const vid = () => `0f0e0d0c-0b0a-4908-8706-${String(++n).padStart(12, '0')}`;

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    apiUser = await t.service('api_user');
    workflow = await t.service('workflow');
    await createPeople(t, { admin: 'user_admin' });
    await publishDpa(t, 'v1');
  });
  afterAll(() => t?.close());

  it('puts the video api-user granted on the draft, in the same write, one version on', async () => {
    const ann = await person('ann');
    await video(ann, 'ann_v');
    const v = vid();
    expect(
      await grantUpload(apiUser, {
        video: v,
        story: 'ann_v',
        person: 'ann',
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    expect(await story('ann_v')).toEqual({
      version: 2,
      media: [{ format: 'video', bunnyVideoId: v }],
    });
    // The person sees it on their own story, and reads their own grant.
    expect(
      await rows(ann, 'SELECT VALUE media[0].bunnyVideoId FROM story:ann_v'),
    ).toEqual([v]);
    expect(
      await rows(ann, 'SELECT VALUE record::id(id) FROM uploadGrant'),
    ).toEqual([v]);
  });

  it('never lets a person’s session set a video or thumbnail, not even one granted to someone else', async () => {
    const bob = await person('bob');
    const cat = await person('cat');
    await video(bob, 'bob_v');
    await video(cat, 'cat_v');
    const catsVideo = vid();
    await grantUpload(apiUser, {
      video: catsVideo,
      story: 'cat_v',
      person: 'cat',
      version: 1,
    });
    for (const set of [
      `media = [{ format: 'video', bunnyVideoId: '${catsVideo}' }]`,
      `media = [{ format: 'video', bunnyVideoId: '${vid()}' }]`,
      `media = [{ format: 'video', bunnyVideoId: '${catsVideo}',
         thumbnailPath: '${catsVideo}/thumbnail_1.jpg' }]`,
    ]) {
      await run(bob, `UPDATE story:bob_v SET ${set}`);
      expect((await story('bob_v')).media).toEqual([]);
    }
    // Nor at creation.
    await draft(bob, 'bob_v2', {
      primaryFormat: 'video',
      body: undefined,
      media: [{ format: 'video', bunnyVideoId: catsVideo }],
    });
    expect((await story('bob_v2')).media).toEqual([]);
    // Nor by making a grant itself (refused: nothing written).
    await grantUpload(bob, {
      video: vid(),
      story: 'bob_v',
      person: 'bob',
      version: 1,
    });
    expect(
      await rows(
        migrator,
        'SELECT id FROM uploadGrant WHERE person = user:bob',
      ),
    ).toEqual([]);
  });

  it('refuses any other story’s video, whoever writes', async () => {
    const dan = await person('dan');
    const eve = await person('eve');
    await video(dan, 'dan_v');
    await video(eve, 'eve_v');
    const dans = vid();
    const eves = vid();
    await grantUpload(apiUser, {
      video: dans,
      story: 'dan_v',
      person: 'dan',
      version: 1,
    });
    await grantUpload(apiUser, {
      video: eves,
      story: 'eve_v',
      person: 'eve',
      version: 1,
    });
    // Workflow writes media (processing), but can't swap in another story's video or an
    // ungranted one.
    for (const id of [eves, vid()]) {
      expect(
        error(
          await outcome(
            workflow,
            `UPDATE story:dan_v SET media[0].bunnyVideoId = $id`,
            { id },
          ),
        ),
      ).toMatch(/media_not_granted:/);
    }
    expect((await story('dan_v')).media).toEqual([
      { format: 'video', bunnyVideoId: dans },
    ]);
    // A video is granted once: the same Bunny id can't be granted to a second story.
    expect(
      await grantUpload(apiUser, {
        video: dans,
        story: 'eve_v',
        person: 'eve',
        version: 2,
      }),
    ).toMatchObject({ ok: false });
    // A grant naming someone else's story, or the wrong person, attaches nothing.
    expect(
      error(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'eve_v',
          person: 'dan',
          version: 2,
        }),
      ),
    ).toMatch(/upload_refused:/);
    expect((await story('eve_v')).media).toEqual([
      { format: 'video', bunnyVideoId: eves },
    ]);
  });

  it('refuses a stale version, a submitted story and the wrong format', async () => {
    const fay = await person('fay');
    await video(fay, 'fay_v');
    await draft(fay, 'fay_w');
    expect(
      error(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'fay_v',
          person: 'fay',
          version: 7,
        }),
      ),
    ).toMatch(/story_cmd:stale_version/);
    expect(
      error(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'fay_w',
          person: 'fay',
          version: 1,
        }),
      ),
    ).toMatch(/upload_refused: a written story/);
    expect(
      error(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'fay_v',
          person: 'fay',
          version: 1,
          format: 'audio',
        }),
      ),
    ).toMatch(/upload_refused: a video story/);
    await grantUpload(apiUser, {
      video: vid(),
      story: 'fay_v',
      person: 'fay',
      version: 1,
    });
    await run(fay, `UPDATE story:fay_v SET status = 'pending'`);
    expect(
      error(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'fay_v',
          person: 'fay',
          version: 3,
        }),
      ),
    ).toMatch(/story_cmd:locked/);
    expect(
      await rows(
        migrator,
        'RETURN count(SELECT id FROM uploadGrant WHERE person = user:fay)',
      ),
    ).toEqual([1]);
  });

  it('replacing the file starts processing again and keeps the old grant for the limits', async () => {
    const gus = await person('gus');
    await video(gus, 'gus_v');
    const first = vid();
    const second = vid();
    await grantUpload(apiUser, {
      video: first,
      story: 'gus_v',
      person: 'gus',
      version: 1,
    });
    await processed(workflow, 'gus_v');
    expect((await story('gus_v')).media[0]).toMatchObject({
      bunnyVideoId: first,
      processing: 'ready',
      width: 1080,
    });
    await grantUpload(apiUser, {
      video: second,
      story: 'gus_v',
      person: 'gus',
      version: 3,
    });
    expect(await story('gus_v')).toEqual({
      version: 4,
      media: [{ format: 'video', bunnyVideoId: second }],
    });
    expect(
      await rows(
        gus,
        'SELECT VALUE record::id(id) FROM uploadGrant WHERE person = $auth ORDER BY at',
      ),
    ).toEqual([first, second]);
  });

  describe('limits an admin adjusts (D113; Joel, 2026-10-30)', () => {
    afterEach(() =>
      settings({
        uploadRequestsPerHour: 10,
        uploadsPer7Days: 5,
        videoMaxBytes: 4294967296,
        audioMaxBytes: 524288000,
        mediaMaxSeconds: 900,
      }),
    );

    it('starts from today’s values, and caps what a setting may allow', async () => {
      expect(await rows(migrator, `RETURN fn::settings::submission()`)).toEqual(
        [
          expect.objectContaining({
            uploadRequestsPerHour: 10,
            uploadsPer7Days: 5,
            videoMaxBytes: 4294967296,
            audioMaxBytes: 524288000,
            mediaMaxSeconds: 900,
          }),
        ],
      );
      for (const over of [
        { videoMaxBytes: 10737418241 },
        { audioMaxBytes: 2147483649 },
        { mediaMaxSeconds: 10801 },
        { uploadsPer7Days: 0 },
      ]) {
        expect(
          (
            await outcome(
              admin,
              `UPDATE submissionSettings:current MERGE object::extend($f, { changedBy: user:admin })`,
              { f: over },
            )
          ).ok,
        ).toBe(false);
      }
    });

    it('refuses a file over the size or length in force, and says when the next upload is allowed', async () => {
      const hal = await person('hal');
      await video(hal, 'hal_v');
      await settings({ videoMaxBytes: 1000, mediaMaxSeconds: 30 });
      expect(
        error(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'hal_v',
            person: 'hal',
            version: 1,
            sizeBytes: 1001,
            durationSeconds: 10,
          }),
        ),
      ).toMatch(/limit_upload_size:/);
      expect(
        error(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'hal_v',
            person: 'hal',
            version: 1,
            sizeBytes: 1000,
            durationSeconds: 31,
          }),
        ),
      ).toMatch(/limit_upload_duration:/);
      expect((await story('hal_v')).media).toEqual([]);

      // Two new uploads an hour: the third is refused, until an hour after the first.
      await settings({ uploadRequestsPerHour: 2 });
      for (const version of [1, 2]) {
        expect(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'hal_v',
            person: 'hal',
            version,
            sizeBytes: 10,
            durationSeconds: 10,
          }),
        ).toMatchObject({ ok: true });
      }
      expect(
        error(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'hal_v',
            person: 'hal',
            version: 3,
            sizeBytes: 10,
            durationSeconds: 10,
          }),
        ),
      ).toMatch(/limit_upload_hourly:/);
      const [first] = await rows<string>(
        hal,
        'SELECT VALUE at FROM uploadGrant WHERE person = $auth ORDER BY at ASC',
      );
      const [next] = await rows<string>(
        hal,
        'RETURN fn::upload::next_allowed_at($auth)',
      );
      expect(new Date(next).getTime() - new Date(first).getTime()).toBe(
        3600_000,
      );
    });

    it('counts uploads per rolling 7 days; a trusted submitter has no weekly, size or length limit, but the hourly one', async () => {
      const ida = await person('ida');
      await video(ida, 'ida_v');
      await settings({ uploadsPer7Days: 1, videoMaxBytes: 1000 });
      await grantUpload(apiUser, {
        video: vid(),
        story: 'ida_v',
        person: 'ida',
        version: 1,
        sizeBytes: 10,
      });
      expect(
        error(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'ida_v',
            person: 'ida',
            version: 2,
            sizeBytes: 10,
          }),
        ),
      ).toMatch(/limit_upload_weekly:/);
      // An admin's override for this person.
      await limits('ida', { uploadsPer7Days: 2 });
      expect(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'ida_v',
          person: 'ida',
          version: 2,
          sizeBytes: 10,
        }),
      ).toMatchObject({ ok: true });

      await limits('ida', { trusted: true, uploadRequestsPerHour: 3 });
      expect(
        await grantUpload(apiUser, {
          video: vid(),
          story: 'ida_v',
          person: 'ida',
          version: 3,
          sizeBytes: 5_000_000_000,
          durationSeconds: 3600,
        }),
      ).toMatchObject({ ok: true });
      expect(
        error(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'ida_v',
            person: 'ida',
            version: 4,
            sizeBytes: 10,
          }),
        ),
      ).toMatch(/limit_upload_hourly:/);
      expect(
        error(
          await grantUpload(apiUser, {
            video: vid(),
            story: 'ida_v',
            person: 'ida',
            version: 4,
            sizeBytes: 10_737_418_241,
          }),
        ),
      ).toMatch(/limit_upload_size:/);
    });
  });
});

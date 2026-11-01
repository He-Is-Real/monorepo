import type { Surreal } from 'surrealdb';
import {
  createPeople,
  agreeAll,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { PENDING_DELETION_DONE } from '../src/lib/erasure';
import {
  draft,
  ERASE,
  grantImage,
  grantUpload,
  storyText,
} from './support/world';

/**
 * Images (M2 plan PR 10; D53, D65, D80): a written story's image or an audio story's picture is
 * server-assigned like a video. api-user names the file `stories/<story>/<random>.webp` and records
 * an upload grant on its own login; the grant's event puts the path, size and description on the
 * draft. Nothing else puts an image on a story: the person's session may only change the
 * description (never required) or remove it.
 */
describe('images: server-assigned, in the story’s own folder, only through a grant (D65, D80)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;

  async function person(p: string): Promise<Surreal> {
    await createPeople(t, { [p]: `user_${p}` });
    const s = await t.person(`user_${p}`);
    await agreeAll(s);
    return s;
  }
  const image = async (id: string) =>
    (
      await rows<{ version: number; image?: Record<string, unknown> }>(
        migrator,
        `SELECT version, image FROM type::record('story', $id)`,
        { id },
      )
    )[0];
  const error = (o: { ok: boolean; error?: string }) => (o.ok ? '' : o.error);
  const hex = (n: number) => String(n).padStart(32, '0');

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
    workflow = await t.service('workflow');
  });
  afterAll(() => t?.close());

  it('puts the granted image on a written, audio or video draft, and processing never overwrites it', async () => {
    const ann = await person('ann');
    await draft(ann, 'ann_w');
    expect(
      await grantImage(apiUser, { story: 'ann_w', person: 'ann', version: 1 }),
    ).toMatchObject({ ok: true });
    expect(await image('ann_w')).toEqual({
      version: 2,
      image: {
        path: `stories/ann_w/${'a'.repeat(32)}.webp`,
        width: 900,
        height: 1200,
        alt: 'A sunrise over the hills',
      },
    });

    // An audio story's picture (it becomes the clip's thumbnail).
    await draft(ann, 'ann_a', { primaryFormat: 'audio', body: undefined });
    expect(
      await grantImage(apiUser, {
        story: 'ann_a',
        person: 'ann',
        version: 1,
        alt: null,
        width: 1280,
        height: 720,
      }),
    ).toMatchObject({ ok: true });
    expect((await image('ann_a')).image).toMatchObject({ width: 1280 });

    // A video's own thumbnail (Joel, 2026-10-30), in place of Bunny's.
    await draft(ann, 'ann_v', { primaryFormat: 'video', body: undefined });
    expect(
      await grantImage(apiUser, {
        story: 'ann_v',
        person: 'ann',
        version: 1,
        width: 1280,
        height: 720,
      }),
    ).toMatchObject({ ok: true });
    // Processing (workflow, as the media-ready step will run) can never overwrite it.
    for (const set of [
      `image = { path: 'x/thumbnail_1.jpg', width: 1080, height: 1920 }`,
      `image.path = 'x/thumbnail_1.jpg'`,
      `image = NONE`,
    ]) {
      await run(workflow, `UPDATE story:ann_v SET ${set}`);
    }
    expect((await image('ann_v')).image).toMatchObject({
      path: `stories/ann_v/${'a'.repeat(32)}.webp`,
      width: 1280,
    });
  });

  it('refuses an image path outside the story’s own folder, or not named as api-user names it', async () => {
    const bob = await person('bob');
    const cat = await person('cat');
    await draft(bob, 'bob_w');
    await draft(cat, 'cat_w');
    for (const path of [
      `stories/cat_w/${hex(1)}.webp`, // another story's folder
      `stories/bob_w/../cat_w/${hex(2)}.webp`,
      `stories/bob_w/sub/${hex(3)}.webp`,
      `${hex(4)}.webp`,
      `site-assets/${hex(5)}.webp`,
      `stories/bob_w/${hex(6)}.jpg`,
      `stories/bob_w/not-a-random-name-at-all-000000000.webp`,
    ]) {
      expect(
        error(
          await grantImage(apiUser, {
            story: 'bob_w',
            person: 'bob',
            version: 1,
            path,
          }),
        ),
      ).toMatch(/upload_refused: an image goes in its story’s own folder/);
    }
    expect((await image('bob_w')).image).toBeUndefined();
    expect(
      await rows(
        migrator,
        'SELECT id FROM uploadGrant WHERE person = user:bob',
      ),
    ).toEqual([]);
  });

  it('keeps a story’s picture path in its own folder whoever writes it, so nothing can be pointed at another story’s file', async () => {
    const dee = await person('dee');
    await draft(dee, 'dee_w');
    await draft(dee, 'dee_x');
    expect(
      await grantImage(apiUser, { story: 'dee_x', person: 'dee', version: 1 }),
    ).toMatchObject({ ok: true });
    const other = `stories/dee_x/${'a'.repeat(32)}.webp`; // dee_x's real, granted file
    const outside = [
      other,
      `stories/dee_w/../dee_x/${hex(7)}.webp`,
      `stories/dee_w/sub/${hex(8)}.webp`,
      `site-assets/${hex(9)}.webp`,
      `dev-seed/image-01.webp`,
    ];
    const set = (who: Surreal, path: string) =>
      run(
        who,
        `UPDATE story:dee_w SET image = { path: $path, width: 900, height: 1200 }`,
        { path },
      );
    // A system user (dev-seed's, which may write anything else) is refused by the field itself;
    // api-user's login gets nothing on either.
    for (const path of outside.slice(0, -1)) {
      await expect(set(migrator, path)).rejects.toThrow(
        /image\.path|own_image/,
      );
      expect((await image('dee_w')).image).toBeUndefined();
    }
    for (const path of outside) {
      await set(apiUser, path).catch(() => undefined);
      expect((await image('dee_w')).image).toBeUndefined();
    }
    // The person's own session can't put any path on (the image's VALUE drops it).
    await set(dee, other).catch(() => undefined);
    expect((await image('dee_w')).image).toBeUndefined();
    // What is taken: the story's own folder, and (system users only) dev-seed's fixed files.
    await set(migrator, `stories/dee_w/${hex(10)}.webp`);
    expect((await image('dee_w')).image).toMatchObject({
      path: `stories/dee_w/${hex(10)}.webp`,
    });
    await set(migrator, 'dev-seed/image-01.webp');
    expect((await image('dee_w')).image).toMatchObject({
      path: 'dev-seed/image-01.webp',
    });
  });

  it('refuses another type, too big, or the wrong shape or size; takes one with no description', async () => {
    const dan = await person('dan');
    await draft(dan, 'dan_w');
    const cases: [Partial<Parameters<typeof grantImage>[1]>, RegExp][] = [
      [{ contentType: 'image/jpeg' }, /an image is a WebP/],
      [{ sizeBytes: 5_242_881 }, /limit_upload_size:/],
      [{ width: 3700, height: 1200 }, /pixel size or shape/], // wider than 3:1
      [{ width: 150, height: 300 }, /pixel size or shape/],
      [{ width: 4097, height: 4000 }, /pixel size or shape/],
    ];
    for (const [g, refused] of cases) {
      expect(
        error(
          await grantImage(apiUser, {
            story: 'dan_w',
            person: 'dan',
            version: 1,
            ...g,
          }),
        ),
      ).toMatch(refused);
    }
    expect((await image('dan_w')).image).toBeUndefined();
    // A description is never required, on any type (Joel, 2026-10-30).
    expect(
      await grantImage(apiUser, {
        story: 'dan_w',
        person: 'dan',
        version: 1,
        alt: null,
      }),
    ).toMatchObject({ ok: true });
    expect((await image('dan_w')).image).not.toHaveProperty('alt');
  });

  it('puts an image on a story only through a grant: the person may change only its description, or remove it', async () => {
    const eve = await person('eve');
    const fay = await person('fay');
    await draft(eve, 'eve_w');
    await draft(fay, 'fay_w');
    await grantImage(apiUser, {
      story: 'fay_w',
      person: 'fay',
      version: 1,
      name: hex(7),
    });
    const fays = `stories/fay_w/${hex(7)}.webp`;

    // The person's session: not on create, not by update, not even a path granted to them.
    await draft(eve, 'eve_w2', {
      image: { path: fays, width: 900, height: 1200, alt: 'x' },
    });
    expect((await image('eve_w2')).image).toBeUndefined();
    for (const set of [
      `image = { path: '${fays}', width: 900, height: 1200, alt: 'x' }`,
      `image = { path: 'stories/eve_w/${hex(8)}.webp', width: 900, height: 1200, alt: 'x' }`,
    ]) {
      await run(eve, `UPDATE story:eve_w SET ${set}`);
      expect((await image('eve_w')).image).toBeUndefined();
    }

    expect(
      await grantImage(apiUser, {
        story: 'eve_w',
        person: 'eve',
        version: (await image('eve_w')).version,
        name: hex(9),
      }),
    ).toMatchObject({ ok: true });
    const eves = `stories/eve_w/${hex(9)}.webp`;
    for (const set of [
      `image.path = '${fays}'`,
      `image = { path: '${fays}', width: 900, height: 1200, alt: 'x' }`,
      `image.width = 3000`,
    ]) {
      await run(eve, `UPDATE story:eve_w SET ${set}`);
      expect((await image('eve_w')).image).toMatchObject({
        path: eves,
        width: 900,
      });
    }
    // Workflow (processing) can't swap the file either.
    await run(workflow, `UPDATE story:eve_w SET image.path = '${fays}'`);
    expect((await image('eve_w')).image).toMatchObject({ path: eves });

    // The description is the person's, and they may remove the image.
    await run(eve, `UPDATE story:eve_w SET image.alt = 'Our church at dawn'`);
    expect((await image('eve_w')).image).toEqual({
      path: eves,
      width: 900,
      height: 1200,
      alt: 'Our church at dawn',
    });
    await run(eve, `UPDATE story:eve_w SET image = NONE`);
    expect((await image('eve_w')).image).toBeUndefined();
  });

  it('a new image replaces the old one, starts processing again and counts per hour, never towards the weekly limit (Joel, 2026-10-30)', async () => {
    const gus = await person('gus');
    await draft(gus, 'gus_w');
    await grantImage(apiUser, {
      story: 'gus_w',
      person: 'gus',
      version: 1,
      name: hex(10),
    });
    await run(workflow, `UPDATE story:gus_w SET image.processing = 'ready'`);
    expect((await image('gus_w')).image).toMatchObject({ processing: 'ready' });
    await grantImage(apiUser, {
      story: 'gus_w',
      person: 'gus',
      version: 3,
      name: hex(11),
      expectedImage: `stories/gus_w/${hex(10)}.webp`,
    });
    expect((await image('gus_w')).image).toEqual({
      path: `stories/gus_w/${hex(11)}.webp`,
      width: 900,
      height: 1200,
      alt: 'A sunrise over the hills',
    });
    // Both grants stay (the old file may still be on a public copy).
    expect(
      await rows(
        gus,
        'SELECT VALUE format FROM uploadGrant WHERE person = $auth ORDER BY at',
      ),
    ).toEqual(['image', 'image']);
    // The weekly limit is for video and audio files only: with one a week, gus's two pictures
    // leave room for a video, then a picture is still allowed and a second video isn't.
    await draft(gus, 'gus_v', { primaryFormat: 'video', body: undefined });
    await run(
      migrator,
      `UPSERT submitterLimits:gus CONTENT { user: user:gus, uploadsPer7Days: 1 }`,
    );
    const next = async (format: string) =>
      (
        await rows(gus, 'RETURN fn::upload::next_allowed_at($auth, $format)', {
          format,
        })
      )[0];
    expect((await next('video')) ?? null).toBeNull();
    expect(
      await grantUpload(apiUser, {
        video: '0f0e0d0c-0b0a-4908-8706-000000000001',
        story: 'gus_v',
        person: 'gus',
        version: 1,
      }),
    ).toMatchObject({ ok: true });
    expect(await next('video')).toEqual(expect.any(String));
    expect((await next('image')) ?? null).toBeNull();
    expect(
      await grantImage(apiUser, {
        story: 'gus_w',
        person: 'gus',
        version: (await image('gus_w')).version,
        name: hex(12),
        expectedImage: `stories/gus_w/${hex(11)}.webp`,
      }),
    ).toMatchObject({ ok: true });
    expect(
      error(
        await grantUpload(apiUser, {
          video: '0f0e0d0c-0b0a-4908-8706-000000000002',
          story: 'gus_v',
          person: 'gus',
          version: 2,
        }),
      ),
    ).toMatch(/limit_upload_weekly:/);
  });

  it('refuses a picture asked for while the story showed another one, whatever its version (Codex #140 round 3)', async () => {
    const hal = await person('hal');
    await draft(hal, 'hal_w');
    const first = `stories/hal_w/${hex(20)}.webp`;
    // A page that knew of no picture, while another tab put one on: refused, at the new version too.
    await grantImage(apiUser, {
      story: 'hal_w',
      person: 'hal',
      version: 1,
      name: hex(20),
      expectedImage: null,
    });
    const stale = {
      story: 'hal_w',
      person: 'hal',
      version: 2,
      name: hex(21),
      expectedImage: null,
    };
    expect(error(await grantImage(apiUser, stale))).toMatch(/image_changed:/);
    // Nothing changed, and nothing counted.
    expect(await image('hal_w')).toMatchObject({
      version: 2,
      image: { path: first },
    });
    expect(
      await rows(hal, 'SELECT VALUE id FROM uploadGrant WHERE person = $auth'),
    ).toHaveLength(1);
    // The person chose to replace the picture they were shown.
    expect(
      await grantImage(apiUser, { ...stale, expectedImage: first }),
    ).toMatchObject({ ok: true });
    // Taken off in another tab: a page that still shows it is refused.
    await run(hal, `UPDATE story:hal_w SET image = NONE`);
    expect(
      error(
        await grantImage(apiUser, {
          ...stale,
          version: 4,
          name: hex(22),
          expectedImage: `stories/hal_w/${hex(21)}.webp`,
        }),
      ),
    ).toMatch(/image_changed:/);
  });
});

/**
 * A deleted story's pictures (D82, D40; Codex #140 round 4): every picture of a story lives in
 * `stories/<its id>/`, so its delete queues that folder from the story row, whoever deletes it,
 * never from its upload grants (pruned after 7 days once no longer the picture). The row's last
 * try waits until a PUT link signed before the delete has expired.
 */
describe('a deleted story’s picture folder is queued from the story, never its grants (D82)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  const hex = (n: number) => String(n).padStart(32, '0');
  const queued = () =>
    rows<Record<string, unknown>>(
      migrator,
      `SELECT record::id(id) AS key, kind, ref,
         finalPassAt != NONE AND finalPassAt > at + 14m AND finalPassAt <= at + 15m AS waits
       FROM pendingDeletion ORDER BY ref`,
    );
  async function person(p: string): Promise<Surreal> {
    await createPeople(t, { [p]: `user_${p}` });
    const s = await t.person(`user_${p}`);
    await agreeAll(s);
    return s;
  }

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    apiUser = await t.service('api_user');
  });
  afterAll(() => t?.close());
  afterEach(() => run(migrator, 'DELETE pendingDeletion'));

  it('erasure queues the folder of a picture whose grant was pruned (Codex #140 round 4)', async () => {
    const ivy = await person('ivy');
    await draft(ivy, 'ivy_w');
    await draft(ivy, 'ivy_x');
    // A picture uploaded eight days ago (only the database owner can date a grant), then removed.
    await run(
      migrator,
      `DEFINE FIELD OVERWRITE at ON uploadGrant TYPE datetime DEFAULT time::now() - 8d`,
    );
    expect(
      await grantImage(apiUser, {
        story: 'ivy_w',
        person: 'ivy',
        version: 1,
        name: hex(1),
      }),
    ).toMatchObject({ ok: true });
    await run(
      migrator,
      `DEFINE FIELD OVERWRITE at ON uploadGrant TYPE datetime VALUE $before OR time::now() READONLY`,
    );
    await run(ivy, `UPDATE story:ivy_w SET image = NONE`);
    // Another upload prunes the old grant: it is no longer any story's picture.
    expect(
      await grantImage(apiUser, {
        story: 'ivy_x',
        person: 'ivy',
        version: 1,
        name: hex(2),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await rows(migrator, `SELECT VALUE record::id(id) FROM uploadGrant`),
    ).toEqual([`stories/ivy_x/${hex(2)}.webp`]);

    const [, pending] = (
      await run(apiUser, ERASE, {
        clerkUserId: 'user_ivy',
        reason: 'account_deleted',
      })
    ).at(-2) as [unknown, string[]];
    const folders = [
      {
        key: 'image-ivy_w',
        kind: 'image',
        ref: 'stories/ivy_w/',
        waits: true,
      },
      {
        key: 'image-ivy_x',
        kind: 'image',
        ref: 'stories/ivy_x/',
        waits: true,
      },
    ];
    expect(await queued()).toEqual([
      ...folders,
      expect.objectContaining({ kind: 'clerk_user', ref: 'user_ivy' }),
    ]);
    // api-user tries them all straight after the commit.
    expect([...pending].sort()).toEqual(
      (await queued()).map((r) => r['key']).sort(),
    );
  });

  it('a person deleting their own story queues its folder, once', async () => {
    const jon = await person('jon');
    await draft(jon, 'jon_w');
    expect(
      await grantImage(apiUser, { story: 'jon_w', person: 'jon', version: 1 }),
    ).toMatchObject({ ok: true });
    await run(jon, `DELETE story:jon_w`);
    expect(await queued()).toEqual([
      { key: 'image-jon_w', kind: 'image', ref: 'stories/jon_w/', waits: true },
    ]);
    // Nobody else writes a picture row: not api-user, not housekeeping, not the person.
    const housekeeping = await t.service('housekeeping');
    for (const db of [apiUser, housekeeping, jon]) {
      await run(
        db,
        `CREATE pendingDeletion CONTENT { kind: 'image', ref: 'stories/bob_live/' }`,
      ).catch(() => undefined);
    }
    expect(await queued()).toHaveLength(1);
  });

  it('keeps a folder’s row until its final pass, past a PUT link’s 10 minutes, then lets it go', async () => {
    const kit = await person('kit');
    await draft(kit, 'kit_w');
    await run(kit, `DELETE story:kit_w`);
    const housekeeping = await t.service('housekeeping');
    // A delete before the final pass: the row stays, due again at its final pass, tries unchanged.
    for (const db of [apiUser, housekeeping]) {
      await run(db, PENDING_DELETION_DONE, { key: 'image-kit_w' });
      await run(db, `DELETE pendingDeletion:⟨image-kit_w⟩`).catch(
        () => undefined,
      );
      // Nor can a service bring the final pass forward.
      await run(
        db,
        `UPDATE pendingDeletion:⟨image-kit_w⟩ SET finalPassAt = time::now() - 1m`,
      ).catch(() => undefined);
    }
    expect(
      await rows(
        migrator,
        `SELECT attempts, nextAttemptAt = finalPassAt AS waiting,
           finalPassAt > time::now() + 14m AS later
         FROM pendingDeletion:⟨image-kit_w⟩`,
      ),
    ).toEqual([{ attempts: 0, waiting: true, later: true }]);
    // Fifteen minutes on, the next delete is its last.
    await run(
      migrator,
      `UPDATE pendingDeletion:⟨image-kit_w⟩ SET finalPassAt = time::now() - 1s,
         nextAttemptAt = time::now() - 1s`,
    );
    await run(apiUser, PENDING_DELETION_DONE, { key: 'image-kit_w' });
    expect(await queued()).toEqual([]);
  });

  it('refuses a person or a service a story id whose folder is still queued, then allows it once done (Codex #140 round 6)', async () => {
    const lea = await person('lea');
    await draft(lea, 'lea_w');
    await run(lea, `DELETE story:lea_w`);
    await expect(draft(lea, 'lea_w')).rejects.toThrow(
      /picture folder is still being deleted/,
    );
    // api-user's login makes no story (its create is filtered out, nothing written).
    await run(
      apiUser,
      `CREATE story:lea_w CONTENT { themeRefs: [theme:common], submitter: user:lea, slug: 'lea_w2',
         title: 'Story lea_w', description: 'How I came to faith',
         primaryFormat: 'written' }`,
    ).catch(() => undefined);
    expect(await rows(migrator, `SELECT VALUE id FROM story:lea_w`)).toEqual(
      [],
    );
    // Once its final pass has run, the row is gone and the id is free again.
    await run(
      migrator,
      `UPDATE pendingDeletion:⟨image-lea_w⟩ SET finalPassAt = time::now() - 1s`,
    );
    await run(apiUser, PENDING_DELETION_DONE, { key: 'image-lea_w' });
    expect(await queued()).toEqual([]);
    expect(await draft(lea, 'lea_w')).toHaveLength(1);
  });

  it('a system user may recreate a queued id; its next delete pushes the final pass later (Codex #140 round 6)', async () => {
    const max = await person('max');
    await draft(max, 'max_w');
    await run(max, `DELETE story:max_w`);
    // The first final pass is close (as if its 15 minutes were nearly up) and its row was tried.
    await run(
      migrator,
      `UPDATE pendingDeletion:⟨image-max_w⟩ SET finalPassAt = time::now() + 1m,
         nextAttemptAt = time::now() + 1h, attempts = 2`,
    );
    // dev-seed resets with the same ids, as a system user.
    await run(
      migrator,
      `CREATE story:max_w CONTENT { themeRefs: [theme:common], submitter: user:max, slug: 'max_w',
         title: 'Story max_w', description: 'How I came to faith',
         body: $body, primaryFormat: 'written' }`,
      { body: storyText('max_w') },
    );
    expect(
      await rows(migrator, `SELECT VALUE record::id(id) FROM story:max_w`),
    ).toEqual(['max_w']);
    await run(migrator, `DELETE story:max_w`);
    const state = () =>
      rows(
        migrator,
        `SELECT attempts, nextAttemptAt <= time::now() AS due,
           finalPassAt > time::now() + 14m AS later
         FROM pendingDeletion:⟨image-max_w⟩`,
      );
    expect(await state()).toEqual([{ attempts: 2, due: true, later: true }]);
    // A delete before the new final pass keeps the row.
    await run(apiUser, PENDING_DELETION_DONE, { key: 'image-max_w' });
    expect(await state()).toEqual([{ attempts: 2, due: false, later: true }]);
  });
});

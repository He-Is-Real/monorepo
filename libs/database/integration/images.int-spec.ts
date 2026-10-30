import type { Surreal } from 'surrealdb';
import {
  createPeople,
  grantAll,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import { draft, grantImage, grantUpload } from './support/world';

/**
 * Images (M2 plan PR 10; D53, D65, D80): a written story's image or an audio story's picture is
 * server-assigned like a video. api-user names the file `stories/<story>/<random>.webp` and records
 * an upload grant on its own login; the grant's event puts the path, size and description on the
 * draft. Nothing else puts an image on a story: the person's session may only change the
 * description or remove it.
 */
describe('images: server-assigned, in the story’s own folder, only through a grant (D65, D80)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let apiUser: Surreal;
  let workflow: Surreal;

  async function person(p: string): Promise<Surreal> {
    await createPeople(t, { [p]: `user_${p}` });
    const s = await t.person(`user_${p}`);
    await grantAll(s);
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
    await publishDpa(t, 'v1');
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

    // An audio story's picture needs no description (it becomes the clip's thumbnail).
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

  it('refuses another type, too big, the wrong shape or size, and a written image with no description', async () => {
    const dan = await person('dan');
    await draft(dan, 'dan_w');
    const cases: [Partial<Parameters<typeof grantImage>[1]>, RegExp][] = [
      [{ contentType: 'image/jpeg' }, /an image is a WebP/],
      [{ sizeBytes: 5_242_881 }, /limit_upload_size:/],
      [{ width: 3700, height: 1200 }, /pixel size or shape/], // wider than 3:1
      [{ width: 150, height: 300 }, /pixel size or shape/],
      [{ width: 4097, height: 4000 }, /pixel size or shape/],
      [{ alt: '   ' }, /needs its description/],
      [{ alt: null }, /needs its description/],
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
});

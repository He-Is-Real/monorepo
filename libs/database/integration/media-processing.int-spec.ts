import type { Surreal, SurrealQueryable } from 'surrealdb';
import {
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  rows,
  TestDatabase,
} from './support/harness';
import { approve, processed, submit } from './support/world';

/**
 * A2 (Joel, 2026-10-23): "approval should be blocked until size and processing is completed".
 * Every media item and a written story's image carry `processing` (NONE = not processed yet,
 * then 'processing', 'ready' or 'failed'). Only workflow (M7) and system users set it: the
 * person's value is ignored, api-admin's is dropped. Changing an item or the image in any way
 * (another upload, another size, another alt text) sets it back to NONE. The database refuses
 * `status → approved`, and any publicStory write, unless every item is 'ready' with its facts:
 * a video its width, height and duration, an audio file its duration, the image 'ready'.
 */
describe('approval waits for media processing (A2)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  let pat: Surreal;
  let seq = 0;

  const TEXT = `${'Words of the story. '.repeat(11)}`;
  const VIDEO = `{ format: 'video', bunnyVideoId: 'vid' }`;
  const AUDIO = `{ format: 'audio', bunnyVideoId: 'aud' }`;
  const IMAGE = `{ path: 'images/a.webp', width: 1200, height: 1600, alt: 'A sunrise' }`;

  const truth = <T = Record<string, unknown>>(
    sql: string,
    vars?: Record<string, unknown>,
  ) => rows<T>(migrator, sql, vars);
  const story = async (id: string) =>
    (
      await truth<{
        status: string;
        media: Record<string, unknown>[];
        image?: Record<string, unknown>;
      }>(`SELECT status, media, image FROM ONLY type::record('story', $id)`, {
        id,
      })
    )[0];
  const processing = async (id: string) => {
    const s = await story(id);
    return {
      media: s.media.map((m) => m['processing'] ?? null),
      image: s.image ? (s.image['processing'] ?? null) : undefined,
    };
  };
  const published = (id: string) =>
    truth(`SELECT VALUE id FROM type::record('publicStory', $id)`, { id });

  /** Pat creates a draft with these extra fields (SurrealQL object entries). */
  const create = async (fields: string) => {
    seq += 1;
    const id = `proc_${seq}`;
    const result = await outcome(
      pat,
      `CREATE type::record('story', $id) CONTENT {
         submitter: $auth, slug: $id, title: 'A story', description: 'How I came to faith',
         ${fields}
       } RETURN VALUE id`,
      { id },
    );
    expect(result).toEqual({ ok: true, result: [`story:${id}`] });
    return id;
  };
  const video = () => create(`primaryFormat: 'video', media: [${VIDEO}]`);
  const audio = () => create(`primaryFormat: 'audio', media: [${AUDIO}]`);
  const written = () =>
    create(`primaryFormat: 'written', body: '${TEXT}', image: ${IMAGE}`);
  const update = (id: string, set: string, db: SurrealQueryable = pat) =>
    outcome(db, `UPDATE type::record('story', $id) SET ${set}`, { id });

  /** The approval must be refused with this message, leaving nothing approved or published. */
  const refusedApproval = async (id: string, message: string) => {
    await expect(approve(admin, id)).rejects.toThrow(
      `media_not_ready: ${message}`,
    );
    expect((await story(id)).status).toBe('pending');
    expect(await published(id)).toEqual([]);
  };

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    await createPeople(t, { pat: 'user_pat', moderator: 'user_mod' });
    await publishDpa(t, 'v1');
    pat = await t.person('user_pat');
    await grantAll(pat);
  });
  afterAll(() => t?.close());

  describe('who sets processing', () => {
    it('the person can’t: on create, their value is ignored', async () => {
      const v = await create(
        `primaryFormat: 'video', media: [{ format: 'video', bunnyVideoId: 'v', processing: 'ready' }]`,
      );
      const w = await create(
        `primaryFormat: 'written', body: 'x',
         image: { path: 'p', width: 10, height: 10, processing: 'ready' }`,
      );
      expect(await processing(v)).toEqual({ media: [null], image: undefined });
      expect(await processing(w)).toEqual({ media: [], image: null });
    });

    it.each([
      [`media[0].processing = 'ready'`],
      [
        `media = [{ format: 'video', bunnyVideoId: 'vid', processing: 'ready' }]`,
      ],
      [`media = media.map(|$m| object::extend($m, { processing: 'ready' }))`],
    ])('the person can’t: SET %s is ignored', async (set) => {
      const id = await video();
      expect(await update(id, set)).toMatchObject({ ok: true });
      expect(await processing(id)).toEqual({ media: [null], image: undefined });
    });

    it.each([
      [`image.processing = 'ready'`],
      [`image = object::extend(image, { processing: 'ready' })`],
    ])('the person can’t: SET %s on the image is ignored', async (set) => {
      const id = await written();
      expect(await update(id, set)).toMatchObject({ ok: true });
      expect(await processing(id)).toEqual({ media: [], image: null });
    });

    it('api-admin can’t: its writes are dropped', async () => {
      const v = await video();
      const w = await written();
      await update(v, `media[0].processing = 'ready'`, admin);
      await update(w, `image.processing = 'ready'`, admin);
      expect(await processing(v)).toEqual({ media: [null], image: undefined });
      expect(await processing(w)).toEqual({ media: [], image: null });

      await processed(workflow, v);
      await processed(workflow, w);
      await update(v, `media[0].processing = 'failed'`, admin);
      await update(w, `image.processing = NONE`, admin);
      expect(await processing(v)).toEqual({
        media: ['ready'],
        image: undefined,
      });
      expect(await processing(w)).toEqual({ media: [], image: 'ready' });
    });

    it('workflow can, on media and on the image (and only processing on the image)', async () => {
      const v = await video();
      expect(
        await update(v, `media[0].processing = 'processing'`, workflow),
      ).toMatchObject({ ok: true });
      expect(await processing(v)).toEqual({
        media: ['processing'],
        image: undefined,
      });

      const w = await written();
      expect(
        await update(
          w,
          `image.processing = 'failed', image.alt = 'Words the person never wrote'`,
          workflow,
        ),
      ).toMatchObject({ ok: true });
      expect((await story(w)).image).toEqual({
        path: 'images/a.webp',
        width: 1200,
        height: 1600,
        alt: 'A sunrise',
        processing: 'failed',
      });
      // Workflow can't remove the person's image either.
      await update(w, `image = NONE`, workflow);
      expect((await story(w)).image).toMatchObject({ path: 'images/a.webp' });
    });

    it('refuses an unknown processing state', async () => {
      const id = await video();
      expect(
        await update(id, `media[0].processing = 'approved'`, workflow),
      ).toEqual({ ok: false, error: expect.stringContaining('processing') });
      const w = await written();
      expect(await update(w, `image.processing = 'done'`, workflow)).toEqual({
        ok: false,
        error: expect.stringContaining('processing'),
      });
    });
  });

  describe('a change sets processing back to not processed', () => {
    it.each([
      ['another upload', `media[0].bunnyVideoId = 'vid-2'`],
      [
        'a replaced media list',
        `media = [{ format: 'video', bunnyVideoId: 'vid-3' }]`,
      ],
      ['another size', `media[0].width = 720, media[0].height = 1280`],
    ])('video: %s', async (_name, set) => {
      const id = await video();
      await processed(workflow, id);
      expect(await processing(id)).toEqual({
        media: ['ready'],
        image: undefined,
      });
      expect(await update(id, set)).toMatchObject({ ok: true });
      expect(await processing(id)).toEqual({ media: [null], image: undefined });
    });

    it.each([
      [
        'another image',
        `image = { path: 'images/b.webp', width: 800, height: 800 }`,
      ],
      ['another path', `image.path = 'images/c.webp'`],
      ['another alt text', `image.alt = 'Sunrise over the hills'`],
    ])('image: %s', async (_name, set) => {
      const id = await written();
      await processed(workflow, id);
      expect(await update(id, set)).toMatchObject({ ok: true });
      expect(await processing(id)).toEqual({ media: [], image: null });
    });

    it('keeps it while the media and image are unchanged', async () => {
      const v = await video();
      const w = await written();
      await processed(workflow, v);
      await processed(workflow, w);
      await update(v, `title = 'A new title'`);
      await update(w, `body = '${TEXT} More.'`);
      expect(await processing(v)).toEqual({
        media: ['ready'],
        image: undefined,
      });
      expect(await processing(w)).toEqual({ media: [], image: 'ready' });
      // Re-sending the same media (as an edit form would) changes nothing either.
      await update(
        v,
        `media = media.map(|$m| object::remove($m, 'processing'))`,
      );
      expect(await processing(v)).toEqual({
        media: ['ready'],
        image: undefined,
      });
    });

    it('a video replaced after processing can’t be approved until it is processed again', async () => {
      const id = await video();
      await processed(workflow, id);
      await update(
        id,
        `media = [{ format: 'video', bunnyVideoId: 'unchecked' }]`,
      );
      expect(await submit(pat, id)).toHaveLength(1);
      await refusedApproval(
        id,
        'the story’s video or audio hasn’t finished processing',
      );
      await processed(workflow, id);
      await approve(admin, id);
      expect(await published(id)).toEqual([`publicStory:${id}`]);
    });
  });

  describe('approval', () => {
    const pending = async (make: () => Promise<string>, set?: string) => {
      const id = await make();
      expect(await submit(pat, id)).toHaveLength(1);
      if (set)
        expect(await update(id, set, workflow)).toMatchObject({ ok: true });
      return id;
    };

    it.each([
      [
        'an unprocessed video',
        video,
        undefined,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a video still processing',
        video,
        `media[0].processing = 'processing'`,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a video that failed processing',
        video,
        `media[0].processing = 'failed'`,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a ready video without its size',
        video,
        `media[0].processing = 'ready', media[0].durationSeconds = 30`,
        'a video needs its width, height and duration',
      ],
      [
        'a ready video without its duration',
        video,
        `media[0].processing = 'ready', media[0].width = 1080, media[0].height = 1920`,
        'a video needs its width, height and duration',
      ],
      [
        'a ready video with a zero duration',
        video,
        `media[0].processing = 'ready', media[0].width = 1080, media[0].height = 1920,
         media[0].durationSeconds = 0`,
        'a video needs its width, height and duration',
      ],
      [
        'an unprocessed audio file',
        audio,
        undefined,
        'the story’s video or audio hasn’t finished processing',
      ],
      [
        'a ready audio file without its duration',
        audio,
        `media[0].processing = 'ready'`,
        'an audio file needs its duration',
      ],
      [
        'an unchecked image',
        written,
        undefined,
        'the story’s image hasn’t finished processing',
      ],
      [
        'a failed image',
        written,
        `image.processing = 'failed'`,
        'the story’s image hasn’t finished processing',
      ],
    ])('is refused for %s', async (_name, make, set, message) => {
      await refusedApproval(await pending(make, set), message);
    });

    it.each([
      ['a processed video', video],
      ['a processed audio file', audio],
      ['a written story with a checked image', written],
      [
        'a written story without an image',
        () => create(`primaryFormat: 'written', body: '${TEXT}'`),
      ],
    ])('goes ahead for %s', async (_name, make) => {
      const id = await pending(make);
      await processed(workflow, id);
      await approve(admin, id);
      expect((await story(id)).status).toBe('approved');
      expect(await published(id)).toEqual([`publicStory:${id}`]);
    });

    it('is refused for system users too (the migrator)', async () => {
      const id = await pending(video);
      expect(
        await outcome(
          migrator,
          `UPDATE type::record('story', $id) SET status = 'approved'`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('media_not_ready:'),
      });
    });
  });

  describe('publicStory never shows unprocessed media (defence in depth)', () => {
    it('refuses to publish or re-sync once processing is no longer ready', async () => {
      const id = await video();
      await submit(pat, id);
      await processed(workflow, id);
      await approve(admin, id);
      // A later check (M7) marks the approved video as failed.
      expect(
        await update(id, `media[0].processing = 'failed'`, workflow),
      ).toMatchObject({ ok: true });
      const before = await truth(
        `SELECT * FROM type::record('publicStory', $id)`,
        { id },
      );
      expect(
        await outcome(
          admin,
          `UPDATE type::record('publicStory', $id) SET version = version`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('media_not_ready:'),
      });
      expect(
        await truth(`SELECT * FROM type::record('publicStory', $id)`, { id }),
      ).toEqual(before);

      // Re-creating the row is refused in the same way.
      await outcome(admin, `DELETE type::record('publicStory', $id)`, { id });
      expect(
        await outcome(
          admin,
          `CREATE type::record('publicStory', $id) CONTENT {
             version: 1, slug: $id, title: 'A story', description: 'How I came to faith',
             primaryFormat: 'video', tagRefs: [], publishedAt: time::now(),
             media: [{ format: 'video', bunnyVideoId: 'vid', width: 1080, height: 1920 }]
           }`,
          { id },
        ),
      ).toEqual({
        ok: false,
        error: expect.stringContaining('media_not_ready:'),
      });
      expect(await published(id)).toEqual([]);
    });
  });
});

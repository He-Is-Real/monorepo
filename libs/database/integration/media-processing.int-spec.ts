import { THUMBNAIL_PATH_CASES } from '@heisreal/contracts/media-paths';
import type { Surreal, SurrealQueryable } from 'surrealdb';
import {
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  rows,
  run,
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
 * a video its width, height and duration, an audio file its duration and its thumbnail with
 * that picture's width and height (Joel, 2026-10-24), the image 'ready'.
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
        'a ready audio file with an empty thumbnail path',
        audio,
        `media[0].processing = 'ready', media[0].durationSeconds = 30,
         media[0].thumbnailPath = '', media[0].width = 1280, media[0].height = 720`,
        'an audio file needs its thumbnail and that picture’s width and height',
      ],
      [
        'a ready audio file with a thumbnail outside its own video’s folder',
        audio,
        `media[0].processing = 'ready', media[0].durationSeconds = 30,
         media[0].thumbnailPath = 'other/thumbnail_0a1b2c3d.jpg', media[0].width = 1280,
         media[0].height = 720`,
        'an audio file needs its thumbnail and that picture’s width and height',
      ],
      [
        'a ready audio file without its thumbnail’s size',
        audio,
        `media[0].processing = 'ready', media[0].durationSeconds = 30,
         media[0].thumbnailPath = 'aud/thumbnail_0a1b2c3d.jpg'`,
        'an audio file needs its thumbnail and that picture’s width and height',
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

    // An audio file's thumbnail: the same table api-public-read's signer is tested against
    // (libs/contracts media-paths), so every path the database lets through can be signed.
    it.each(THUMBNAIL_PATH_CASES.map((c) => [c.why, c] as const))(
      'audio thumbnail path rule, shared with the signer: %s',
      async (_why, c) => {
        const id = await pending(
          () =>
            create(
              `primaryFormat: 'audio',
               media: [{ format: 'audio', bunnyVideoId: ${JSON.stringify(c.videoId)} }]`,
            ),
          `media[0].processing = 'ready', media[0].durationSeconds = 30,
           media[0].thumbnailPath = ${JSON.stringify(c.path)},
           media[0].width = 1280, media[0].height = 720`,
        );
        if (c.ok) {
          await approve(admin, id);
          expect(await published(id)).toEqual([`publicStory:${id}`]);
        } else {
          await refusedApproval(
            id,
            'an audio file needs its thumbnail and that picture’s width and height',
          );
        }
      },
    );

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
    it('refuses to publish an approved story whose media is no longer ready', async () => {
      const id = await video();
      await submit(pat, id);
      await processed(workflow, id);
      await approve(admin, id);
      // Without the hide event below (only a system user could remove it), the read model
      // still refuses to publish or re-sync media that isn't ready.
      await run(
        migrator,
        `REMOVE EVENT story_media_availability ON story;
         UPDATE type::record('story', $id) SET media[0].processing = 'failed';`,
        { id },
      );
      try {
        expect((await story(id)).status).toBe('approved');
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

        // Re-creating the row is refused in the same way.
        await outcome(admin, `DELETE type::record('publicStory', $id)`, {
          id,
        });
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
      } finally {
        await t.migrate(); // re-defines the event
      }
    });
  });

  /**
   * Joel, 2026-10-23: "a story should not revert after once it has approval". When an approved
   * story's media stops being ready, it stays `approved` but is hidden: the same write deletes
   * its publicStory row. When the same media is ready again (Bunny re-encodes it), the same
   * write publishes it again, with no new approval. auditLog records both;
   * fn::story::hidden_by_media lists what's hidden.
   */
  describe('an approved story is hidden while its media is not ready', () => {
    const live = async (make: () => Promise<string>) => {
      const id = await make();
      expect(await submit(pat, id)).toHaveLength(1);
      await processed(workflow, id);
      await approve(admin, id);
      expect(await published(id)).toEqual([`publicStory:${id}`]);
      return id;
    };
    const history = async (id: string) =>
      (
        await truth(
          `SELECT service, action, actor, fromStatus, toStatus, reason, createdAt
         FROM auditLog WHERE entity = type::record('story', $id)
           AND action IN ['HideStory', 'RepublishStory'] ORDER BY createdAt ASC`,
          { id },
        )
      ).map(({ createdAt: _at, ...entry }) => entry);
    const entry = (action: string, service = 'workflow') => ({
      service,
      action,
      fromStatus: 'approved',
      toStatus: 'approved',
      reason: action === 'HideStory' ? 'media_unavailable' : 'media_restored',
    });
    const hidden = async () =>
      (
        await rows<{ id: unknown }>(
          admin,
          `RETURN fn::story::hidden_by_media()`,
        )
      ).flat() as unknown as Record<string, unknown>[];
    const hiddenIds = async () => (await hidden()).map((r) => String(r['id']));
    const publicRow = (id: string) =>
      truth(
        `SELECT * OMIT updatedAt, version FROM ONLY type::record('publicStory', $id)`,
        { id },
      );
    const expectHidden = async (id: string) => {
      expect((await story(id)).status).toBe('approved');
      expect(await published(id)).toEqual([]);
      expect(await hiddenIds()).toContain(`story:${id}`);
    };
    const expectLive = async (id: string) => {
      expect((await story(id)).status).toBe('approved');
      expect(await published(id)).toEqual([`publicStory:${id}`]);
      expect(await hiddenIds()).not.toContain(`story:${id}`);
    };

    it.each<[string, () => Promise<string>, string, string | undefined]>([
      [
        'a video marked failed',
        video,
        `media[0].processing = 'failed'`,
        undefined,
      ],
      [
        'a video rescanned',
        video,
        `media[0].processing = 'processing'`,
        undefined,
      ],
      [
        'a video that loses its size',
        video,
        `media[0].width = NONE, media[0].height = NONE`,
        undefined,
      ],
      [
        'a video that loses its duration',
        video,
        `media[0].durationSeconds = NONE`,
        undefined,
      ],
      [
        'an audio file marked failed',
        audio,
        `media[0].processing = 'failed'`,
        undefined,
      ],
      [
        'an audio file that loses its duration',
        audio,
        `media[0].durationSeconds = 0`,
        `media[0].durationSeconds = 45`,
      ],
      [
        'an image marked failed',
        written,
        `image.processing = 'failed'`,
        undefined,
      ],
      [
        'an image back to not processed',
        written,
        `image.processing = NONE`,
        undefined,
      ],
    ])(
      '%s: hidden, still approved, back on its own when ready',
      async (_name, make, set, fix) => {
        const id = await live(make);
        const before = await publicRow(id);
        expect(await update(id, set, workflow)).toMatchObject({ ok: true });
        await expectHidden(id);
        expect(await history(id)).toEqual([entry('HideStory')]);

        // Bunny re-encodes the same media; processing records it ready again. No admin action.
        if (fix) await update(id, fix, workflow);
        else await processed(workflow, id);
        await expectLive(id);
        // Same publishedAt, same content. The clip's duration is processing's latest fact
        // (publicStory.durationSeconds is computed from the story, step 6a).
        const [after] = (await publicRow(id)) as Record<string, unknown>[];
        const [was] = before as Record<string, unknown>[];
        expect({ ...after, durationSeconds: undefined }).toEqual({
          ...was,
          durationSeconds: undefined,
        });
        expect(after['durationSeconds']).toEqual(
          (await story(id)).media[0]?.['durationSeconds'],
        );
        expect(await history(id)).toEqual([
          entry('HideStory'),
          entry('RepublishStory'),
        ]);
      },
    );

    it('keeps the public row’s publishedAt and slugHistory', async () => {
      const id = await live(video);
      await run(
        migrator,
        `UPDATE type::record('publicStory', $id) SET slugHistory = ['an-old-slug']`,
        { id },
      );
      const before = await publicRow(id);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await processed(workflow, id);
      expect(await publicRow(id)).toEqual(before);
      // ...and the row mirrors the story's version again (D29).
      const [v] = await truth<{ s: number; p: number }>(
        `RETURN { s: type::record('story', $id).version, p: type::record('publicStory', $id).version }`,
        { id },
      );
      expect(v.p).toBe(v.s);
    });

    it('a system user hides and restores it too', async () => {
      const id = await live(audio);
      await update(id, `media[0].processing = 'failed'`, migrator);
      await expectHidden(id);
      await update(id, `media[0].processing = 'ready'`, migrator);
      await expectLive(id);
      expect(await history(id)).toEqual([
        entry('HideStory', 'migrator'),
        entry('RepublishStory', 'migrator'),
      ]);
    });

    it('stays hidden while still not ready, with one history entry', async () => {
      const id = await live(video);
      await update(id, `media[0].processing = 'processing'`, workflow);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await expectHidden(id);
      expect(await history(id)).toEqual([entry('HideStory')]);
      const [row] = (await hidden()).filter(
        (r) => String(r['id']) === `story:${id}`,
      );
      expect(row).toMatchObject({
        slug: id,
        primaryFormat: 'video',
        mediaChanged: false,
        problem: expect.stringContaining('media_not_ready:'),
      });
      expect(row['hiddenSince']).toBeDefined();
    });

    it('lists hidden stories for api-admin, oldest first, and nothing live', async () => {
      const first = await live(video);
      const second = await live(written);
      const ok = await live(audio);
      await update(first, `media[0].processing = 'failed'`, workflow);
      await update(second, `image.processing = 'failed'`, workflow);
      const ids = await hiddenIds();
      expect(ids.indexOf(`story:${first}`)).toBeLessThan(
        ids.indexOf(`story:${second}`),
      );
      expect(ids).not.toContain(`story:${ok}`);
      // Nobody can mark a story hidden or unhidden by hand.
      for (const db of [admin, workflow, pat]) {
        await outcome(
          db,
          `CREATE type::record('hiddenStory', $id) CONTENT {
             publishedAt: time::now(), slugHistory: [], identity: 'x' }`,
          { id: ok },
        );
        await outcome(db, `DELETE type::record('hiddenStory', $id)`, {
          id: first,
        });
      }
      expect(await hiddenIds()).toContain(`story:${first}`);
      expect(await hiddenIds()).not.toContain(`story:${ok}`);
      await expectLive(ok);
    });

    it('different media stays hidden: a moderator must review it', async () => {
      const id = await live(video);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await update(
        id,
        `media = [{ format: 'video', bunnyVideoId: 'replacement', processing: 'ready',
                    width: 1080, height: 1920, durationSeconds: 60 }]`,
        workflow,
      );
      await expectHidden(id);
      const [row] = (await hidden()).filter(
        (r) => String(r['id']) === `story:${id}`,
      );
      expect(row).toMatchObject({ mediaChanged: true });
      expect(row['problem']).toBeUndefined();
      expect(await history(id)).toEqual([entry('HideStory')]);
    });

    it.each<[string, string[]]>([
      [
        'in the same write as the failure',
        [
          `media = [{ format: 'video', bunnyVideoId: 'unreviewed', processing: 'failed' }]`,
        ],
      ],
      [
        'just before the failure',
        [
          `media[0].bunnyVideoId = 'unreviewed'`,
          `media[0].processing = 'failed'`,
        ],
      ],
      // D60 exempts only Bunny's generated frames of the same video (thumbnail_1..5.jpg). A
      // custom upload lands in the video's folder too, so any other name is unreviewed media.
      [
        'as a custom thumbnail in the same write',
        [
          `media[0].thumbnailPath = 'vid/unreviewed-custom.jpg', media[0].processing = 'failed'`,
        ],
      ],
      [
        'as a custom thumbnail while hidden',
        [
          `media[0].processing = 'failed'`,
          `media[0].thumbnailPath = 'vid/unreviewed-custom.jpg'`,
        ],
      ],
      [
        'as another video’s generated frame',
        [
          `media[0].thumbnailPath = 'other/thumbnail_2.jpg', media[0].processing = 'failed'`,
        ],
      ],
      [
        'as the selected-thumbnail slot, which can hold a custom image',
        [
          `media[0].thumbnailPath = 'vid/thumbnail.jpg', media[0].processing = 'failed'`,
        ],
      ],
      [
        'as a frame number Bunny doesn’t generate',
        [
          `media[0].thumbnailPath = 'vid/thumbnail_6.jpg', media[0].processing = 'failed'`,
        ],
      ],
    ])(
      'media swapped %s never goes public unreviewed',
      async (_name, writes) => {
        const id = await live(video);
        for (const set of writes)
          expect(await update(id, set, workflow)).toMatchObject({ ok: true });
        await processed(workflow, id);
        await expectHidden(id);
        const [row] = (await hidden()).filter(
          (r) => String(r['id']) === `story:${id}`,
        );
        expect(row).toMatchObject({ mediaChanged: true });
      },
    );

    const publicThumbnail = (id: string) =>
      truth(
        `SELECT VALUE media[0].thumbnailPath FROM type::record('publicStory', $id)`,
        { id },
      );

    it.each([
      ['in the same write as the failure', true],
      ['while hidden', false],
    ])(
      'a re-encode with a new thumbnail %s comes back on its own (D60)',
      async (_name, sameWrite) => {
        // Bunny re-encodes the same video and makes a new thumbnail: a frame of the reviewed
        // clip, so no moderator is needed. The public row shows the new thumbnail.
        const id = await live(video);
        const thumb = `media[0].thumbnailPath = 'vid/thumbnail_2.jpg'`;
        await update(
          id,
          sameWrite
            ? `${thumb}, media[0].processing = 'failed'`
            : `media[0].processing = 'failed'`,
          workflow,
        );
        await expectHidden(id);
        if (!sameWrite) await update(id, thumb, workflow);
        await processed(workflow, id);
        await expectLive(id);
        expect(await publicThumbnail(id)).toEqual(['vid/thumbnail_2.jpg']);
        expect(await history(id)).toEqual([
          entry('HideStory'),
          entry('RepublishStory'),
        ]);
      },
    );

    it('a new thumbnail on a public story reaches its row (D60)', async () => {
      const id = await live(video);
      await update(
        id,
        `media[0].thumbnailPath = 'vid/thumbnail_3.jpg'`,
        workflow,
      );
      await expectLive(id);
      expect(await publicThumbnail(id)).toEqual(['vid/thumbnail_3.jpg']);
      expect(await history(id)).toEqual([]);
    });

    const changedEntry = {
      ...entry('HideStory'),
      reason: 'media_changed',
    };

    it.each<[string, () => Promise<string>, string, SurrealQueryable | null]>([
      [
        'a custom thumbnail',
        video,
        `media[0].thumbnailPath = 'vid/unreviewed-custom.jpg'`,
        null,
      ],
      [
        'another video’s generated frame',
        video,
        `media[0].thumbnailPath = 'other/thumbnail_1.jpg'`,
        null,
      ],
      ['another Bunny id', video, `media[0].bunnyVideoId = 'other'`, null],
      [
        'another image path',
        written,
        `image.path = 'images/replacement.webp'`,
        null,
      ],
    ])(
      '%s on a public story hides it until a moderator reviews it (D59, D60)',
      async (_name, make, set, db) => {
        // Workflow writes thumbnails; only a system user can swap a Bunny id or image path.
        const writer =
          db ?? (set.includes('thumbnailPath') ? workflow : migrator);
        const id = await live(make);
        expect(await update(id, set, writer)).toMatchObject({ ok: true });
        await expectHidden(id);
        const [row] = (await hidden()).filter(
          (r) => String(r['id']) === `story:${id}`,
        );
        expect(row).toMatchObject({ mediaChanged: true });
        expect(row['problem']).toBeUndefined();
        expect(await history(id)).toEqual([
          {
            ...changedEntry,
            service: writer === workflow ? 'workflow' : 'migrator',
          },
        ]);
        // Processing again doesn't bring it back: it isn't what was reviewed.
        await processed(workflow, id);
        await expectHidden(id);
      },
    );

    it('a written story’s new image path stays hidden: a moderator must review it', async () => {
      // Only a system user (or, before submit, the person) can write image.path.
      const id = await live(written);
      await update(id, `image.processing = 'failed'`, workflow);
      await update(
        id,
        `image.path = 'images/replacement.webp', image.processing = 'ready'`,
        migrator,
      );
      await expectHidden(id);
      const [row] = (await hidden()).filter(
        (r) => String(r['id']) === `story:${id}`,
      );
      expect(row).toMatchObject({ mediaChanged: true });
      expect(row['problem']).toBeUndefined();
    });

    it('only api-admin and workflow can read the hidden marker', async () => {
      const id = await live(video);
      await update(id, `media[0].processing = 'failed'`, workflow);
      const read = (db: SurrealQueryable) =>
        rows(db, `SELECT VALUE id FROM type::record('hiddenStory', $id)`, {
          id,
        });
      expect(await read(admin)).toEqual([`hiddenStory:${id}`]);
      expect(await read(workflow)).toEqual([`hiddenStory:${id}`]);
      expect(await read(pat)).toEqual([]);
    });

    it('erasure deletes the hidden marker with the story', async () => {
      const id = await live(video);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await run(admin, `DELETE type::record('story', $id)`, { id });
      expect(
        await truth(`SELECT VALUE id FROM type::record('hiddenStory', $id)`, {
          id,
        }),
      ).toEqual([]);
    });

    /** D29: one command, one version. The hide and restore add no story write of their own. */
    describe('versions (D29)', () => {
      const version = async (id: string) =>
        (
          await truth<number>(
            `SELECT VALUE version FROM ONLY type::record('story', $id)`,
            { id },
          )
        )[0];
      const command = async (db: SurrealQueryable, id: string, set: string) =>
        (
          await rows<number>(
            db,
            `UPDATE type::record('story', $id) SET ${set} RETURN VALUE version`,
            { id },
          )
        )[0];

      it('hiding returns the committed version, one more than before', async () => {
        const id = await live(video);
        const before = await version(id);
        const returned = await command(
          workflow,
          id,
          `media[0].processing = 'failed'`,
        );
        expect(await published(id)).toEqual([]);
        expect(returned).toBe(before + 1);
        expect(await version(id)).toBe(before + 1);
      });

      it('restoring returns the committed version, one more than before', async () => {
        const id = await live(video);
        await update(id, `media[0].processing = 'failed'`, workflow);
        const before = await version(id);
        const returned = await command(
          workflow,
          id,
          `media[0].processing = 'ready'`,
        );
        expect(await published(id)).toEqual([`publicStory:${id}`]);
        expect(returned).toBe(before + 1);
        expect(await version(id)).toBe(before + 1);
      });

      it('withdrawing a hidden story returns the committed version, one more than before', async () => {
        const id = await live(video);
        await update(id, `media[0].processing = 'failed'`, workflow);
        const before = await version(id);
        const returned = await command(pat, id, `status = 'withdrawn'`);
        expect(returned).toBe(before + 1);
        expect(await version(id)).toBe(before + 1);
      });
    });

    it('stays off the read model if consent was withdrawn meanwhile', async () => {
      await createPeople(t, { cal: 'user_cal' });
      const cal = await t.person('user_cal');
      await grantAll(cal);
      const id = 'proc_cal';
      expect(
        await outcome(
          cal,
          `CREATE type::record('story', $id) CONTENT {
             submitter: $auth, slug: $id, title: 'A story', description: 'How I came to faith',
             primaryFormat: 'audio', media: [${AUDIO}] } RETURN VALUE id`,
          { id },
        ),
      ).toMatchObject({ ok: true });
      await submit(cal, id);
      await processed(workflow, id);
      await approve(admin, id);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await run(
        cal,
        `CREATE consent CONTENT { subject: $auth, type: 'publish', dpaVersion: dpaVersion:v1,
           event: 'withdrawn', mechanism: 'account_settings', evidenceHash: $h }`,
        { h: 'a'.repeat(64) },
      );
      await processed(workflow, id);
      expect((await story(id)).status).toBe('approved');
      expect(await published(id)).toEqual([]);
      expect(await hiddenIds()).not.toContain(`story:${id}`);
      expect(await history(id)).toEqual([entry('HideStory')]);

      // Consent given again: the story isn't public, so a media outage and fix publishes nothing.
      await grantAll(cal);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await processed(workflow, id);
      expect(await published(id)).toEqual([]);
      expect(await history(id)).toEqual([entry('HideStory')]);
    });

    it('reviewed replacement media, published again by a moderator, is hidden when it fails (Codex, #61)', async () => {
      const id = await live(video);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await expectHidden(id);
      // Bunny can't recover A: workflow records replacement video B, ready.
      await update(
        id,
        `media = [{ format: 'video', bunnyVideoId: 'replacement-b', processing: 'ready',
                    width: 1080, height: 1920, durationSeconds: 60 }]`,
        workflow,
      );
      await expectHidden(id); // B differs from what was public: it waits for a moderator
      // A moderator reviews B and publishes it (ApproveStory's transaction).
      await approve(admin, id);
      await expectLive(id);
      expect(
        await truth(`SELECT VALUE id FROM type::record('hiddenStory', $id)`, {
          id,
        }),
      ).toEqual([]);
      // B fails later: hidden again, nothing failed stays public.
      await update(id, `media[0].processing = 'failed'`, workflow);
      await expectHidden(id);
      expect(await history(id)).toEqual([
        entry('HideStory'),
        entry('HideStory'),
      ]);
    });

    it('a hide marker left behind never stops a hide, and any publication clears it', async () => {
      const marker = () =>
        truth(`SELECT VALUE identity FROM type::record('hiddenStory', $id)`, {
          id,
        });
      const stale = () =>
        run(
          migrator,
          `UPSERT type::record('hiddenStory', $id) CONTENT {
             publishedAt: time::now(), slugHistory: [], identity: $x }`,
          { id, x: 'f'.repeat(64) },
        );
      const id = await live(video);
      // A stale marker next to the public row (only a system user could write it).
      await stale();
      await update(id, `media[0].processing = 'failed'`, workflow);
      expect(await published(id)).toEqual([]);
      expect(await marker()).not.toEqual(['f'.repeat(64)]); // replaced by what was public
      await processed(workflow, id);
      await expectLive(id); // so the same media comes back
      expect(await marker()).toEqual([]);

      // A moderator's publication (delete and re-create the row) clears one too.
      await stale();
      await run(
        admin,
        `LET $row = (SELECT * OMIT id, updatedAt, searchText FROM ONLY type::record('publicStory', $id));
         DELETE type::record('publicStory', $id);
         CREATE type::record('publicStory', $id) CONTENT $row;`,
        { id },
      );
      await expectLive(id);
      expect(await marker()).toEqual([]);
    });

    it('withdrawing consent while hidden, then giving it again, publishes nothing', async () => {
      await createPeople(t, { dee: 'user_dee' });
      const dee = await t.person('user_dee');
      await grantAll(dee);
      const id = 'proc_dee';
      expect(
        await outcome(
          dee,
          `CREATE type::record('story', $id) CONTENT {
             submitter: $auth, slug: $id, title: 'A story', description: 'How I came to faith',
             primaryFormat: 'audio', media: [${AUDIO}] } RETURN VALUE id`,
          { id },
        ),
      ).toMatchObject({ ok: true });
      await submit(dee, id);
      await processed(workflow, id);
      await approve(admin, id);
      await update(id, `media[0].processing = 'failed'`, workflow);
      await expectHidden(id);
      await run(
        dee,
        `CREATE consent CONTENT { subject: $auth, type: 'publish', dpaVersion: dpaVersion:v1,
           event: 'withdrawn', mechanism: 'account_settings', evidenceHash: $h }`,
        { h: 'b'.repeat(64) },
      );
      // The withdrawal ends the hide: the story isn't public, so a media fix can't publish it.
      expect(await hiddenIds()).not.toContain(`story:${id}`);
      await grantAll(dee);
      await processed(workflow, id);
      expect(await published(id)).toEqual([]);
      expect(await history(id)).toEqual([entry('HideStory')]);
    });

    it.each([
      ['the same state again', `media[0].processing = 'ready'`],
      ['another duration', `media[0].durationSeconds = 61`],
      ['a generated frame', `media[0].thumbnailPath = 'vid/thumbnail_4.jpg'`],
      ['nothing', `media = media`],
    ])(
      'an unrelated workflow write on a ready item keeps it published: %s',
      async (_name, set) => {
        const id = await live(video);
        expect(await update(id, set, workflow)).toMatchObject({ ok: true });
        await expectLive(id);
        expect(await history(id)).toEqual([]);
      },
    );

    it('an unrelated workflow write on a ready image keeps it published', async () => {
      const id = await live(written);
      expect(
        await update(id, `image.processing = 'ready'`, workflow),
      ).toMatchObject({ ok: true });
      await expectLive(id);
    });

    it('the person can’t hide or restore it: processing is ignored, content is locked', async () => {
      const v = await live(video);
      const w = await live(written);
      expect(await update(v, `media[0].processing = 'failed'`)).toMatchObject({
        ok: true,
      });
      expect(await update(w, `image.processing = 'failed'`)).toMatchObject({
        ok: true,
      });
      for (const set of [
        `media[0].durationSeconds = NONE`,
        `media = [{ format: 'video', bunnyVideoId: 'other' }]`,
      ]) {
        expect(await update(v, set)).toEqual({
          ok: false,
          error: expect.stringContaining('locked after submission'),
        });
      }
      expect(await update(w, `image.alt = 'Another alt'`)).toEqual({
        ok: false,
        error: expect.stringContaining('locked after submission'),
      });
      await expectLive(v);
      await expectLive(w);

      // Hidden by workflow: the person (and api-admin) can't set it ready to bring it back.
      await update(v, `media[0].processing = 'failed'`, workflow);
      await update(v, `media[0].processing = 'ready'`);
      await update(v, `media[0].processing = 'ready'`, admin);
      await expectHidden(v);
      expect((await processing(v)).media).toEqual(['failed']);
    });

    it('api-admin can’t hide it: its media writes are dropped', async () => {
      const id = await live(video);
      await update(id, `media[0].processing = 'failed'`, admin);
      await update(id, `media[0].durationSeconds = NONE`, admin);
      await expectLive(id);
    });

    it('another person can’t touch it', async () => {
      const id = await live(video);
      await createPeople(t, { eve: 'user_eve' });
      const eve = await t.person('user_eve');
      expect(
        await outcome(
          eve,
          `UPDATE type::record('story', $id) SET media[0].processing = 'failed'
           RETURN VALUE id`,
          { id },
        ),
      ).toEqual({ ok: true, result: [] });
      await expectLive(id);
    });

    it('the owner can still withdraw a hidden story, which leaves the list', async () => {
      const id = await live(audio);
      await update(id, `media[0].processing = 'failed'`, workflow);
      expect(await update(id, `status = 'withdrawn'`)).toMatchObject({
        ok: true,
      });
      expect((await story(id)).status).toBe('withdrawn');
      expect(
        await truth(`SELECT VALUE id FROM type::record('hiddenStory', $id)`, {
          id,
        }),
      ).toEqual([]);
      // Ready again later: still withdrawn, nothing published.
      await processed(workflow, id);
      expect(await published(id)).toEqual([]);
    });
  });
});

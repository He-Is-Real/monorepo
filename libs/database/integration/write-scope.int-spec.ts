import type { Surreal } from 'surrealdb';
import { rows, run, TestDatabase } from './support/harness';
import { approve, buildWorld, statusOf, step } from './support/world';

/**
 * D41 (review round 1, finding 3): field-level write scope on `story`.
 *   workflow  → media and processing fields only;
 *   api-admin → nothing on the story itself: moderation is its status log (R6), never what the
 *     person wrote (moderators request changes).
 * A field write outside the scope is silently dropped, so every test asserts the STORED state.
 */
describe('write scope on story fields (D41)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let workflow: Surreal;
  const stored = async (id: string) =>
    (
      await rows<Record<string, unknown>>(
        migrator,
        `SELECT slug, title, description, body, bylineName, primaryFormat, themeRefs, media, image,
                currentStatus FROM type::record('story', $id)`,
        { id },
      )
    )[0];

  const CONTENT_WRITES = [
    `title = 'Rewritten title'`,
    `description = 'Rewritten'`,
    `body = 'Words the person never wrote'`,
    `bylineName = 'Someone else'`,
    `primaryFormat = 'audio'`,
    `image = { path: 'dev-seed/not-theirs.webp', width: 10, height: 10 }`,
    `themeRefs = [theme:doubt]`,
    `slug = 'hijacked-slug'`,
  ];

  beforeAll(async () => {
    t = await TestDatabase.create();
    await buildWorld(t);
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    // A video story with its media entry as the person's upload would leave it (D53: only
    // video and audio stories have media).
    await run(
      migrator,
      `UPDATE story:bob_pending SET primaryFormat = 'video',
         media = [{ format: 'video', bunnyVideoId: 'vid-orig' }]`,
    );
  });
  afterAll(() => t?.close());

  describe('workflow', () => {
    it.each(CONTENT_WRITES)(
      'cannot change testimony content: SET %s',
      async (set) => {
        const before = await stored('bob_pending');
        await run(workflow, `UPDATE story:bob_pending SET ${set}`);
        expect(await stored('bob_pending')).toEqual(before);
      },
    );

    it('cannot approve, reject or change status: no status entry, no pointer (R6)', async () => {
      for (const status of ['in_review', 'approved', 'rejected']) {
        await run(
          workflow,
          `CREATE storyStatusLog CONTENT { story: story:bob_pending, status: $status }`,
          { status },
        ).catch(() => undefined);
      }
      await run(workflow, `UPDATE story:bob_pending SET currentStatus = NONE`);
      expect(await statusOf(migrator, 'bob_pending')).toBe('pending');
    });

    it('can write media and processing fields', async () => {
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].thumbnailPath = 'thumbs/1.jpg',
           media[0].durationSeconds = 93, media[0].width = 1080, media[0].height = 1920,
           media[0].processing = 'ready'`,
      );
      expect((await stored('bob_pending'))['media']).toEqual([
        {
          format: 'video',
          bunnyVideoId: 'vid-orig',
          thumbnailPath: 'thumbs/1.jpg',
          durationSeconds: 93,
          width: 1080,
          height: 1920,
          processing: 'ready',
        },
      ]);
    });
  });

  describe('api_admin', () => {
    it.each(CONTENT_WRITES)(
      'cannot change testimony content: SET %s',
      async (set) => {
        const before = await stored('bob_pending');
        await run(admin, `UPDATE story:bob_pending SET ${set}`);
        expect(await stored('bob_pending')).toEqual(before);
      },
    );

    it.each([
      `media = []`,
      `media[0].bunnyVideoId = 'someone-elses-video'`,
      `media[0].thumbnailPath = 'admin.jpg'`,
      `media[0].processing = 'failed'`,
    ])('cannot change media: SET %s', async (set) => {
      const before = await stored('bob_pending');
      await run(admin, `UPDATE story:bob_pending SET ${set}`);
      expect(await stored('bob_pending')).toEqual(before);
    });

    it('moderates by adding status entries only, and publishes exactly what the person wrote', async () => {
      await step(admin, 'bob_pending', 'in_review');
      await step(admin, 'bob_pending', 'changes_requested', {
        comment: 'Please add a little more detail',
      });
      expect(await statusOf(migrator, 'bob_pending')).toBe('changes_requested');
      await step(await t.person('user_bob'), 'bob_pending', 'pending');
      await approve(admin, 'bob_pending');
      // What everyone reads is the story itself: no copy api-admin could write.
      expect(await published()).toEqual([
        {
          title: 'Story bob_pending',
          durationSeconds: 93,
          media: [clip(93, 'thumbs/1.jpg', 1080, 1920)],
        },
      ]);
    });

    it('follows processing’s corrections of a published clip in the same write', async () => {
      // Workflow re-measures the approved clip (M7): its duration and size change, the clip
      // itself (format, Bunny id) doesn't. The public reads the story's latest facts.
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].durationSeconds = 120,
           media[0].width = 720, media[0].height = 1280`,
      );
      expect(await published()).toEqual(reviewedClip(120, 'thumbs/1.jpg'));
    });
    function clip(
      durationSeconds: number,
      thumbnailPath: string,
      width = 720,
      height = 1280,
    ) {
      return {
        format: 'video',
        bunnyVideoId: 'vid-orig',
        thumbnailPath,
        width,
        height,
        durationSeconds,
      };
    }
    /** What the public login reads of the story (R11): never `processing`. */
    async function published() {
      return rows(
        await t.service('api_public_read'),
        'SELECT title, media[0].durationSeconds AS durationSeconds, media FROM story:bob_pending',
      );
    }
    const migrator_ = () => migrator;
    const workflow_ = () => workflow;
    const reviewedClip = (durationSeconds: number, thumbnailPath: string) => [
      {
        title: 'Story bob_pending',
        durationSeconds,
        media: [clip(durationSeconds, thumbnailPath)],
      },
    ];

    it('shows a thumbnail Bunny regenerated for the same clip (D60)', async () => {
      // A re-encode can make a new thumbnail for the same video. It's a frame of the reviewed
      // clip, so it isn't new media: the story stays public with it, so its link works.
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].thumbnailPath = 'vid-orig/thumbnail_2.jpg'`,
      );
      expect(await published()).toEqual(
        reviewedClip(120, 'vid-orig/thumbnail_2.jpg'),
      );
      // Later corrections still show.
      await run(
        workflow,
        'UPDATE story:bob_pending SET media[0].durationSeconds = 150',
      );
      expect(await published()).toEqual(
        reviewedClip(150, 'vid-orig/thumbnail_2.jpg'),
      );
    });

    it.each([
      ['another clip', `media[0].bunnyVideoId = 'vid-other'`, migrator_],
      [
        'a custom thumbnail',
        `media[0].thumbnailPath = 'vid-orig/custom.jpg'`,
        workflow_,
      ],
    ])(
      'never shows %s: the story is hidden until it is reviewed (D59, D60)',
      async (_name, set, who) => {
        // Unreviewed media is never public: the story leaves the public site in the same write.
        const db = who();
        await run(db, `UPDATE story:bob_pending SET ${set}`);
        await run(
          workflow,
          'UPDATE story:bob_pending SET media[0].durationSeconds = 160',
        );
        expect(await published()).toEqual([]);
        // What was reviewed back: public again, with the latest facts.
        await run(
          migrator,
          `UPDATE story:bob_pending SET media[0].bunnyVideoId = 'vid-orig',
             media[0].thumbnailPath = 'vid-orig/thumbnail_2.jpg'`,
        );
        expect(await published()).toEqual(
          reviewedClip(160, 'vid-orig/thumbnail_2.jpg'),
        );
      },
    );

    it('leaves #61’s hide and restore working, with the latest facts on return', async () => {
      // Not ready: #61 hides the story (a hidden entry; its reviewed fingerprint is kept).
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].processing = 'processing'`,
      );
      expect(await published()).toEqual([]);
      expect(
        await rows(
          migrator,
          'SELECT VALUE record::id(id) FROM hiddenStory:bob_pending',
        ),
      ).toEqual(['bob_pending']);
      // Bunny re-encodes the same clip with another new thumbnail: ready again, it comes back
      // on its own (D60), with that thumbnail and the duration processing found since.
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].thumbnailPath = 'vid-orig/thumbnail_3.jpg'`,
      );
      expect(await published()).toEqual([]);
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].processing = 'ready'`,
      );
      expect(await published()).toEqual(
        reviewedClip(160, 'vid-orig/thumbnail_3.jpg'),
      );
      expect(
        await rows(migrator, 'SELECT VALUE id FROM hiddenStory:bob_pending'),
      ).toEqual([]);
    });
  });
});

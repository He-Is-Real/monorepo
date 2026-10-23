import type { Surreal } from 'surrealdb';
import { outcome, rows, run, TestDatabase } from './support/harness';
import { approve, buildWorld, storyText } from './support/world';

/**
 * D41 (review round 1, finding 3): field-level write scope on `story`.
 *   workflow  → media and processing fields only;
 *   api-admin → moderation fields only, never what the person wrote (moderators request changes).
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
        `SELECT slug, title, description, body, bylineName, primaryFormat, tagRefs, media, image,
                status, approvedAt, rejectionFeedback, lockedBy, lockedAt
           FROM type::record('story', $id)`,
        { id },
      )
    )[0];

  const CONTENT_WRITES = [
    `title = 'Rewritten title'`,
    `description = 'Rewritten'`,
    `body = 'Words the person never wrote'`,
    `bylineName = 'Someone else'`,
    `primaryFormat = 'audio'`,
    `image = { path: 'not-theirs.webp', width: 10, height: 10 }`,
    `tagRefs = [tag:doubt]`,
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

    it('cannot approve, reject or change status', async () => {
      for (const set of [
        `status = 'approved', approvedAt = time::now()`,
        `status = 'rejected', rejectionFeedback = 'Rejected by workflow'`,
        `status = 'draft'`,
      ]) {
        await run(workflow, `UPDATE story:bob_pending SET ${set}`);
      }
      expect(await stored('bob_pending')).toMatchObject({ status: 'pending' });
      const s = await stored('bob_pending');
      expect(s['approvedAt']).toBeUndefined();
      expect(s['rejectionFeedback']).toBeUndefined();
    });

    it('cannot write moderation fields (lock, feedback)', async () => {
      await run(
        workflow,
        `UPDATE story:bob_pending SET lockedBy = user:moderator, lockedAt = time::now(),
           rejectionFeedback = 'from workflow'`,
      );
      const s = await stored('bob_pending');
      expect([s['lockedBy'], s['lockedAt'], s['rejectionFeedback']]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
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

    it('writes moderation fields and status', async () => {
      await run(
        admin,
        `UPDATE story:bob_pending SET lockedBy = user:moderator, lockedAt = time::now(),
           status = 'changes_requested', rejectionFeedback = 'Please add a little more detail'`,
      );
      expect(await stored('bob_pending')).toMatchObject({
        lockedBy: 'user:moderator',
        status: 'changes_requested',
        rejectionFeedback: 'Please add a little more detail',
      });
      await run(
        admin,
        `UPDATE story:bob_pending SET status = 'pending', lockedBy = NONE, lockedAt = NONE`,
      );
    });

    it('cannot publish text the person didn’t write through the read model', async () => {
      // A normal approval works (the read model mirrors the story)...
      await approve(admin, 'bob_pending');
      expect(
        await rows(migrator, 'SELECT VALUE title FROM publicStory:bob_pending'),
      ).toEqual(['Story bob_pending']);
      // ...but rewriting the published copy is refused, and the row is unchanged.
      for (const set of [
        `title = 'Rewritten'`,
        `body = 'Not their words'`,
        `media = []`,
      ]) {
        expect(
          await outcome(admin, `UPDATE publicStory:bob_pending SET ${set}`),
        ).toEqual({
          ok: false,
          error: expect.stringContaining('must mirror'),
        });
      }
      expect(
        await rows(migrator, 'SELECT title, body FROM publicStory:bob_pending'),
      ).toEqual([
        { title: 'Story bob_pending', body: storyText('bob_pending') },
      ]);
    });

    it('takes the clip’s duration from the story, whatever the writer sends', async () => {
      // Cards show a clip's length (step 6a). The read model computes it from the approved
      // story's processed media, so no publisher copies it and none can change it.
      expect(
        await rows(
          migrator,
          'SELECT VALUE durationSeconds FROM publicStory:bob_pending',
        ),
      ).toEqual([93]);
      await run(
        admin,
        'UPDATE publicStory:bob_pending SET durationSeconds = 1',
      );
      expect(
        await rows(
          migrator,
          'SELECT VALUE durationSeconds FROM publicStory:bob_pending',
        ),
      ).toEqual([93]);
    });

    it('follows processing’s corrections of a published clip in the same write', async () => {
      // Workflow re-measures the approved clip (M7): its duration and size change, the clip
      // itself (format, Bunny id) doesn't. The published row must not keep the old facts.
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].durationSeconds = 120,
           media[0].width = 720, media[0].height = 1280`,
      );
      expect(
        await rows(
          migrator,
          'SELECT durationSeconds, media FROM publicStory:bob_pending',
        ),
      ).toEqual([
        {
          durationSeconds: 120,
          media: [
            {
              format: 'video',
              bunnyVideoId: 'vid-orig',
              thumbnailPath: 'thumbs/1.jpg',
              width: 720,
              height: 1280,
            },
          ],
        },
      ]);
    });

    const published = () =>
      rows(
        migrator,
        'SELECT durationSeconds, media FROM publicStory:bob_pending',
      );
    const reviewedClip = (durationSeconds: number, thumbnailPath: string) => [
      {
        durationSeconds,
        media: [
          {
            format: 'video',
            bunnyVideoId: 'vid-orig',
            thumbnailPath,
            width: 720,
            height: 1280,
          },
        ],
      },
    ];

    it('copies a thumbnail Bunny regenerated for the same clip (D60)', async () => {
      // A re-encode can make a new thumbnail for the same video. It's a frame of the reviewed
      // clip, so it isn't new media: the published row follows it, so its link works.
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].thumbnailPath = 'thumbs/2.jpg'`,
      );
      expect(await published()).toEqual(reviewedClip(120, 'thumbs/2.jpg'));
      // Later corrections still reach the row.
      await run(
        workflow,
        'UPDATE story:bob_pending SET media[0].durationSeconds = 150',
      );
      expect(await published()).toEqual(reviewedClip(150, 'thumbs/2.jpg'));
    });

    it('never copies another clip: a new Bunny id is #61’s to hide and review', async () => {
      // Only a system user can write it this way (no hide: the clip stays ready), so the row
      // keeps what was reviewed, and later corrections wait too.
      await run(
        migrator,
        `UPDATE story:bob_pending SET media[0].bunnyVideoId = 'vid-other'`,
      );
      await run(
        workflow,
        'UPDATE story:bob_pending SET media[0].durationSeconds = 160',
      );
      expect(await published()).toEqual(reviewedClip(150, 'thumbs/2.jpg'));
      await run(
        migrator,
        `UPDATE story:bob_pending SET media[0].bunnyVideoId = 'vid-orig'`,
      );
    });

    it('leaves #61’s hide and restore working, with the latest facts on return', async () => {
      // Not ready: #61 hides the story (the row goes, its reviewed fingerprint is kept).
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
        `UPDATE story:bob_pending SET media[0].thumbnailPath = 'thumbs/3.jpg'`,
      );
      expect(await published()).toEqual([]);
      await run(
        workflow,
        `UPDATE story:bob_pending SET media[0].processing = 'ready'`,
      );
      expect(await published()).toEqual(reviewedClip(160, 'thumbs/3.jpg'));
      expect(
        await rows(migrator, 'SELECT VALUE id FROM hiddenStory:bob_pending'),
      ).toEqual([]);
    });
  });
});

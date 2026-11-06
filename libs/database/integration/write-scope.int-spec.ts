import type { Surreal } from 'surrealdb';
import { rows, run, TestDatabase } from './support/harness';
import { approve, buildWorld, statusOf, step } from './support/world';

/**
 * D41 (review round 1, finding 3): field-level write scope on `story`.
 *   workflow  → nothing on the story itself: processing writes its files' rows (R12);
 *   api-admin → nothing on the story itself: moderation is its status log (R6), never what the
 *     person wrote (moderators request changes), nor its files.
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
        `SELECT slug, title, description, body, bylineName, primaryFormat, themeRefs, mediaFile,
                image, currentStatus FROM type::record('story', $id)`,
        { id },
      )
    )[0];
  const file = async () =>
    (
      await rows<Record<string, unknown>>(
        migrator,
        `SELECT * OMIT at FROM ONLY storyFile:vidorig`,
      )
    )[0];

  const CONTENT_WRITES = [
    `title = 'Rewritten title'`,
    `description = 'Rewritten'`,
    `body = 'Words the person never wrote'`,
    `bylineName = 'Someone else'`,
    `primaryFormat = 'audio'`,
    `image = { file: storyFile:⟨dev-seed/not-theirs.webp⟩ }`,
    `mediaFile = NONE`,
    `themeRefs = [theme:doubt]`,
    `slug = 'hijacked-slug'`,
  ];

  beforeAll(async () => {
    t = await TestDatabase.create();
    await buildWorld(t);
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    workflow = await t.service('workflow');
    // A video story with its file as the person's upload would leave it (D53: only video and
    // audio stories have one; R12: a storyFile row the story points at).
    await run(
      migrator,
      `CREATE storyFile:vidorig CONTENT { story: story:bob_pending, person: user:bob,
         format: 'video', contentType: 'video/mp4', sizeBytes: 1000, storyVersion: 1 };
       UPDATE story:bob_pending SET primaryFormat = 'video', mediaFile = storyFile:vidorig;`,
    );
  });
  afterAll(() => t?.close());

  describe('workflow', () => {
    it.each(CONTENT_WRITES)(
      'cannot change testimony content or its files: SET %s',
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

    it('writes the file’s processing facts on its row, never what api-user recorded', async () => {
      await run(
        workflow,
        `UPDATE storyFile:vidorig SET thumbnailPath = 'vidorig/thumbnail_1.jpg',
           lengthSeconds = 93, width = 1080, height = 1920, processing = 'ready',
           sizeBytes = 1, contentType = 'text/plain', story = story:bob_live`,
      ).catch(() => undefined);
      await run(
        workflow,
        `UPDATE storyFile:vidorig SET thumbnailPath = 'vidorig/thumbnail_1.jpg',
           lengthSeconds = 93, width = 1080, height = 1920, processing = 'ready'`,
      );
      expect(await file()).toMatchObject({
        story: 'story:bob_pending',
        sizeBytes: 1000,
        contentType: 'video/mp4',
        thumbnailPath: 'vidorig/thumbnail_1.jpg',
        lengthSeconds: 93,
        width: 1080,
        height: 1920,
        processing: 'ready',
      });
    });
  });

  describe('api_admin', () => {
    it.each(CONTENT_WRITES)(
      'cannot change testimony content or its files: SET %s',
      async (set) => {
        const before = await stored('bob_pending');
        await run(admin, `UPDATE story:bob_pending SET ${set}`);
        expect(await stored('bob_pending')).toEqual(before);
      },
    );

    it('cannot write a file’s row', async () => {
      const before = await file();
      await run(
        admin,
        `UPDATE storyFile:vidorig SET processing = 'failed', thumbnailPath = 'admin.jpg'`,
      );
      expect(await file()).toEqual(before);
    });

    it('moderates by adding status entries only, and publishes exactly what the person wrote', async () => {
      await step(admin, 'bob_pending', 'in_review');
      await step(admin, 'bob_pending', 'changes_requested', {
        comment: 'Please add a little more detail',
      });
      expect(await statusOf(migrator, 'bob_pending')).toBe('changes_requested');
      await step(await t.person('user_bob'), 'bob_pending', 'pending');
      await approve(admin, 'bob_pending');
      // What everyone reads is the story and its file: no copy api-admin could write.
      expect(await published()).toEqual(clip(93, 'vidorig/thumbnail_1.jpg', 1080, 1920));
    });

    it('shows processing’s corrections of a published clip at once (R12: no copy to update)', async () => {
      // Workflow re-measures the approved clip (M7) and Bunny makes another frame of it (D60):
      // the same file, so it stays public, with the latest facts.
      await run(
        workflow,
        `UPDATE storyFile:vidorig SET lengthSeconds = 120, width = 720, height = 1280,
           thumbnailPath = 'vidorig/thumbnail_2.jpg'`,
      );
      expect(await published()).toEqual(clip(120, 'vidorig/thumbnail_2.jpg'));
    });

    it('leaves the hide and show-again working, with the latest facts on return (#61)', async () => {
      await run(workflow, `UPDATE storyFile:vidorig SET processing = 'processing'`);
      expect(await published()).toEqual([]);
      await run(
        workflow,
        `UPDATE storyFile:vidorig SET thumbnailPath = 'vidorig/thumbnail_3.jpg'`,
      );
      expect(await published()).toEqual([]);
      await run(workflow, `UPDATE storyFile:vidorig SET processing = 'ready'`);
      expect(await published()).toEqual(clip(120, 'vidorig/thumbnail_3.jpg'));
    });

    function clip(
      lengthSeconds: number,
      thumbnailPath: string,
      width = 720,
      height = 1280,
    ) {
      return [
        {
          title: 'Story bob_pending',
          media: {
            id: 'storyFile:vidorig',
            format: 'video',
            thumbnailPath,
            width,
            height,
            lengthSeconds,
          },
        },
      ];
    }
    /** What the public login reads of the story (R11, R12): never `processing`. */
    async function published() {
      return rows(
        await t.service('api_public_read'),
        'SELECT title, mediaFile.* AS media FROM story:bob_pending',
      );
    }
  });
});

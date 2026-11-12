import type { Surreal } from 'surrealdb';
import {
  createPeople,
  outcome,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import {
  approve,
  buildWorld,
  draft,
  grantImage,
  processed,
  statusOf,
  step,
  submit,
  edit,
} from './support/world';

/**
 * R11 (Joel, 2026-11-04/05): one story table. Everyone (the public login, any signed-in person,
 * api-user's own login) reads the published fields of approved stories, of their current
 * approved status entry and of the files they point at now (R12), and nothing else: no other
 * status, no older entry, no other file, no private field, whichever way the query asks (db
 * review 2, section 6 items 3 and 4). These tests try to leak.
 */
describe('what everyone sees of stories (R11 leak tests)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  let ann: Surreal;
  let readers: [string, Surreal][];

  /** One story of Ann's in every status but approved, and one approved. */
  const HIDDEN_FROM_EVERYONE = [
    'ann_draft',
    'ann_pending',
    'ann_changes',
    'ann_rejected',
    'ann_editing',
    'ann_hidden',
  ];
  const PRIVATE_STORY_FIELDS = [
    'submitter',
    'createdAt',
    'socialMediaSharingConsent',
    'socialMediaSharingConsentAgreedAt',
  ];

  /** The picture `n` of story `id` (R12: its storyFile row's key is its path). */
  const pic = (id: string, n: number) =>
    `stories/${id}/${String(n).padStart(32, '0')}.webp`;
  const PRIVATE_FILE_FIELDS = [
    'story',
    'person',
    'contentType',
    'sizeBytes',
    'durationSeconds',
    'expectedImage',
    'storyVersion',
    'processing',
    'checkedAt',
    'at',
    'renewedAt',
    'detachedAt',
    'removedAt',
  ];

  beforeAll(async () => {
    t = await TestDatabase.create();
    ({ admin, ann } = await buildWorld(t));
    migrator = await t.migrator();
    const apiUser = await t.service('api_user');
    await createPeople(t, { cara: 'user_cara' });
    // Pictures (R12): ann_draft's, ann_editing's and ann_hidden's, and ann_live's, whose first
    // picture was replaced before it was submitted (detached).
    const picture = async (
      id: string,
      n: number,
      version: number,
      expected?: string,
    ) => {
      const o = await grantImage(apiUser, {
        story: id,
        person: 'ann',
        version,
        name: String(n).padStart(32, '0'),
        expectedImage: expected,
      });
      if (!o.ok) throw new Error(o.error);
    };
    await picture('ann_draft', 1, 1);
    for (const id of [
      'ann_changes',
      'ann_rejected',
      'ann_editing',
      'ann_hidden',
      'ann_live',
    ]) {
      await draft(ann, id);
      if (['ann_editing', 'ann_hidden', 'ann_live'].includes(id)) {
        await picture(id, 1, 1);
      }
      if (id === 'ann_live') await picture(id, 2, 2, pic(id, 1));
      await submit(ann, id);
      await processed(await t.service('workflow'), id);
    }
    for (const [id, to] of [
      ['ann_changes', 'changesRequested'],
      ['ann_rejected', 'rejected'],
    ]) {
      await step(admin, id, to, { comment: `Moderator note on ${id}` });
    }
    // Approved straight after their pictures' upload, while the links could still be used: a
    // Admin skips that wait (and the entry's record of it is api-admin's alone to read).
    for (const id of ['ann_editing', 'ann_hidden', 'ann_live']) {
      await approve(admin, id, { superAdminSkip: true });
    }
    await edit(ann, 'ann_editing');
    await step(admin, 'ann_hidden', 'hiddenByModerator', {
      comment: 'Hidden for a check',
    });
    for (const id of HIDDEN_FROM_EVERYONE) {
      expect(await statusOf(migrator, id)).not.toBe('approved');
    }
    readers = [
      ['the public login', await t.service('api_public_read')],
      ['another person', await t.person('user_cara')],
      ['api-user’s own login', await t.service('api_user')],
    ];
  });
  afterAll(() => t?.close());

  it.each([0, 1, 2])(
    'reader %#: sees approved stories only, by id or by scan',
    async (i) => {
      const [, db] = readers[i];
      expect(
        await rows(db, 'SELECT VALUE id FROM type::table("story") ORDER BY id'),
      ).toEqual(['story:ann_live', 'story:bob_live']);
      for (const id of HIDDEN_FROM_EVERYONE) {
        expect(
          await rows(db, `SELECT * FROM type::record('story', $id)`, { id }),
        ).toEqual([]);
        expect(
          await rows(db, `SELECT id FROM story WHERE slug = $id`, { id }),
        ).toEqual([]);
      }
      expect(
        await rows(db, 'SELECT count() FROM story WHERE true GROUP ALL'),
      ).toEqual([{ count: 2 }]);
    },
  );

  it.each([0, 1, 2])(
    'reader %#: never reads a private field of an approved story',
    async (i) => {
      const [, db] = readers[i];
      const [live] = await rows<Record<string, unknown>>(
        db,
        'SELECT * FROM story:ann_live',
      );
      expect(live).toMatchObject({ title: 'Story ann_live', version: 6 });
      for (const field of PRIVATE_STORY_FIELDS) {
        expect(live).not.toHaveProperty(field);
        expect(
          await rows(db, `SELECT VALUE ${field} FROM story:ann_live`),
        ).toEqual([undefined]);
      }
    },
  );

  it.each([0, 1, 2])(
    'reader %#: of the status log, only each approved story’s current entry, and only its story, status and publishedAt',
    async (i) => {
      const [, db] = readers[i];
      const entries = await rows<Record<string, unknown>>(
        db,
        'SELECT * FROM storyStatusLog ORDER BY id',
      );
      expect(entries.map((e) => e['story']).sort()).toEqual([
        'story:ann_live',
        'story:bob_live',
      ]);
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual([
          'id',
          'publishedAt',
          'status',
          'story',
        ]);
        expect(entry['status']).toBe('approved');
      }
      // Withdrawn and hidden stories' earlier approved entries, and every other entry: nothing.
      for (const id of HIDDEN_FROM_EVERYONE) {
        expect(
          await rows(
            db,
            `SELECT * FROM storyStatusLog WHERE story = type::record('story', $id)`,
            { id },
          ),
        ).toEqual([]);
      }
    },
  );

  it.each([0, 1, 2])(
    'reader %#: following links leaks nothing either way',
    async (i) => {
      const [, db] = readers[i];
      // story -> its status entry: only the current approved one's public fields.
      expect(
        await rows(
          db,
          `SELECT currentStatus.status AS s, currentStatus.comment AS c, currentStatus.by AS b,
           currentStatus.at AS at FROM story:ann_live`,
        ),
      ).toEqual([{ s: 'approved', c: undefined, b: undefined, at: undefined }]);
      // entry -> its story: never a hidden story's words or anyone's private fields.
      expect(
        await rows(
          db,
          `SELECT story.title AS title, story.submitter AS submitter FROM storyStatusLog
           ORDER BY title`,
        ),
      ).toEqual([
        { title: 'Story ann_live', submitter: undefined },
        { title: 'Story bob_live', submitter: undefined },
      ]);
      // A record path straight to a hidden story, or to a non-public entry of a public story.
      for (const id of HIDDEN_FROM_EVERYONE) {
        expect(
          await rows(
            db,
            `RETURN [type::record('story', $id).title, type::record('story', $id).currentStatus.status]`,
            { id },
          ),
        ).toEqual([undefined, undefined]);
      }
      const older = await rows<string>(
        migrator,
        `SELECT VALUE id FROM storyStatusLog WHERE story = story:ann_live AND status != 'approved'`,
      );
      expect(older).toHaveLength(1);
      for (const entry of older) {
        expect(
          await rows(db, 'SELECT * FROM type::record($e)', { e: entry }),
        ).toEqual([]);
      }
    },
  );

  // api-user's own login reads every file row, as it read the upload grants before (R12): erasure
  // queues the person's files from them, and a resume renews one (fn::upload::renew).
  it.each([0, 1])(
    'reader %#: of the files, only those an approved story shows now, and only their published fields',
    async (i) => {
      const [, db] = readers[i];
      const files = await rows<Record<string, unknown>>(
        db,
        'SELECT * FROM storyFile',
      );
      expect(files).toEqual([
        {
          id: `storyFile:⟨${pic('ann_live', 2)}⟩`,
          format: 'image',
          width: 900,
          height: 1200,
        },
      ]);
      expect(
        await rows(db, 'SELECT count() FROM storyFile WHERE true GROUP ALL'),
      ).toEqual([{ count: 1 }]);
      // Through the story, as the public queries read it.
      expect(
        await rows(
          db,
          `SELECT record::id(image.file) AS path, image.file.width AS width,
             image.file.processing AS processing, image.file.person AS person
           FROM story:ann_live`,
        ),
      ).toEqual([
        {
          path: pic('ann_live', 2),
          width: 900,
          processing: undefined,
          person: undefined,
        },
      ]);
      for (const field of PRIVATE_FILE_FIELDS) {
        expect(
          await rows(
            db,
            `SELECT VALUE ${field} FROM type::record('storyFile', $key)`,
            { key: pic('ann_live', 2) },
          ),
        ).toEqual([undefined]);
      }
      // The replaced picture of a public story, and every file of a story that isn't public.
      for (const key of [
        pic('ann_live', 1),
        pic('ann_draft', 1),
        pic('ann_editing', 1),
        pic('ann_hidden', 1),
      ]) {
        expect(
          await rows(db, `SELECT * FROM type::record('storyFile', $key)`, {
            key,
          }),
        ).toEqual([]);
      }
      // Nor the files an approval reviewed, through the status log.
      expect(
        await rows(
          db,
          `SELECT reviewedImageFile, reviewedMediaFile FROM storyStatusLog`,
        ),
      ).toEqual([{}, {}]);
    },
  );

  it.each([0, 1, 2])(
    'reader %#: search finds only approved stories’ words',
    async (i) => {
      const [, db] = readers[i];
      expect(
        await rows(
          db,
          `SELECT VALUE story FROM storySearch WHERE searchText @1@ 'story' ORDER BY story`,
        ),
      ).toEqual(['story:ann_live', 'story:bob_live']);
    },
  );

  // 3.2.4 skips a row rule that reads `$auth.id` when an aggregate has no WHERE (Codex, B1 round
  // 1: the public counted every status entry). The rules compare `$auth` itself; these are the
  // exact queries, for the public readers and for those who see more.
  it('counting without a WHERE sees only what the reader may read', async () => {
    const counts = async (db: Surreal) =>
      [
        await rows(db, 'SELECT count() FROM storyStatusLog GROUP ALL'),
        await rows(db, 'SELECT count() FROM story GROUP ALL'),
      ].map((r) => (r[0] as { count: number } | undefined)?.count ?? 0);
    const [entries, stories] = await counts(migrator);
    for (const [, db] of readers) expect(await counts(db)).toEqual([2, 2]);
    // Ann: her own stories and entries, plus Bob's published story and its current entry.
    const [annEntries, annStories] = await counts(ann);
    expect(annStories).toBe(
      (
        await rows(
          migrator,
          'SELECT VALUE id FROM story WHERE submitter = user:ann',
        )
      ).length + 1,
    );
    expect(annEntries).toBe(
      (
        await rows(
          migrator,
          'SELECT VALUE id FROM storyStatusLog WHERE story.submitter = user:ann',
        )
      ).length + 1,
    );
    expect(await counts(admin)).toEqual([entries, stories]);
  });

  // The same quirk, on every table a session may read: a count without a WHERE is the count the
  // row rule allows.
  it.each([
    'user',
    'favourite',
    'pendingDeletion',
    'idempotencyKey',
    'submitterLimits',
    'submissionLog',
    'storyStatusLog',
    'story',
    'storyFile',
    'storySearch',
  ])('counting %s without a WHERE applies its row rule', async (table) => {
    const count = async (db: Surreal, sql: string) =>
      (await rows<{ count: number }>(db, sql))[0]?.count ?? 0;
    for (const db of [...readers.map(([, r]) => r), ann, admin]) {
      expect(await count(db, `SELECT count() FROM ${table} GROUP ALL`)).toBe(
        await count(db, `SELECT count() FROM ${table} WHERE true GROUP ALL`),
      );
    }
  });

  it('the search index holds only approved stories’ words: its scores can’t reveal others', async () => {
    expect(
      await rows(
        migrator,
        `SELECT VALUE story FROM storySearch ORDER BY story`,
      ),
    ).toEqual(['story:ann_live', 'story:bob_live']);
    // A draft's own words find nothing, whoever searches (the system user included).
    expect(
      await rows(
        migrator,
        `SELECT VALUE story FROM storySearch WHERE searchText @1@ 'ann_draft'`,
      ),
    ).toEqual([]);
  });

  it('the owner still sees every one of their stories, and their own log without names', async () => {
    expect(
      (await rows<string>(ann, 'SELECT VALUE id FROM story')).length,
    ).toBeGreaterThanOrEqual(HIDDEN_FROM_EVERYONE.length + 1);
    expect(
      await rows(
        ann,
        `SELECT VALUE comment FROM storyStatusLog WHERE story = story:ann_changes AND comment != NONE`,
      ),
    ).toEqual(['Moderator note on ann_changes']);
    expect(
      await rows(
        ann,
        'SELECT VALUE by FROM storyStatusLog WHERE story = story:ann_changes',
      ),
    ).toEqual([undefined, undefined]);
  });

  it('each story’s publishedAt is its own first approval’s time', async () => {
    const dates = await rows<{
      story: string;
      at: string;
      publishedAt: string;
    }>(
      migrator,
      `SELECT story, at, publishedAt FROM storyStatusLog
         WHERE status = 'approved' AND story IN [story:ann_live, story:bob_live] ORDER BY story`,
    );
    expect(dates.map((d) => d.story)).toEqual([
      'story:ann_live',
      'story:bob_live',
    ]);
    for (const d of dates) expect(d.publishedAt).toEqual(d.at);
    expect(dates[0].publishedAt).not.toEqual(dates[1].publishedAt);
  });

  it('a hidden story comes back to everyone when a moderator shows it again, with its first publishedAt', async () => {
    const reader = readers[0][1];
    const [first] = await rows<string>(
      migrator,
      `SELECT VALUE publishedAt FROM storyStatusLog WHERE story = story:ann_hidden AND status = 'approved'`,
    );
    // Its picture's upload link could still be used (just uploaded): an Admin shows it again.
    await step(admin, 'ann_hidden', 'shownByModerator', {
      skippedMediaWait: true,
    });
    expect(
      await rows(
        reader,
        'SELECT story, publishedAt FROM storyStatusLog WHERE story = story:ann_hidden',
      ),
    ).toEqual([{ story: 'story:ann_hidden', publishedAt: first }]);
    await step(admin, 'ann_hidden', 'hiddenByModerator');
    expect(await rows(reader, 'SELECT * FROM story:ann_hidden')).toEqual([]);
  });

  it('a story a moderator hid stays hidden through the next write: only a moderator shows it again', async () => {
    await run(migrator, 'UPDATE story:ann_hidden SET title = title');
    expect(await statusOf(migrator, 'ann_hidden')).toBe('hidden');
    expect(await rows(readers[0][1], 'SELECT * FROM story:ann_hidden')).toEqual(
      [],
    );
  });

  it('a story taken down to edit can’t be published or hidden by a moderator: only the person sends it again', async () => {
    for (const action of [
      'approved',
      'rejected',
      'changesRequested',
      'hiddenByModerator',
      'shownByModerator',
    ]) {
      expect(
        await outcome(
          admin,
          `CREATE storyStatusLog CONTENT { story: story:ann_editing, action: $action,
             comment: 'A note', by: user:moderator }`,
          { action },
        ),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining('status_step'),
      });
    }
    expect(await statusOf(migrator, 'ann_editing')).toBe('editing');
  });
});

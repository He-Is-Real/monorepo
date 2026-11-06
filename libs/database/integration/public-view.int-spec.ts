import type { Surreal } from 'surrealdb';
import { createPeople, rows, run, TestDatabase } from './support/harness';
import {
  approve,
  buildWorld,
  draft,
  statusOf,
  step,
  submit,
  withdraw,
} from './support/world';

/**
 * R11 (Joel, 2026-11-04/05): one story table. Everyone (the public login, any signed-in person,
 * api-user's own login) reads the published fields of approved stories, and of their current
 * approved status entry, and nothing else: no other status, no older entry, no private field,
 * whichever way the query asks (db review 2, section 6 items 3 and 4). These tests try to leak.
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
    'ann_review',
    'ann_changes',
    'ann_rejected',
    'ann_withdrawn',
    'ann_hidden',
  ];
  const PRIVATE_STORY_FIELDS = [
    'submitter',
    'createdAt',
    'socialMediaSharingConsent',
    'socialMediaSharingConsentAgreedAt',
  ];

  beforeAll(async () => {
    t = await TestDatabase.create();
    ({ admin, ann } = await buildWorld(t));
    migrator = await t.migrator();
    await createPeople(t, { cara: 'user_cara' });
    for (const id of [
      'ann_review',
      'ann_changes',
      'ann_rejected',
      'ann_withdrawn',
      'ann_hidden',
      'ann_live',
    ]) {
      await draft(ann, id);
      await submit(ann, id);
    }
    await step(admin, 'ann_review', 'in_review');
    for (const [id, to] of [
      ['ann_changes', 'changes_requested'],
      ['ann_rejected', 'rejected'],
    ]) {
      await step(admin, id, 'in_review');
      await step(admin, id, to, { comment: `Moderator note on ${id}` });
    }
    for (const id of ['ann_withdrawn', 'ann_hidden', 'ann_live']) {
      await approve(admin, id);
    }
    await withdraw(ann, 'ann_withdrawn');
    await step(admin, 'ann_hidden', 'hidden', {
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
      expect(live).toMatchObject({ title: 'Story ann_live', version: 4 });
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
      expect(older).toHaveLength(2);
      for (const entry of older) {
        expect(
          await rows(db, 'SELECT * FROM type::record($e)', { e: entry }),
        ).toEqual([]);
      }
    },
  );

  it.each([0, 1, 2])(
    'reader %#: search finds only approved stories’ words',
    async (i) => {
      const [, db] = readers[i];
      expect(
        await rows(
          db,
          `SELECT VALUE id FROM story WHERE searchText @1@ 'story' ORDER BY id`,
        ),
      ).toEqual(['story:ann_live', 'story:bob_live']);
    },
  );

  it('the search index holds only approved stories’ words: its scores can’t reveal others', async () => {
    expect(
      await rows(
        migrator,
        `SELECT VALUE id FROM story WHERE searchText != NONE ORDER BY id`,
      ),
    ).toEqual(['story:ann_live', 'story:bob_live']);
    // A draft's own words find nothing, whoever searches (the system user included).
    expect(
      await rows(
        migrator,
        `SELECT VALUE id FROM story WHERE searchText @1@ 'ann_draft'`,
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
    ).toEqual([undefined, undefined, undefined]);
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
    await step(admin, 'ann_hidden', 'approved');
    expect(
      await rows(
        reader,
        'SELECT story, publishedAt FROM storyStatusLog WHERE story = story:ann_hidden',
      ),
    ).toEqual([{ story: 'story:ann_hidden', publishedAt: first }]);
    await step(admin, 'ann_hidden', 'hidden');
    expect(await rows(reader, 'SELECT * FROM story:ann_hidden')).toEqual([]);
  });

  it('a withdrawn story stays withdrawn: nobody can publish it again', async () => {
    for (const status of ['approved', 'in_review', 'pending']) {
      await run(
        admin,
        `CREATE storyStatusLog CONTENT { story: story:ann_withdrawn, status: $status, by: user:moderator }`,
        { status },
      ).catch(() => undefined);
    }
    await run(
      ann,
      `CREATE storyStatusLog CONTENT { story: story:ann_withdrawn, status: 'pending' }`,
    ).catch(() => undefined);
    expect(await statusOf(migrator, 'ann_withdrawn')).toBe('withdrawn');
  });
});

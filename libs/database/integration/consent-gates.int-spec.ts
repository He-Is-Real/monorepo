import type { Surreal } from 'surrealdb';
import {
  consentEvent,
  createPeople,
  trustSubmitters,
  outcome,
  publishDpa,
  rows,
  run,
  TestDatabase,
} from './support/harness';
import {
  approve,
  draft,
  processed,
  storyText,
  submit,
  grantUpload,
} from './support/world';

/**
 * Consent at every step that processes testimony, enforced by the database (review round 1,
 * finding 1). The consent types per command come from the API plan (decision doc, "Updated API
 * plan (v1)", ⚑ routes) and libs/contracts (`x-requires-consent`, PR #28):
 *   edit, upload-url  → special_category_religious
 *   create draft → that, and the sign-up form in force accepted (18+ is there, D93)
 *   submit → those, and publish; approve (for the submitter) → special_category_religious,
 *     publish, age_18plus, on any version that counts
 * Withdrawing a story and erasure need none.
 */
describe('consent gates on edit, submit, approve and publish', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;
  const truth = <T = unknown>(sql: string, vars?: Record<string, unknown>) =>
    rows<T>(migrator, sql, vars);
  const ALL = ['special_category_religious', 'publish', 'age_18plus'] as const;
  /** Everything a person ticks: the testimony boxes, and the sign-up form's (D93). */
  const GRANTS = [...ALL, 'account_data'] as const;

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    await createPeople(t, {
      codex: 'user_codex',
      art9only: 'user_art9only',
      eve: 'user_eve',
      wd: 'user_wd',
      wf: 'user_wf',
      moderator: 'user_mod',
    });
    // These suites test consent, with more stories per person than D94 lets one start.
    await trustSubmitters(t, 'codex', 'art9only', 'eve', 'wd', 'wf');
    await publishDpa(t, 'v1');
  });
  afterAll(() => t?.close());

  it('Codex’s reproduction: after Art 9 withdrawal, edits, submit and approval all fail', async () => {
    const p = await t.person('user_codex');
    await consentEvent(p, 'special_category_religious', 'granted');
    await consentEvent(p, 'publish', 'granted');
    await consentEvent(p, 'age_18plus', 'granted');
    await consentEvent(p, 'account_data', 'granted');
    expect(await draft(p, 'codex_story')).toHaveLength(1);
    await consentEvent(p, 'special_category_religious', 'withdrawn');

    expect(
      await outcome(
        p,
        `UPDATE story:codex_story SET body = 'new testimony text'`,
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('current Art 9 consent'),
    });
    // D80: a person's session never writes media; the write is dropped (media stays empty).
    expect(
      await outcome(
        p,
        `UPDATE story:codex_story SET media = [{ format: 'video', bunnyVideoId: 'v1' }]`,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await outcome(p, `UPDATE story:codex_story SET status = 'pending'`),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('submitting a story needs'),
    });
    expect(
      await truth('SELECT body, media, status FROM story:codex_story'),
    ).toEqual([{ body: storyText('codex_story'), media: [], status: 'draft' }]);

    // Even if the story had reached pending earlier, approval is refused and nothing is published.
    await run(migrator, `UPDATE story:codex_story SET status = 'pending'`);
    await expect(approve(admin, 'codex_story')).rejects.toThrow();
    expect(await truth('SELECT VALUE status FROM story:codex_story')).toEqual([
      'pending',
    ]);
    expect(await truth('SELECT * FROM publicStory:codex_story')).toEqual([]);
    expect(await truth('SELECT * FROM moderationReview')).toEqual([]);
  });

  it('Art 9 and the sign-up form let a person write a draft, but not submit it', async () => {
    const p = await t.person('user_art9only');
    await consentEvent(p, 'special_category_religious', 'granted');
    // 18+ is on the sign-up form only (D93): no draft before it's accepted.
    expect(await draft(p, 'art9_story')).toEqual([]);
    await consentEvent(p, 'account_data', 'granted');
    await consentEvent(p, 'age_18plus', 'granted');
    expect(await draft(p, 'art9_story')).toHaveLength(1);
    await run(
      p,
      `UPDATE story:art9_story SET title = 'Edited with Art 9 consent'`,
    );
    expect(
      await outcome(p, `UPDATE story:art9_story SET status = 'pending'`),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('submitting a story needs'),
    });
    await consentEvent(p, 'publish', 'granted');
    expect(await submit(p, 'art9_story')).toHaveLength(1);
    expect(await truth('SELECT title, status FROM story:art9_story')).toEqual([
      { title: 'Edited with Art 9 consent', status: 'pending' },
    ]);
  });

  it.each(ALL)(
    'approval re-checks the ledger: refused once %s is withdrawn',
    async (type) => {
      const p = await t.person('user_eve');
      for (const c of GRANTS) await consentEvent(p, c, 'granted');
      const id = `eve_${type}`;
      await draft(p, id);
      await submit(p, id);
      await consentEvent(p, type, 'withdrawn');
      const result = await outcome(
        admin,
        `UPDATE type::record('story', $id) SET status = 'approved', approvedAt = time::now()`,
        { id },
      );
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('approving a story needs'),
      });
      expect(
        await truth(`SELECT VALUE status FROM type::record('story', $id)`, {
          id,
        }),
      ).toEqual(['pending']);
    },
  );

  it('the read model refuses a row for a story that isn’t approved, or without consent', async () => {
    const p = await t.person('user_eve');
    for (const c of GRANTS) await consentEvent(p, c, 'granted');
    await draft(p, 'eve_rm');
    await submit(p, 'eve_rm');
    const publish = () =>
      outcome(
        admin,
        `LET $s = (SELECT * FROM ONLY story:eve_rm);
         CREATE publicStory:eve_rm CONTENT {
           version: $s.version, slug: $s.slug, title: $s.title, description: $s.description,
           body: $s.body, primaryFormat: $s.primaryFormat, tagRefs: $s.tagRefs, media: [],
           publishedAt: time::now() };`,
      );
    expect(await publish()).toEqual({
      ok: false,
      error: expect.stringContaining('needs an approved story'),
    });
    await approve(admin, 'eve_rm');
    expect(await truth('SELECT VALUE id FROM publicStory:eve_rm')).toHaveLength(
      1,
    );
    // Withdrawing publish later: the row can't be re-written (WithdrawConsent deletes it, D17).
    await consentEvent(p, 'publish', 'withdrawn');
    expect(
      await outcome(
        admin,
        `UPDATE publicStory:eve_rm SET slugHistory = ['old-slug']`,
      ),
    ).toEqual({
      ok: false,
      error: expect.stringContaining('publishing needs'),
    });
  });

  it('withdrawing a story still works with no consent left', async () => {
    const p = await t.person('user_wd');
    for (const c of GRANTS) await consentEvent(p, c, 'granted');
    await draft(p, 'wd_story');
    await submit(p, 'wd_story');
    for (const c of ALL) await consentEvent(p, c, 'withdrawn');
    await run(p, `UPDATE story:wd_story SET status = 'withdrawn'`);
    expect(await truth('SELECT VALUE status FROM story:wd_story')).toEqual([
      'withdrawn',
    ]);
  });

  describe('service writes check the SUBMITTER’s consent, not the caller’s (round 2, P1-B)', () => {
    let workflow: Surreal;
    let p: Surreal;
    const media = (id: string) =>
      truth<{ media: unknown[] }>(
        `SELECT media FROM type::record('story', $id)`,
        { id },
      );
    beforeAll(async () => {
      workflow = await t.service('workflow');
      p = await t.person('user_wf');
      for (const c of GRANTS) await consentEvent(p, c, 'granted');
      // Video stories: D53 allows media only on video and audio stories.
      await draft(p, 'wf_draft', { primaryFormat: 'video' });
      await draft(p, 'wf_live', { primaryFormat: 'video' });
      // Their uploads (D80: api-user's grants put the videos on the drafts).
      const apiUser = await t.service('api_user');
      for (const [story, video] of [
        ['wf_draft', 'vid-1'],
        ['wf_live', 'vid-live'],
      ]) {
        expect(
          await grantUpload(apiUser, {
            video,
            story,
            person: 'wf',
            version: 1,
          }),
        ).toMatchObject({ ok: true });
      }
      await submit(p, 'wf_live');
      await processed(workflow, 'wf_live'); // A2: approval waits for processing
      await approve(admin, 'wf_live');
    });

    it('workflow writes media while the submitter consents', async () => {
      await run(
        workflow,
        `UPDATE story:wf_draft SET media[0].processing = 'processing'`,
      );
      expect((await media('wf_draft'))[0].media).toEqual([
        { format: 'video', bunnyVideoId: 'vid-1', processing: 'processing' },
      ]);
    });

    it.each(['wf_draft', 'wf_live'])(
      'workflow media/processing writes on %s are refused once Art 9 is withdrawn',
      async (id) => {
        await consentEvent(p, 'special_category_religious', 'withdrawn');
        const before = await media(id);
        for (const set of [
          `media = [{ format: 'video', bunnyVideoId: 'vid-2' }]`,
          `media[0].thumbnailPath = 'thumbs/x.jpg'`,
        ]) {
          expect(
            await outcome(
              workflow,
              `UPDATE type::record('story', $id) SET ${set}`,
              { id },
            ),
          ).toEqual({
            ok: false,
            error: expect.stringContaining('current Art 9 consent'),
          });
        }
        expect(await media(id)).toEqual(before);
        await consentEvent(p, 'special_category_religious', 'granted');
      },
    );

    it('moderation without content changes, withdrawal and deletion stay consent-free', async () => {
      for (const c of ALL) await consentEvent(p, c, 'withdrawn');
      await run(
        admin,
        `UPDATE story:wf_draft SET rejectionFeedback = 'n/a', lockedAt = time::now()`,
      );
      await run(p, `UPDATE story:wf_live SET status = 'withdrawn'`);
      await run(p, 'DELETE publicStory:wf_live');
      await run(admin, 'DELETE story:wf_draft');
      expect(await truth('SELECT VALUE status FROM story:wf_live')).toEqual([
        'withdrawn',
      ]);
      expect(
        await truth('SELECT * FROM story:wf_draft, publicStory:wf_live'),
      ).toEqual([]);
    });
  });
});

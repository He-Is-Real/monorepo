import type { Surreal } from 'surrealdb';
import {
  createPeople,
  grantAll,
  outcome,
  publishDpa,
  rows,
  run,
  STORY_TEXT_PADDING,
  TestDatabase,
} from './support/harness';
import { draft, ERASE, submit } from './support/world';

/**
 * The submission limits (D94), adjustable by an admin (W3, D112: submissionSettings, with
 * per-person overrides and the trusted mark in submitterLimits), and the 7-day submission record
 * that story deletion doesn't touch (D113). The database enforces all of it, so no client or
 * api-user bug can get round it.
 */
describe('submission limits, their settings and per-person overrides (D94, W3, D112, D113)', () => {
  let t: TestDatabase;
  let migrator: Surreal;
  let admin: Surreal;

  /** A person with every consent, as the submit flow leaves them. */
  async function person(p: string): Promise<Surreal> {
    await createPeople(t, { [p]: `user_${p}` });
    const s = await t.person(`user_${p}`);
    await grantAll(s);
    return s;
  }
  const status = async (id: string) =>
    (await rows(migrator, `SELECT VALUE status FROM story:${id}`))[0];
  const newDraft = (s: Surreal, id: string) =>
    outcome(
      s,
      `CREATE type::record('story', $id) CONTENT { submitter: $auth, slug: $id, title: 'T',
         description: '', body: $body, primaryFormat: 'written' }`,
      { id, body: `Text${STORY_TEXT_PADDING}` },
    );
  const pend = (s: Surreal, id: string) =>
    outcome(s, `UPDATE type::record('story', $id) SET status = 'pending'`, {
      id,
    });
  const limits = (p: string, fields: Record<string, unknown>) =>
    run(
      admin,
      `UPSERT type::record('submitterLimits', $p) MERGE object::extend($fields, {
         user: type::record('user', $p), changedBy: user:admin })`,
      { p, fields },
    );
  const settings = (fields: Record<string, unknown>) =>
    run(
      admin,
      `UPDATE submissionSettings:current MERGE object::extend($fields, { changedBy: user:admin })`,
      { fields },
    );
  const error = (o: { ok: boolean; error?: string }) => (o.ok ? '' : o.error);

  beforeAll(async () => {
    t = await TestDatabase.create();
    migrator = await t.migrator();
    admin = await t.service('api_admin');
    await createPeople(t, { admin: 'user_admin' });
    await publishDpa(t, 'v1');
  });
  afterAll(() => t?.close());

  it('starts from today’s values, written by the migration', async () => {
    expect(
      await rows(
        migrator,
        `SELECT storyTextMin, storyTextMax, tagsMin, tagsMax, openDraftsMax,
           submissionsPer7Days, uploadRequestsPerHour FROM submissionSettings:current`,
      ),
    ).toEqual([
      {
        storyTextMin: 200,
        storyTextMax: 10000,
        tagsMin: 1,
        tagsMax: 5,
        openDraftsMax: 3,
        submissionsPer7Days: 1,
        uploadRequestsPerHour: 10,
      },
    ]);
  });

  it('refuses a fourth open draft; submitting one makes room', async () => {
    const ann = await person('ann');
    for (const id of ['ann_1', 'ann_2', 'ann_3']) {
      expect(await draft(ann, id)).toHaveLength(1);
    }
    expect(error(await newDraft(ann, 'ann_4'))).toMatch(/limit_open_drafts:/);
    expect(await rows(migrator, 'SELECT id FROM story:ann_4')).toEqual([]);
    expect(await submit(ann, 'ann_1')).toHaveLength(1);
    expect(await draft(ann, 'ann_4')).toHaveLength(1);
  });

  it('allows one submission in any rolling 7 days, whatever happens to the story since', async () => {
    const bob = await person('bob');
    await draft(bob, 'bob_1');
    await draft(bob, 'bob_2');
    expect(
      await rows(bob, 'RETURN fn::story::next_submission_at($auth)'),
    ).toEqual([]);
    await submit(bob, 'bob_1');
    expect(error(await pend(bob, 'bob_2'))).toMatch(/limit_weekly_submission:/);
    expect(await status('bob_2')).toBe('draft');

    // Rolling, not a calendar week: exactly 7 days after the submission.
    const [at] = await rows<string>(
      bob,
      'SELECT VALUE at FROM submissionLog WHERE person = $auth',
    );
    const [next] = await rows<string>(
      bob,
      'RETURN fn::story::next_submission_at($auth)',
    );
    expect(new Date(next).getTime() - new Date(at).getTime()).toBe(
      7 * 24 * 3600 * 1000,
    );

    // Withdrawing it doesn't free the week, and nor does deleting it (D113).
    await run(bob, `UPDATE story:bob_1 SET status = 'withdrawn'`);
    expect(error(await pend(bob, 'bob_2'))).toMatch(/limit_weekly_submission:/);
    await run(await t.service('api_user'), 'DELETE story:bob_1');
    expect(await rows(migrator, 'SELECT id FROM story:bob_1')).toEqual([]);
    expect(error(await pend(bob, 'bob_2'))).toMatch(/limit_weekly_submission:/);
  });

  it('lets a story sent back for changes be submitted again, without counting it twice', async () => {
    const cat = await person('cat');
    await draft(cat, 'cat_1');
    await submit(cat, 'cat_1');
    await run(admin, `UPDATE story:cat_1 SET status = 'changes_requested'`);
    expect(await submit(cat, 'cat_1')).toHaveLength(1);
    expect(await status('cat_1')).toBe('pending');
    expect(
      await rows(
        migrator,
        'SELECT id FROM submissionLog WHERE person = user:cat',
      ),
    ).toHaveLength(1);
  });

  it('per-person overrides replace a limit for that person only; trusted lifts both', async () => {
    const dan = await person('dan');
    const eve = await person('eve');
    await limits('dan', { openDraftsMax: 4, submissionsPer7Days: 2 });
    for (const id of ['dan_1', 'dan_2', 'dan_3', 'dan_4']) {
      expect(await draft(dan, id)).toHaveLength(1);
    }
    expect(error(await newDraft(dan, 'dan_5'))).toMatch(/limit_open_drafts:/);
    expect(await submit(dan, 'dan_1')).toHaveLength(1);
    expect(await submit(dan, 'dan_2')).toHaveLength(1);
    expect(error(await pend(dan, 'dan_3'))).toMatch(/limit_weekly_submission:/);
    // Eve still has the settings' limits.
    for (const id of ['eve_1', 'eve_2', 'eve_3']) await draft(eve, id);
    expect(error(await newDraft(eve, 'eve_4'))).toMatch(/limit_open_drafts:/);

    await limits('dan', { trusted: true });
    expect(await submit(dan, 'dan_3')).toHaveLength(1);
    for (const id of ['dan_5', 'dan_6', 'dan_7']) {
      expect(await draft(dan, id)).toHaveLength(1);
    }
    expect(
      await rows(dan, 'RETURN fn::story::next_submission_at($auth)'),
    ).toEqual([]);
    await run(
      admin,
      'UPDATE submitterLimits:dan SET trusted = false, openDraftsMax = NONE, changedBy = user:admin',
    );
    expect(error(await newDraft(dan, 'dan_8'))).toMatch(/limit_open_drafts:/);

    // The person sees their own limits; every change is audited with the admin's name.
    expect(
      await rows(dan, 'RETURN fn::limits::effective($auth)'),
    ).toMatchObject([
      {
        trusted: false,
        openDraftsMax: 3,
        submissionsPer7Days: 2,
        uploadRequestsPerHour: 10,
      },
    ]);
    const audit = await rows<{ actor: string; service: string }>(
      migrator,
      `SELECT actor, service, createdAt FROM auditLog
         WHERE entity = user:dan AND action = 'UpdateSubmitterLimits' ORDER BY createdAt`,
    );
    expect(audit).toHaveLength(3);
    expect(
      audit.every((a) => a.actor === 'user:admin' && a.service === 'api-admin'),
    ).toBe(true);
  });

  it('an admin’s settings change the limits for everyone, audited with the admin’s name', async () => {
    const fay = await person('fay');
    try {
      await settings({ openDraftsMax: 1, submissionsPer7Days: 2 });
      expect(await draft(fay, 'fay_1')).toHaveLength(1);
      expect(error(await newDraft(fay, 'fay_2'))).toMatch(/limit_open_drafts:/);
      expect(await submit(fay, 'fay_1')).toHaveLength(1);
      await draft(fay, 'fay_2');
      expect(await submit(fay, 'fay_2')).toHaveLength(1);
      await draft(fay, 'fay_3');
      expect(error(await pend(fay, 'fay_3'))).toMatch(
        /limit_weekly_submission:/,
      );
      expect(
        await rows(
          migrator,
          `SELECT VALUE actor FROM auditLog WHERE entity = submissionSettings:current
             AND action = 'UpdateSubmissionSettings' AND actor != NONE`,
        ),
      ).toContain('user:admin');
    } finally {
      await settings({ openDraftsMax: 3, submissionsPer7Days: 1 });
    }
  });

  it('the limits in force apply to every later action: a draft over a new maximum can’t be submitted until edited, and trimming is always saved (Joel, 2026-10-30)', async () => {
    const gus = await person('gus');
    await run(
      admin,
      `CREATE tag:a SET name = 'A', category = 'theme';
       CREATE tag:b SET name = 'B', category = 'theme';
       CREATE tag:c SET name = 'C', category = 'theme';`,
    );
    const long = 'x'.repeat(300);
    await run(
      gus,
      `CREATE story:gus_1 CONTENT { submitter: $auth, slug: 'gus-1', title: 'T',
         description: '', body: $long, primaryFormat: 'written', tagRefs: [tag:a, tag:b, tag:c] }`,
      { long },
    );
    const set = (sql: string, vars?: Record<string, unknown>) =>
      outcome(gus, sql, vars);
    try {
      await settings({ storyTextMin: 50, storyTextMax: 250, tagsMax: 2 });
      // Making it worse is refused...
      expect(
        error(await set(`UPDATE story:gus_1 SET body = $b`, { b: `${long}y` })),
      ).toMatch(/story_text_too_long:/);
      expect(
        error(
          await set(
            `UPDATE story:gus_1 SET tagRefs = [tag:a, tag:b, tag:c, tag:a]`,
          ),
        ),
      ).toMatch(/story_too_many_tags:/);
      // ...but trimming is saved, even while it's still over (so it can be fixed).
      expect(
        (await set(`UPDATE story:gus_1 SET body = $b`, { b: 'x'.repeat(280) }))
          .ok,
      ).toBe(true);
      // Submitting needs the limits in force: too long, then too many themes, are refused.
      expect(error(await pend(gus, 'gus_1'))).toMatch(/story_text_too_long:/);
      await set(`UPDATE story:gus_1 SET body = $b`, { b: 'x'.repeat(240) });
      expect(error(await pend(gus, 'gus_1'))).toMatch(/story_too_many_tags:/);
      expect(await status('gus_1')).toBe('draft');
      await set(`UPDATE story:gus_1 SET tagRefs = [tag:a, tag:b]`);
      expect(await submit(gus, 'gus_1')).toHaveLength(1);
      expect(await status('gus_1')).toBe('pending');

      // The minimum to submit is the setting in force too.
      await settings({ storyTextMin: 400, storyTextMax: 10000 });
      await limits('gus', { trusted: true });
      await draft(gus, 'gus_2', { body: long });
      expect(error(await pend(gus, 'gus_2'))).toContain(
        'a written story needs at least 400 characters',
      );
    } finally {
      await settings({ storyTextMin: 200, storyTextMax: 10000, tagsMax: 5 });
    }
  });

  it('a lowered open-drafts limit keeps someone’s drafts but blocks new ones until they’re under it', async () => {
    const ola = await person('ola');
    for (const id of ['ola_1', 'ola_2', 'ola_3']) await draft(ola, id);
    try {
      await settings({ openDraftsMax: 2 });
      expect(
        await rows(
          migrator,
          'SELECT VALUE id FROM story WHERE submitter = user:ola',
        ),
      ).toHaveLength(3);
      expect(error(await newDraft(ola, 'ola_4'))).toMatch(/limit_open_drafts:/);
      // Their drafts can still be edited.
      expect(
        (await outcome(ola, `UPDATE story:ola_1 SET title = 'Still mine'`)).ok,
      ).toBe(true);
      await run(await t.service('api_user'), 'DELETE story:ola_1, story:ola_2');
      expect(await draft(ola, 'ola_4')).toHaveLength(1);
    } finally {
      await settings({ openDraftsMax: 3 });
    }
  });

  it('only api-admin (naming the admin) and the migrator change settings and limits', async () => {
    const hal = await person('hal');
    const writers = [
      hal,
      await t.service('api_user'),
      await t.service('workflow'),
      await t.service('api_public_read'),
    ];
    for (const writer of writers) {
      await outcome(
        writer,
        `UPDATE submissionSettings:current SET openDraftsMax = 999, changedBy = user:admin;
         UPSERT submitterLimits:hal SET user = user:hal, trusted = true, changedBy = user:admin;`,
      );
    }
    expect(
      await rows(
        migrator,
        'SELECT VALUE openDraftsMax FROM submissionSettings:current',
      ),
    ).toEqual([3]);
    expect(await rows(migrator, 'SELECT id FROM submitterLimits:hal')).toEqual(
      [],
    );

    // api-admin must say which admin did it (the record keeps the last admin's name, so
    // api-admin sets it on every change); the settings stay consistent and single.
    for (const sql of [
      'UPDATE submissionSettings:current SET storyTextMin = 20000, changedBy = user:admin',
      'CREATE submissionSettings:other SET changedBy = user:admin',
      'CREATE submitterLimits:hal SET user = user:hal, trusted = true',
      'CREATE submitterLimits:hal SET user = user:dan, trusted = true, changedBy = user:admin',
    ]) {
      expect((await outcome(admin, sql)).ok, sql).toBe(false);
    }
    // The person reads their own row only.
    await limits('hal', { trusted: true });
    expect(
      await rows(hal, 'SELECT VALUE trusted FROM submitterLimits'),
    ).toEqual([true]);
  });

  it('an admin resets someone’s limits with an audited update; only erasure deletes the row (Codex #118, 7)', async () => {
    await person('ned');
    await limits('ned', { trusted: true, openDraftsMax: 9 });
    // api-admin can't delete it: the reset would leave no trace.
    await outcome(admin, 'DELETE submitterLimits:ned');
    expect(
      await rows(migrator, 'SELECT VALUE trusted FROM submitterLimits:ned'),
    ).toEqual([true]);
    await run(
      admin,
      `UPDATE submitterLimits:ned SET trusted = false, openDraftsMax = NONE,
         submissionsPer7Days = NONE, uploadRequestsPerHour = NONE, changedBy = user:admin`,
    );
    expect(
      await rows(migrator, 'RETURN fn::limits::effective(user:ned)'),
    ).toMatchObject([{ trusted: false, openDraftsMax: 3 }]);
    expect(
      await rows(
        migrator,
        `SELECT VALUE actor FROM auditLog WHERE entity = user:ned AND action = 'UpdateSubmitterLimits'`,
      ),
    ).toEqual(['user:admin', 'user:admin']);
  });

  it('dev-seed’s test-account mark is refused outside dev (D112)', async () => {
    await person('ivy');
    const refused = await outcome(
      migrator,
      'CREATE submitterLimits:ivy SET user = user:ivy, trusted = true, devSeed = true',
    );
    expect(error(refused)).toMatch(/dev only/);
  });

  it('limits only the person’s own writes: data loaded by the migrator isn’t limited', async () => {
    await person('jay');
    for (const id of ['jay_1', 'jay_2', 'jay_3', 'jay_4']) {
      await run(
        migrator,
        `CREATE type::record('story', $id) CONTENT { submitter: user:jay, slug: $id, title: 'T',
           description: '', body: 'Text', primaryFormat: 'written' }`,
        { id },
      );
    }
    expect(
      await rows(
        migrator,
        'SELECT VALUE id FROM story WHERE submitter = user:jay',
      ),
    ).toHaveLength(4);
  });

  it('erasure deletes the person’s limits and their submission record', async () => {
    const kim = await person('kim');
    await limits('kim', { trusted: true });
    await draft(kim, 'kim_1');
    await submit(kim, 'kim_1');
    await run(await t.service('api_user'), ERASE, {
      clerkUserId: 'user_kim',
      reason: 'account_deleted',
    });
    expect(await rows(migrator, 'SELECT id FROM submitterLimits:kim')).toEqual(
      [],
    );
    expect(
      await rows(
        migrator,
        'SELECT id FROM submissionLog WHERE person = user:kim',
      ),
    ).toEqual([]);
  });
});

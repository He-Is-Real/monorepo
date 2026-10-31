import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  consentEvent,
  createPeople,
  grantAll,
  publishDpa,
  rows,
  run,
  STORY_TEXT_PADDING,
  TestDatabase,
} from '@heisreal/database/integration-testing';
import { SECRET_MANAGER_CLIENT, SECRETS_PROJECT } from '@heisreal/secrets';
import type { Surreal } from 'surrealdb';
import { AppModule } from '../src/app/app.module';

/**
 * The submit flow for written stories (M2 plan PR 4) through api-user's real AppModule on its
 * own login (D13), as web's /share page calls it: tags, create, autosave, resume, submit.
 * The database is the behaviour here: consent (D21, D93), the content lock, the text minimum and
 * D94's limits. Every answer is checked against api-user.yaml, like web's e2e stub of it.
 */
describe('the submit flow for written stories', () => {
  const contract = new Contract('api-user.yaml');
  let t: TestDatabase;
  let clerk: TestClerk;
  let migrator: Surreal;
  let app: INestApplication;
  let url: string;
  let keySeq = 0;

  const TEXT = `My story${STORY_TEXT_PADDING}`;
  const key = () => `test-key-${++keySeq}-${'x'.repeat(16)}`;

  async function call(
    method: string,
    path: string,
    who: string | undefined,
    {
      body,
      headers = {},
      contentType = 'application/json',
    }: {
      body?: unknown;
      headers?: Record<string, string>;
      contentType?: string;
    } = {},
  ) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(who
          ? { authorization: `Bearer ${clerk.token(`user_${who}`)}` }
          : {}),
        ...(body !== undefined ? { 'content-type': contentType } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(await contract.check(method, res), `${method} ${path}`).toEqual([]);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  const create = (
    who: string,
    fields: Record<string, unknown> = {},
    k = key(),
  ) =>
    call('POST', '/v1/stories', who, {
      body: {
        title: 'How I found hope',
        primaryFormat: 'written',
        body: TEXT,
        ...fields,
      },
      headers: { 'idempotency-key': k },
    });
  const patch = (who: string, id: string, version: number, body: unknown) =>
    call('PATCH', `/v1/stories/${id}`, who, {
      body,
      contentType: 'application/merge-patch+json',
      headers: { 'if-match': `"${version}"` },
    });
  const submit = (who: string, id: string, version: number, k = key()) =>
    call('POST', `/v1/stories/${id}/submit`, who, {
      headers: { 'if-match': `"${version}"`, 'idempotency-key': k },
    });
  const storiesOf = (who: string) =>
    rows(
      migrator,
      'SELECT VALUE status FROM story WHERE submitter.clerkUserId = $c',
      { c: `user_${who}` },
    );
  /** A person as the flow leaves them: signed up, testimony consent and publish given. */
  async function person(who: string, grant = true) {
    await createPeople(t, { [who]: `user_${who}` });
    if (grant) await grantAll(await t.person(`user_${who}`));
  }

  beforeAll(async () => {
    t = await TestDatabase.create();
    clerk = newTestClerk(t.keys, {
      namespace: t.namespace,
      database: t.database,
    });
    migrator = await t.migrator();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SURREAL)
      .useValue(await t.service('api_user'))
      .overrideProvider(CLERK_CONFIG)
      .useValue(
        parseClerkConfig({
          issuer: clerk.issuer,
          publicKeyPem: clerk.publicKeyPem,
          authorizedParties: clerk.authorizedParty,
        }),
      )
      .overrideProvider(SECRET_MANAGER_CLIENT)
      .useValue({})
      .overrideProvider(SECRETS_PROJECT)
      .useValue('test-project')
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await publishDpa(t, 'v1');
    await run(
      await t.service('api_admin'),
      `CREATE tag:healing SET name = 'Healing', category = 'theme';
       CREATE tag:doubt SET name = 'Doubt', category = 'journey';
       CREATE tag:anxiety SET name = 'Anxiety', category = 'emotion';`,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('lists every tag, by category then name', async () => {
    await person('tagger');
    const res = await call('GET', '/v1/tags', 'tagger');
    expect(res.status).toBe(200);
    expect(res.body.data.map((tag: { slug: string }) => tag.slug)).toEqual([
      'healing',
      'doubt',
      'anxiety',
    ]);
  });

  it('creates, autosaves, resumes and submits a written story to pending', async () => {
    await person('ann');
    const k = key();
    const created = await create('ann', { tagSlugs: [] }, k);
    expect(created.status).toBe(201);
    const { id, version } = created.body;
    expect(version).toBe(1);
    expect(created.headers.get('location')).toBe(`/v1/account/stories/${id}`);
    expect(created.headers.get('etag')).toBe('"1"');

    // A retry with the same key replays; the same key for another story is refused.
    expect((await create('ann', { tagSlugs: [] }, k)).body).toEqual({
      id,
      version: 1,
    });
    expect((await create('ann', { title: 'Another' }, k)).status).toBe(422);
    expect(await storiesOf('ann')).toEqual(['draft']);

    // Autosave: a merge patch at the version read.
    const saved = await patch('ann', id, 1, {
      description: 'Hope after a hard year',
      bylineName: '  ',
      tagSlugs: ['healing', 'doubt'],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ id, version: 2 });
    expect(saved.headers.get('etag')).toBe('"2"');

    // Resume: the person reads it back (blank first name = anonymous).
    const mine = await call('GET', `/v1/account/stories/${id}`, 'ann');
    expect(mine.headers.get('etag')).toBe('"2"');
    expect(mine.body).toMatchObject({
      id,
      version: 2,
      status: 'draft',
      title: 'How I found hope',
      description: 'Hope after a hard year',
      body: TEXT,
      bylineName: null,
      primaryFormat: 'written',
      tags: [
        { slug: 'healing', name: 'Healing' },
        { slug: 'doubt', name: 'Doubt' },
      ],
    });
    expect(mine.body.slug).toMatch(/^how-i-found-hope-[0-9a-f]{8}$/);
    expect(
      (
        await call('GET', `/v1/account/stories/${id}`, 'ann', {
          headers: { 'if-none-match': '"2"' },
        })
      ).status,
    ).toBe(304);
    const drafts = await call('GET', '/v1/account/stories?status=draft', 'ann');
    expect(drafts.body).toMatchObject({ data: [{ id }], nextCursor: null });

    const sent = await submit('ann', id, 2);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ id, version: 3 });
    const after = await call('GET', `/v1/account/stories/${id}`, 'ann');
    expect(after.body.status).toBe('pending');
    expect(after.body.submittedAt).toEqual(expect.any(String));

    // Locked once submitted (what a moderator reviews is what gets published).
    const locked = await patch('ann', id, 3, { title: 'Changed' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('story_locked');
  });

  it('answers 412 to a stale version and 428 without one, changing nothing', async () => {
    await person('tab');
    const { id } = (await create('tab')).body;
    expect((await patch('tab', id, 1, { title: 'First tab' })).status).toBe(
      200,
    );
    const stale = await patch('tab', id, 1, { title: 'Second tab' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('stale_version');
    const missing = await call('PATCH', `/v1/stories/${id}`, 'tab', {
      body: { title: 'No version' },
      contentType: 'application/merge-patch+json',
    });
    expect(missing.status).toBe(428);
    const mine = await call('GET', `/v1/account/stories/${id}`, 'tab');
    expect(mine.body).toMatchObject({ title: 'First tab', version: 2 });
  });

  it('stores nothing without testimony consent, or before the sign-up form is accepted', async () => {
    await person('noart9', false);
    const refused = await create('noart9');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('consent_required');

    // Art 9 given but the sign-up form (18+, account) not accepted (D73).
    const p = await t.person('user_noart9');
    await consentEvent(p, 'special_category_religious', 'granted');
    expect((await create('noart9')).status).toBe(403);
    expect(await storiesOf('noart9')).toEqual([]);

    await consentEvent(p, 'age_18plus', 'granted');
    await consentEvent(p, 'account_data', 'granted');
    expect((await create('noart9')).status).toBe(201);
  });

  it('refuses to submit without publish consent, tags or 200 characters, saying which', async () => {
    await person('pub', false);
    const p = await t.person('user_pub');
    for (const type of [
      'special_category_religious',
      'age_18plus',
      'account_data',
    ] as const) {
      await consentEvent(p, type, 'granted');
    }
    const { id } = (await create('pub', { body: 'Too short' })).body;
    const noPublish = await submit('pub', id, 1);
    expect(noPublish.status).toBe(403);
    expect(noPublish.body.code).toBe('consent_required');

    await consentEvent(p, 'publish', 'granted');
    const noTags = await submit('pub', id, 1);
    expect(noTags.status).toBe(400);
    expect(noTags.body).toMatchObject({
      code: 'tags_required',
      errors: [{ pointer: '/tagSlugs' }],
    });
    await patch('pub', id, 1, { tagSlugs: ['healing'] });
    const short = await submit('pub', id, 2);
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({
      code: 'story_text_too_short',
      errors: [{ pointer: '/body' }],
    });
    expect(await storiesOf('pub')).toEqual(['draft']);
  });

  it('validates fields and refuses unknown tags, without echoing what was sent', async () => {
    await person('val');
    const bad = await create('val', {
      title: ' ',
      tagSlugs: ['healing', 'no-such-tag'],
      secret: 'testimony words',
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('testimony words');
    const unknown = await create('val', { tagSlugs: ['no-such-tag'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors).toEqual([
      expect.objectContaining({ pointer: '/tagSlugs' }),
    ]);
    const { id } = (await create('val')).body;
    const emptied = await patch('val', id, 1, { body: '   ' });
    expect(emptied.status).toBe(400);
  });

  it('keeps people’s stories apart', async () => {
    await person('own');
    await person('other');
    const { id } = (await create('own')).body;
    expect(
      (await call('GET', `/v1/account/stories/${id}`, 'other')).status,
    ).toBe(404);
    expect((await patch('other', id, 1, { title: 'Mine now' })).status).toBe(
      404,
    );
    expect((await submit('other', id, 1)).status).toBe(404);
    expect(
      (await call('GET', '/v1/account/stories', 'other')).body.data,
    ).toEqual([]);
  });

  it('applies D94’s limits with plain messages, and lifts them for a trusted submitter', async () => {
    await person('lim');
    for (let i = 0; i < 3; i++) expect((await create('lim')).status).toBe(201);
    const fourth = await create('lim');
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({
      code: 'draft_limit_reached',
      detail: expect.stringContaining('as many drafts open as you can'),
    });

    const drafts = (
      await call('GET', '/v1/account/stories?status=draft&limit=2', 'lim')
    ).body;
    expect(drafts.data).toHaveLength(2);
    const rest = (
      await call(
        'GET',
        `/v1/account/stories?status=draft&limit=2&cursor=${drafts.nextCursor}`,
        'lim',
      )
    ).body;
    expect(rest).toMatchObject({ nextCursor: null });
    const [a, b] = [...drafts.data, ...rest.data] as {
      id: string;
      version: number;
    }[];
    await patch('lim', a.id, 1, { tagSlugs: ['healing'] });
    await patch('lim', b.id, 1, { tagSlugs: ['healing'] });
    expect((await submit('lim', a.id, 2)).status).toBe(200);
    const second = await submit('lim', b.id, 2);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('weekly_submission_limit_reached');
    const wait = Date.parse(second.body.availableAt) - Date.now();
    expect(wait).toBeGreaterThan(6.9 * 864e5);
    expect(wait).toBeLessThanOrEqual(7 * 864e5);

    await run(
      migrator,
      `UPSERT submitterLimits:lim SET user = user:lim, trusted = true`,
    );
    expect((await submit('lim', b.id, 2)).status).toBe(200);
  });

  it('tells the page the limits that apply, from the admin’s settings and the person’s override', async () => {
    await person('lims');
    const read = async () =>
      (await call('GET', '/v1/account/limits', 'lims')).body;
    expect(await read()).toEqual({
      storyText: { min: 200, max: 10000 },
      tags: { min: 1, max: 5 },
      openDrafts: { max: 3, open: 0 },
      submissions: { per7Days: 1, nextAvailableAt: null },
      uploads: {
        videoMaxBytes: 4294967296,
        audioMaxBytes: 524288000,
        maxDurationSeconds: 900,
        perHour: 10,
        per7Days: 5,
        nextAvailableAt: null,
      },
    });
    const admin = await t.service('api_admin');
    await createPeople(t, { limadmin: 'user_limadmin' });
    try {
      await run(
        admin,
        `UPDATE submissionSettings:current SET storyTextMin = 20, storyTextMax = 300, tagsMax = 2,
           changedBy = user:limadmin;
         UPSERT submitterLimits:lims SET user = user:lims, openDraftsMax = 1,
           changedBy = user:limadmin;`,
      );
      expect(await read()).toMatchObject({
        storyText: { min: 20, max: 300 },
        tags: { min: 1, max: 2 },
        openDrafts: { max: 1, open: 0 },
      });
      // The commands follow the settings: too long or too many themes is 400, the minimum is 20.
      const long = await create('lims', { body: 'x'.repeat(301) });
      expect(long.status).toBe(400);
      expect(long.body.errors).toEqual([
        expect.objectContaining({ pointer: '/body' }),
      ]);
      const tags = await create('lims', {
        tagSlugs: ['healing', 'doubt', 'anxiety'],
      });
      expect(tags.body.errors).toEqual([
        expect.objectContaining({ pointer: '/tagSlugs' }),
      ]);
      const ok = await create('lims', {
        body: 'Twenty-one characters',
        tagSlugs: ['healing'],
      });
      expect(ok.status).toBe(201);
      expect((await create('lims')).body.code).toBe('draft_limit_reached');
      expect((await submit('lims', ok.body.id, 1)).status).toBe(200);
      expect((await read()).submissions.nextAvailableAt).toEqual(
        expect.any(String),
      );
    } finally {
      await run(
        admin,
        `UPDATE submissionSettings:current SET storyTextMin = 200, storyTextMax = 10000,
           tagsMax = 5, changedBy = user:limadmin`,
      );
    }
  });

  it('never needs more themes than there are, even after a system user deletes some (Codex, admin limits round 3)', async () => {
    await person('few');
    const admin = await t.service('api_admin');
    await createPeople(t, { fewadmin: 'user_fewadmin' });
    await run(
      admin,
      `UPDATE submissionSettings:current SET tagsMin = 3, changedBy = user:fewadmin`,
    );
    try {
      // A migration or dev-seed's reset isn't checked by the admin guard: 2 themes, tagsMin 3.
      await run(migrator, 'DELETE tag:anxiety');
      const limits = (await call('GET', '/v1/account/limits', 'few')).body;
      expect(limits.tags).toEqual({ min: 2, max: 5 });

      const { id } = (await create('few', { tagSlugs: ['healing'] })).body;
      const one = await submit('few', id, 1);
      expect(one.status).toBe(400);
      expect(one.body).toMatchObject({
        code: 'tags_required',
        errors: [{ pointer: '/tagSlugs', message: 'choose at least 2' }],
      });
      await patch('few', id, 1, { tagSlugs: ['healing', 'doubt'] });
      expect((await submit('few', id, 2)).status).toBe(200);
      expect(await storiesOf('few')).toEqual(['pending']);
    } finally {
      await run(
        migrator,
        `CREATE tag:anxiety SET name = 'Anxiety', category = 'emotion'`,
      );
      await run(
        admin,
        `UPDATE submissionSettings:current SET tagsMin = 1, changedBy = user:fewadmin`,
      );
    }
  });

  it('a draft over a newly lowered maximum can’t be submitted until edited; trimming saves are accepted (Joel, 2026-10-30)', async () => {
    await person('grand');
    const admin = await t.service('api_admin');
    await createPeople(t, { grandadmin: 'user_grandadmin' });
    const body = 'x'.repeat(300);
    const { id } = (
      await create('grand', { body, tagSlugs: ['healing', 'doubt', 'anxiety'] })
    ).body;
    try {
      await run(
        admin,
        `UPDATE submissionSettings:current SET storyTextMax = 250, tagsMax = 2,
           changedBy = user:grandadmin`,
      );
      // Over both new maximums: refused at submit, each saying the limit in force.
      const long = await submit('grand', id, 1);
      expect(long.status).toBe(400);
      expect(long.body).toMatchObject({
        code: 'story_text_too_long',
        limit: 250,
      });
      expect(long.body.detail).toContain('250 characters');
      // Making it worse is refused; trimming is saved, even while still over.
      expect((await patch('grand', id, 1, { body: `${body}y` })).status).toBe(
        400,
      );
      expect(
        (await patch('grand', id, 1, { body: 'x'.repeat(280) })).status,
      ).toBe(200);
      expect(
        (await patch('grand', id, 2, { body: 'x'.repeat(240) })).status,
      ).toBe(200);
      const tags = await submit('grand', id, 3);
      expect(tags.body).toMatchObject({ code: 'too_many_tags', limit: 2 });
      expect(
        (await patch('grand', id, 3, { tagSlugs: ['healing', 'doubt'] }))
          .status,
      ).toBe(200);
      expect((await submit('grand', id, 4)).status).toBe(200);
      expect(
        (await call('GET', `/v1/account/stories/${id}`, 'grand')).body.status,
      ).toBe('pending');
    } finally {
      await run(
        admin,
        'UPDATE submissionSettings:current SET storyTextMax = 10000, tagsMax = 5, changedBy = user:grandadmin',
      );
    }
  });

  it('refuses a missing or forged token', async () => {
    expect((await call('GET', '/v1/tags', undefined)).status).toBe(401);
    expect(
      (
        await call('POST', '/v1/stories', undefined, {
          body: { title: 'x', primaryFormat: 'written', body: 'x' },
          headers: { 'idempotency-key': key() },
        })
      ).status,
    ).toBe(401);
  });
});

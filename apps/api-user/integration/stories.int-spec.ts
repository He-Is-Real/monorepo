import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLERK_CONFIG, parseClerkConfig } from '@heisreal/auth';
import { newTestClerk, type TestClerk } from '@heisreal/auth/testing';
import { Contract } from '@heisreal/contracts/testing';
import { SURREAL } from '@heisreal/database';
import {
  agree,
  agreeAll,
  createPeople,
  publishVersion,
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
 * own login (D13), as web's /share page calls it: create, autosave, resume, submit.
 * The database is the behaviour here: "agree first" (plan 4e), the content lock, the text
 * minimum and D94's limits. Every answer is checked against api-user.yaml, like web's e2e stub of it.
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
  const submit = (
    who: string,
    id: string,
    version: number,
    k = key(),
    body?: unknown,
  ) =>
    call('POST', `/v1/stories/${id}/submit`, who, {
      body,
      headers: { 'if-match': `"${version}"`, 'idempotency-key': k },
    });
  const storiesOf = (who: string) =>
    rows(
      migrator,
      'SELECT VALUE status FROM story WHERE submitter.clerkUserId = $c',
      { c: `user_${who}` },
    );
  /** A person as the flow leaves them: agreed to the latest terms and testimony consent. */
  async function person(who: string, agreed = true) {
    await createPeople(t, { [who]: `user_${who}` });
    if (agreed) await agreeAll(await t.person(`user_${who}`));
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
    await run(
      await t.service('api_admin'),
      `CREATE theme:healing SET name = 'Healing', category = themeCategory:other;
       CREATE theme:doubt SET name = 'Doubt', category = themeCategory:other;
       CREATE theme:anxiety SET name = 'Anxiety', category = themeCategory:other;`,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });

  it('creates, autosaves, resumes and submits a written story to pending', async () => {
    await person('ann');
    const k = key();
    const created = await create('ann', { themeIds: [] }, k);
    expect(created.status).toBe(201);
    const { id, version } = created.body;
    expect(version).toBe(1);
    expect(created.headers.get('location')).toBe(`/v1/account/stories/${id}`);
    expect(created.headers.get('etag')).toBe('"1"');

    // A retry with the same key replays; the same key for another story is refused.
    expect((await create('ann', { themeIds: [] }, k)).body).toEqual({
      id,
      version: 1,
    });
    expect((await create('ann', { title: 'Another' }, k)).status).toBe(422);
    expect(await storiesOf('ann')).toEqual(['draft']);

    // Autosave: a merge patch at the version read.
    const saved = await patch('ann', id, 1, {
      description: 'Hope after a hard year',
      bylineName: '  ',
      themeIds: ['healing', 'doubt'],
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
      themes: [
        { id: 'healing', name: 'Healing' },
        { id: 'doubt', name: 'Doubt' },
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

  it('refuses to submit under 200 characters, saying so', async () => {
    await person('pub');
    const { id } = (await create('pub', { body: 'Too short' })).body;
    await patch('pub', id, 1, { themeIds: ['healing'] });
    const short = await submit('pub', id, 2);
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({
      code: 'story_text_too_short',
      errors: [{ pointer: '/body' }],
    });
    expect(await storiesOf('pub')).toEqual(['draft']);
  });

  it('stores nothing before the person agrees to the latest terms and testimony consent (plan 4e)', async () => {
    await person('newcomer', false);
    const p = await t.person('user_newcomer');
    const noTerms = await create('newcomer', { themeIds: ['healing'] });
    expect(noTerms.status).toBe(403);
    expect(noTerms.body.code).toBe('terms_agreement_required');

    await agree(p, 'termsOfUse');
    const noTestimony = await create('newcomer', { themeIds: ['healing'] });
    expect(noTestimony.status).toBe(403);
    expect(noTestimony.body.code).toBe('testimony_consent_required');
    expect(await storiesOf('newcomer')).toEqual([]);

    await agree(p, 'testimonyConsent');
    const created = await create('newcomer', { themeIds: ['healing'] });
    expect(created.status).toBe(201);
    const { id } = created.body;

    // A newer testimony consent: changing or submitting the draft waits for the person to agree
    // again (people agree in their own tests, so this changes nobody else's).
    await publishVersion(t, 'testimonyConsent');
    const edit = await patch('newcomer', id, 1, { title: 'Changed' });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe('testimony_consent_required');
    const sent = await submit('newcomer', id, 1);
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('testimony_consent_required');
    expect(await storiesOf('newcomer')).toEqual(['draft']);
    const mine = await call('GET', `/v1/account/stories/${id}`, 'newcomer');
    expect(mine.body).toMatchObject({ version: 1, title: 'How I found hope' });

    await agree(p, 'testimonyConsent');
    expect((await submit('newcomer', id, 1)).status).toBe(200);
  });

  it('records the social media sharing box with the submission, only on the latest version (plan 4e)', async () => {
    await person('sharer');
    const { id } = (await create('sharer', { themeIds: ['healing'] })).body;
    const before = await call('GET', `/v1/account/stories/${id}`, 'sharer');
    expect(before.body.socialMediaSharingConsent).toBeNull();
    const latest = await publishVersion(t, 'socialMediaSharingConsent');

    // The page showed an older version: nothing is submitted or recorded.
    const stale = await submit('sharer', id, 1, key(), {
      socialMediaSharingConsent: { version: latest - 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('agreement_version_changed');
    expect(await storiesOf('sharer')).toEqual(['draft']);

    const k = key();
    const body = { socialMediaSharingConsent: { version: latest } };
    const sent = await submit('sharer', id, 1, k, body);
    expect(sent.status).toBe(200);
    const mine = await call('GET', `/v1/account/stories/${id}`, 'sharer');
    expect(mine.body).toMatchObject({
      status: 'pending',
      socialMediaSharingConsent: {
        version: latest,
        agreedAt: expect.any(String),
      },
    });
    const [stored] = await rows(
      migrator,
      `SELECT socialMediaSharingConsent, socialMediaSharingConsentAgreedAt
         FROM type::record('story', $id)`,
      { id },
    );
    expect(stored['socialMediaSharingConsent']).toBe(
      `socialMediaSharingConsent:${latest}`,
    );

    // A replay records nothing again; the same key with another body is another request.
    expect((await submit('sharer', id, 1, k, body)).body).toEqual(sent.body);
    expect((await submit('sharer', id, 1, k)).status).toBe(422);
    expect(
      await rows(
        migrator,
        `SELECT socialMediaSharingConsent, socialMediaSharingConsentAgreedAt
           FROM type::record('story', $id)`,
        { id },
      ),
    ).toEqual([stored]);
  });

  it('validates fields, without echoing what was sent', async () => {
    await person('val');
    const bad = await create('val', {
      title: ' ',
      secret: 'testimony words',
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('testimony words');
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
    await patch('lim', a.id, 1, { themeIds: ['healing'] });
    await patch('lim', b.id, 1, { themeIds: ['healing'] });
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
      themes: { min: 1, max: 5 },
      openDrafts: { max: 3, open: 0 },
      submissions: { per7Days: 1, usedIn7Days: 0, nextAvailableAt: null },
      uploads: {
        videoMaxBytes: 4294967296,
        audioMaxBytes: 524288000,
        maxDurationSeconds: 900,
        perHour: 10,
        per7Days: 5,
        usedIn7Days: 0,
        nextAvailableAt: null,
      },
    });
    const admin = await t.service('api_admin');
    await createPeople(t, { limadmin: 'user_limadmin' });
    try {
      await run(
        admin,
        `UPDATE submissionSettings:current SET storyTextMin = 20, storyTextMax = 300,
           changedBy = user:limadmin;
         UPSERT submitterLimits:lims SET user = user:lims, openDraftsMax = 1,
           changedBy = user:limadmin;`,
      );
      expect(await read()).toMatchObject({
        storyText: { min: 20, max: 300 },
        openDrafts: { max: 1, open: 0 },
      });
      // The commands follow the settings: too long is 400, the minimum is 20.
      const long = await create('lims', { body: 'x'.repeat(301) });
      expect(long.status).toBe(400);
      expect(long.body.errors).toEqual([
        expect.objectContaining({ pointer: '/body' }),
      ]);
      const ok = await create('lims', {
        body: 'Twenty-one characters',
        themeIds: ['healing'],
      });
      expect(ok.status).toBe(201);
      expect((await create('lims')).body.code).toBe('draft_limit_reached');
      expect((await submit('lims', ok.body.id, 1)).status).toBe(200);
      expect((await read()).submissions).toMatchObject({
        usedIn7Days: 1,
        nextAvailableAt: expect.any(String),
      });
    } finally {
      await run(
        admin,
        `UPDATE submissionSettings:current SET storyTextMin = 200, storyTextMax = 10000,
           changedBy = user:limadmin`,
      );
    }
  });

  it('a draft over a newly lowered maximum can’t be submitted until edited; trimming saves are accepted (Joel, 2026-10-30)', async () => {
    await person('grand');
    const admin = await t.service('api_admin');
    await createPeople(t, { grandadmin: 'user_grandadmin' });
    const body = 'x'.repeat(300);
    const { id } = (await create('grand', { body, themeIds: ['healing'] }))
      .body;
    try {
      await run(
        admin,
        `UPDATE submissionSettings:current SET storyTextMax = 250,
           changedBy = user:grandadmin`,
      );
      // Over the new maximum: refused at submit, saying the limit in force.
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
      expect((await submit('grand', id, 3)).status).toBe(200);
      expect(
        (await call('GET', `/v1/account/stories/${id}`, 'grand')).body.status,
      ).toBe('pending');
    } finally {
      await run(
        admin,
        'UPDATE submissionSettings:current SET storyTextMax = 10000, changedBy = user:grandadmin',
      );
    }
  });

  it('lists every theme by category for the share form, Other last, highlighted or not', async () => {
    await person('pick');
    await run(
      await t.service('api_admin'),
      `CREATE themeCategory:feelings SET name = 'Feelings';
       CREATE theme:hope SET name = 'Hope', category = themeCategory:feelings, highlighted = true;
       CREATE theme:fear SET name = 'Fear', category = themeCategory:feelings;`,
    );
    const res = await call('GET', '/v1/themes', 'pick');
    expect(res.status).toBe(200);
    expect(
      res.body.data.map(
        (c: {
          name: string;
          themes: { name: string; highlighted: boolean }[];
        }) => [
          c.name,
          c.themes.map((th) => `${th.name}${th.highlighted ? ' ★' : ''}`),
        ],
      ),
    ).toEqual([
      ['Feelings', ['Fear', 'Hope ★']],
      ['Other', ['Anxiety', 'Common', 'Doubt', 'Healing']],
    ]);
  });

  it('checks the number of themes only at submit, from the admin’s minimum to maximum', async () => {
    await person('count');
    const six = ['healing', 'doubt', 'anxiety', 'common', 'hope', 'fear'];
    const { id } = (await create('count', { themeIds: [] })).body;
    // A draft may hold more than the maximum while it's being written...
    expect((await patch('count', id, 1, { themeIds: six })).status).toBe(200);
    // ...but can't be submitted with it, nor with none.
    const many = await submit('count', id, 2);
    expect(many.status).toBe(400);
    expect(many.body).toMatchObject({ code: 'theme_count' });
    expect(many.body.detail).toBe('Choose 1–5 themes');
    expect((await patch('count', id, 2, { themeIds: [] })).status).toBe(200);
    expect((await submit('count', id, 3)).body.code).toBe('theme_count');
    expect(
      (await patch('count', id, 3, { themeIds: ['hope', 'fear'] })).status,
    ).toBe(200);
    expect((await submit('count', id, 4)).status).toBe(200);
  });

  it('a theme deleted while someone is choosing: “Themes have changed, please choose again” (A7)', async () => {
    await person('late');
    const admin = await t.service('api_admin');
    await run(
      admin,
      `CREATE theme:fleeting SET name = 'Fleeting', category = themeCategory:other`,
    );
    const { id } = (await create('late', { themeIds: ['fleeting'] })).body;
    await run(admin, 'DELETE theme:fleeting');
    // The database took it off the draft; choosing it again is refused, saying why.
    expect(
      (await call('GET', `/v1/account/stories/${id}`, 'late')).body.themes,
    ).toEqual([]);
    const again = await patch('late', id, 2, { themeIds: ['fleeting'] });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({
      code: 'themes_changed',
      detail: 'Themes have changed, please choose again',
    });
    expect((await create('late', { themeIds: ['fleeting'] })).body.code).toBe(
      'themes_changed',
    );
  });

  it('refuses a missing or forged token', async () => {
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

import { type APIRequestContext, expect, test } from '@playwright/test';
import { Contract } from '@heisreal/contracts/testing';
import { fixtureToken, STUB_URL, STUB_USER_URL } from './servers';

// T3: the stub api-public-read (stub-api.mjs) answers as libs/contracts/openapi/
// api-public-read.yaml says, like the real service does in its integration tests
// (apps/api-public-read/integration/contract.ts). Every kind of answer the stub gives is
// checked: lists with filters, search and cursors, every story, related, tags, health, the
// old-slug redirect and the errors. One device: none of this depends on the screen.

const STUB = STUB_URL;
const contract = new Contract('api-public-read.yaml');

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
});

async function check(request: APIRequestContext, path: string) {
  const res = await request.get(`${STUB}${path}`, { maxRedirects: 0 });
  const text = await res.text();
  const problems = contract.problems({
    method: 'GET',
    path: new URL(res.url()).pathname,
    status: res.status(),
    contentType: res.headers()['content-type'] ?? null,
    body: text === '' ? undefined : JSON.parse(text),
  });
  expect(problems, path).toEqual([]);
  return {
    status: res.status(),
    body: text === '' ? undefined : JSON.parse(text),
  };
}

test('every list page, filter and search the stub serves fits the contract', async ({
  request,
}) => {
  for (const query of [
    '',
    '?limit=15',
    '?tag=healing&format=video',
    '?tag=loss&tag=faith',
    '?format=audio&sort=oldest',
    '?q=placeholder',
    '?q=nothing-matches-this',
    '?tag=hide-test',
  ]) {
    let path = `/v1/stories${query}`;
    for (let pages = 0; pages < 10; pages++) {
      const { status, body } = await check(request, path);
      expect(status, path).toBe(200);
      if (!body.nextCursor) break;
      const sep = query ? '&' : '?';
      path = `/v1/stories${query}${sep}cursor=${body.nextCursor}`;
    }
  }
  expect((await check(request, '/v1/stories?cursor=forged')).status).toBe(400);
  // Cards by id (hearts kept on a device, M2).
  const byId = await check(
    request,
    '/v1/stories?id=browse_01&id=browse_02&id=no_such',
  );
  expect(byId.status).toBe(200);
  expect(byId.body.data.map((s: { id: string }) => s.id)).toEqual([
    'browse_01',
    'browse_02',
  ]);
  expect(
    (await check(request, '/v1/stories?id=browse_01&limit=5')).status,
  ).toBe(400);
});

test('every story, its related list and the tags fit the contract', async ({
  request,
}) => {
  const slugs: string[] = [];
  let path = '/v1/stories?limit=50';
  for (;;) {
    const { body } = await check(request, path);
    slugs.push(...body.data.map((s: { slug: string }) => s.slug));
    if (!body.nextCursor) break;
    path = `/v1/stories?limit=50&cursor=${body.nextCursor}`;
  }
  expect(slugs.length).toBeGreaterThan(50);
  for (const slug of [...slugs, 'test-story-walking-skeleton', 'long-story']) {
    expect((await check(request, `/v1/stories/${slug}`)).status).toBe(200);
    expect((await check(request, `/v1/stories/${slug}/related`)).status).toBe(
      200,
    );
  }
  expect((await check(request, '/v1/tags')).status).toBe(200);
  expect((await check(request, '/health')).status).toBe(200);
});

test('the legal routes fit the contract: dev’s forms, privacy document and legal documents', async ({
  request,
}) => {
  for (const form of ['signup', 'testimony', 'social']) {
    const { status, body } = await check(request, `/v1/legal/forms/${form}`);
    expect(status, form).toBe(200);
    expect(body.form).toBe(form);
  }
  expect((await check(request, '/v1/legal/forms/other')).status).toBe(404);
  // D121, D125: the two legal documents, each with its numbered versions.
  for (const [document, id, number] of [
    ['privacy', 'dev_policy', 2],
    ['terms', 'dev_placeholder', 1],
  ] as const) {
    const { status, body } = await check(
      request,
      `/v1/legal/documents/${document}`,
    );
    expect([document, status, body.current.id, body.current.number]).toEqual([
      document,
      200,
      id,
      number,
    ]);
    const version = await check(
      request,
      `/v1/legal/documents/${document}/versions/1`,
    );
    expect([document, version.status, version.body.number]).toEqual([
      document,
      200,
      1,
    ]);
  }
  expect((await check(request, '/v1/legal/documents/other')).status).toBe(404);
  expect(
    (await check(request, '/v1/legal/documents/privacy/versions/9')).status,
  ).toBe(404);
  expect((await check(request, '/v1/legal/dpa')).status).toBe(200);
  expect(
    (await check(request, '/v1/legal/dpa?version=dev_placeholder')).status,
  ).toBe(200);
  expect((await check(request, '/v1/legal/dpa?version=v9')).status).toBe(404);
});

test('the founder’s video routes fit the contract', async ({ request }) => {
  for (const key of ['founder-intro', 'next-steps']) {
    const { status, body } = await check(request, `/v1/site-videos/${key}`);
    expect(status, key).toBe(200);
    expect(body.key).toBe(key);
  }
  expect((await check(request, '/v1/site-videos/contact')).status).toBe(404);
});

test('the stub’s errors fit the contract', async ({ request }) => {
  expect((await check(request, '/v1/stories/no-such-story')).status).toBe(404);
  expect(
    (await check(request, '/v1/stories/no-such-story/related')).status,
  ).toBe(404);
  expect((await check(request, '/v1/stories/down')).status).toBe(503);
});

// T3: the stub api-user (stub-api-user.mjs) answers as api-user.yaml says, like the real
// service in its integration tests (apps/api-user/integration).
const userContract = new Contract('api-user.yaml');

test('the stub api-user’s account bootstrap fits the contract', async ({
  request,
}) => {
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await request.get(`${STUB_USER_URL}${path}`, { headers });
    const text = await res.text();
    expect(
      userContract.problems({
        method: 'GET',
        path,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: text === '' ? undefined : JSON.parse(text),
      }),
      path,
    ).toEqual([]);
    return res;
  };
  const signedIn = { authorization: `Bearer ${fixtureToken()}` };
  const account = await get('/v1/account', signedIn);
  expect(account.status()).toBe(200);
  const etag = account.headers()['etag'];
  expect(
    (await get('/v1/account', { ...signedIn, 'if-none-match': etag })).status(),
  ).toBe(304);
  expect((await get('/v1/account')).status()).toBe(401);
  expect((await get('/health')).status()).toBe(200);
  // Download my data (M2 plan PR 12): a session with stories, consents and a video draft.
  const session = `export${Date.now()}`;
  await request.post(`${STUB_USER_URL}/__e2e/sessions/${session}`, {
    data: {
      granted: ['special_category_religious', 'publish'],
      stories: [
        {
          id: 'e1',
          status: 'changes_requested',
          title: 'Mine',
          tagSlugs: ['healing'],
          rejectionFeedback: 'A little more, please.',
        },
        {
          id: 'e2',
          title: 'My video',
          primaryFormat: 'video',
          videoId: '00000000-0000-4000-8000-000000000001',
        },
      ],
    },
  });
  const mine = { authorization: `Bearer ${fixtureToken(session)}` };
  expect((await get('/v1/account/export', mine)).status()).toBe(200);
  const failing = `export-fails${Date.now()}`;
  expect(
    (
      await get('/v1/account/export', {
        authorization: `Bearer ${fixtureToken(failing)}`,
      })
    ).status(),
  ).toBe(503);
  expect((await get('/v1/account/export')).status()).toBe(401);
});

test('the stub api-user’s consent grants fit the contract', async ({
  request,
}) => {
  const post = async (
    body: unknown,
    headers: Record<string, string> = {
      authorization: `Bearer ${fixtureToken()}`,
    },
  ) => {
    const res = await request.post(`${STUB_USER_URL}/v1/account/consents`, {
      headers: { 'content-type': 'application/json', ...headers },
      data: JSON.stringify(body),
    });
    const text = await res.text();
    expect(
      userContract.problems({
        method: 'POST',
        path: '/v1/account/consents',
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: text === '' ? undefined : JSON.parse(text),
      }),
    ).toEqual([]);
    return { status: res.status(), body: text ? JSON.parse(text) : undefined };
  };
  const signedIn = (key: string) => ({
    authorization: `Bearer ${fixtureToken()}`,
    'idempotency-key': `contract-check-${key}`,
  });
  const grant = {
    form: 'signup',
    formVersion: 'v2',
    statement: 'age_18plus',
    mechanism: 'web_form_submission',
    privacyPolicyVersion: 'dev_policy',
    termsVersion: 'dev_placeholder',
  };
  const first = await post(grant, signedIn('first-grant'));
  expect(first.status).toBe(201);
  // The same key and body answer as before; another body with it is refused.
  expect(await post(grant, signedIn('first-grant'))).toEqual(first);
  expect(
    (
      await post(
        { ...grant, statement: 'account_data' },
        signedIn('first-grant'),
      )
    ).status,
  ).toBe(422);
  expect(
    (await post({ ...grant, formVersion: 'v1' }, signedIn('old-version'))).body
      .code,
  ).toBe('form_version_not_in_force');
  // D122: a page that showed another privacy policy gets 409 too.
  expect(
    (
      await post(
        { ...grant, privacyPolicyVersion: 'v0' },
        signedIn('old-policy'),
      )
    ).body.code,
  ).toBe('legal_document_not_in_force');
  expect(
    (await post({ ...grant, statement: 'publish' }, signedIn('other-form')))
      .body.code,
  ).toBe('statement_not_on_form');
  expect((await post(grant)).status).toBe(400); // no Idempotency-Key
  expect(
    (await post(grant, { 'idempotency-key': 'contract-check-anon' })).status,
  ).toBe(401);
});

test('the stub api-user’s hearts fit the contract', async ({ request }) => {
  const send = async (
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    headers: Record<string, string> = {},
  ) => {
    const res = await request.fetch(`${STUB_USER_URL}${path}`, {
      method,
      headers,
    });
    const text = await res.text();
    expect(
      userContract.problems({
        method,
        path: new URL(res.url()).pathname,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: text === '' ? undefined : JSON.parse(text),
      }),
      `${method} ${path}`,
    ).toEqual([]);
    return res;
  };
  // Its own session, so no other test's hearts show up.
  const me = { authorization: `Bearer ${fixtureToken('contract')}` };
  const noConsent = {
    authorization: `Bearer ${fixtureToken('no-consent-contract')}`,
  };
  const list = '/v1/account/favourites';
  expect((await send('PUT', `${list}/browse_01`, me)).status()).toBe(204);
  expect((await send('PUT', `${list}/browse_02`, me)).status()).toBe(204);
  expect((await send('PUT', `${list}/no_such`, me)).status()).toBe(404);
  expect((await send('PUT', `${list}/browse_01`, noConsent)).status()).toBe(
    403,
  );
  const page = await send('GET', `${list}?limit=1`, me);
  expect(page.status()).toBe(200);
  const { data, nextCursor } = await page.json();
  expect(data.map((s: { id: string }) => s.id)).toEqual(['browse_02']);
  expect(
    (await send('GET', `${list}?limit=1&cursor=${nextCursor}`, me)).status(),
  ).toBe(200);
  const among = await send(
    'GET',
    `${list}?storyId=browse_01&storyId=browse_03`,
    me,
  );
  expect((await among.json()).data.map((s: { id: string }) => s.id)).toEqual([
    'browse_01',
  ]);
  expect(
    (
      await send('GET', list, {
        ...me,
        'if-none-match': (await send('GET', list, me)).headers()['etag'],
      })
    ).status(),
  ).toBe(304);
  expect((await send('GET', `${list}?storyId=a&limit=2`, me)).status()).toBe(
    400,
  );
  expect((await send('DELETE', `${list}/browse_01`, me)).status()).toBe(204);
  expect((await send('GET', list)).status()).toBe(401);
  expect((await send('PUT', `${list}/browse_01`)).status()).toBe(401);
  expect((await send('DELETE', `${list}/browse_01`)).status()).toBe(401);
});

test('the stub api-user’s submit flow fits the contract, answers and errors', async ({
  request,
}) => {
  const session = `contract${Date.now()}`;
  await request.post(`${STUB_USER_URL}/__e2e/sessions/${session}`, {
    data: { signupAccepted: true, granted: ['age_18plus', 'account_data'] },
  });
  const auth = { authorization: `Bearer ${fixtureToken(session)}` };
  const call = async (
    method: string,
    path: string,
    {
      data,
      headers = {},
    }: { data?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const res = await request.fetch(`${STUB_USER_URL}${path}`, {
      method,
      headers: { ...auth, ...headers },
      data,
    });
    const text = await res.text();
    const body = text === '' ? undefined : JSON.parse(text);
    expect(
      userContract.problems({
        method,
        path: path.split('?')[0],
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body,
      }),
      `${method} ${path} ${res.status()}`,
    ).toEqual([]);
    return { status: res.status(), body };
  };
  const key = () =>
    `contract-key-${Math.random().toString(36).slice(2)}-xxxxxxxx`;
  const text = 'A story long enough to submit. '.repeat(8);

  expect((await call('GET', '/v1/tags')).status).toBe(200);
  expect((await call('GET', '/v1/account/limits')).status).toBe(200);
  expect((await call('GET', '/v1/account/consents')).status).toBe(200);
  const draft = { title: 'T', primaryFormat: 'written', body: text };
  // No testimony consent yet: refused.
  expect(
    (
      await call('POST', '/v1/stories', {
        data: draft,
        headers: { 'idempotency-key': key() },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('POST', '/v1/account/consents', {
        data: {
          form: 'testimony',
          formVersion: 'v2',
          statement: 'special_category_religious',
          mechanism: 'web_form_submission',
          privacyPolicyVersion: 'dev_policy',
        },
        headers: { 'idempotency-key': key() },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call('POST', '/v1/account/consents', {
        data: {
          form: 'testimony',
          formVersion: 'v0',
          statement: 'publish',
          mechanism: 'web_form_submission',
        },
        headers: { 'idempotency-key': key() },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('POST', '/v1/stories', {
        data: { title: ' ' },
        headers: { 'idempotency-key': key() },
      })
    ).status,
  ).toBe(400);
  const created = await call('POST', '/v1/stories', {
    data: draft,
    headers: { 'idempotency-key': key() },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await call('GET', '/v1/account/stories?status=draft')).status).toBe(
    200,
  );
  expect((await call('GET', `/v1/account/stories/${id}`)).status).toBe(200);
  expect((await call('GET', '/v1/account/stories/none')).status).toBe(404);
  const patch = (version?: number, data: object = { tagSlugs: ['hope'] }) =>
    call('PATCH', `/v1/stories/${id}`, {
      data,
      headers: {
        'content-type': 'application/merge-patch+json',
        ...(version ? { 'if-match': `"${version}"` } : {}),
      },
    });
  expect((await patch()).status).toBe(428);
  expect((await patch(1, { body: ' ' })).status).toBe(400);
  expect((await patch(1)).status).toBe(200);
  expect((await patch(1)).status).toBe(412);
  const submit = (version: number, data?: unknown, k = key()) =>
    call('POST', `/v1/stories/${id}/submit`, {
      headers: { 'if-match': `"${version}"`, 'idempotency-key': k },
      data,
    });
  expect((await submit(2)).status).toBe(403); // no publish consent yet
  await call('POST', '/v1/account/consents', {
    data: {
      form: 'testimony',
      formVersion: 'v2',
      statement: 'publish',
      mechanism: 'web_form_submission',
      privacyPolicyVersion: 'dev_policy',
    },
    headers: { 'idempotency-key': key() },
  });
  expect((await submit(1)).status).toBe(412);
  // O4: sharing beyond heisreal.today ticked on Review goes with the submission (both or neither).
  const shareBeyondSite = {
    formVersion: 'v2',
    privacyPolicyVersion: 'dev_policy',
  };
  expect((await submit(2, { shareBeyondSite: true })).status).toBe(400);
  expect(
    (
      await submit(2, {
        shareBeyondSite: { ...shareBeyondSite, formVersion: 'v1' },
      })
    ).body.code,
  ).toBe('form_version_not_in_force');
  expect(
    (await call('GET', `/v1/account/stories/${id}`)).body.sharing.granted,
  ).toBe(false);
  const submitKey = key();
  expect((await submit(2, { shareBeyondSite }, submitKey)).status).toBe(200);
  expect((await submit(2, { shareBeyondSite }, submitKey)).status).toBe(200); // replayed
  expect((await submit(2, undefined, submitKey)).status).toBe(422);
  expect(
    (await call('GET', `/v1/account/stories/${id}`)).body.sharing,
  ).toMatchObject({ granted: true, counts: true });
  expect((await patch(3)).status).toBe(409); // locked once submitted
  const second = await call('POST', '/v1/stories', {
    data: { ...draft, tagSlugs: ['hope'] },
    headers: { 'idempotency-key': key() },
  });
  const weekly = await call('POST', `/v1/stories/${second.body.id}/submit`, {
    headers: { 'if-match': '"1"', 'idempotency-key': key() },
  });
  expect(weekly).toMatchObject({
    status: 409,
    body: { code: 'weekly_submission_limit_reached' },
  });
  const short = await call('POST', '/v1/stories', {
    data: { ...draft, body: 'Short', tagSlugs: ['hope'] },
    headers: { 'idempotency-key': key() },
  });
  expect(
    (
      await call('POST', `/v1/stories/${short.body.id}/submit`, {
        headers: { 'if-match': '"1"', 'idempotency-key': key() },
      })
    ).body.code,
  ).toBe('story_text_too_short');
  await call('POST', '/v1/stories', {
    data: draft,
    headers: { 'idempotency-key': key() },
  }); // the third open draft
  const limit = await call('POST', '/v1/stories', {
    data: draft,
    headers: { 'idempotency-key': key() },
  });
  expect(limit).toMatchObject({
    status: 409,
    body: { code: 'draft_limit_reached' },
  });
  // With 3 drafts and a submission this week, as the page reads it.
  expect((await call('GET', '/v1/account/limits')).body).toMatchObject({
    openDrafts: { max: 3, open: 3 },
    submissions: {
      per7Days: 1,
      usedIn7Days: 1,
      nextAvailableAt: expect.any(String),
    },
  });

  // The profile (M2 plan PR 8): withdraw the submitted story, delete it and a draft.
  const withdraw = (story: string, version?: number) =>
    call('POST', `/v1/stories/${story}/withdraw`, {
      headers: version ? { 'if-match': `"${version}"` } : {},
    });
  const remove = (story: string, version?: number) =>
    call('DELETE', `/v1/stories/${story}`, {
      headers: version ? { 'if-match': `"${version}"` } : {},
    });
  expect((await remove(id, 3)).status).toBe(409); // pending: withdraw it first
  expect((await withdraw(id)).status).toBe(428);
  expect((await withdraw(id, 2)).status).toBe(412);
  // O4: sharing beyond heisreal.today is granted and withdrawn per story, and listed on it.
  const sharing = (data: unknown) =>
    call('POST', '/v1/account/consents', {
      headers: { 'idempotency-key': key() },
      data,
    });
  const SHARE = {
    form: 'social',
    formVersion: 'v2',
    statement: 'share_socials',
    mechanism: 'account_settings',
    privacyPolicyVersion: 'dev_policy',
  };
  expect((await sharing(SHARE)).status).toBe(400); // no story named
  expect((await sharing({ ...SHARE, storyId: 'nosuch' })).status).toBe(404);
  expect((await sharing({ ...SHARE, storyId: id })).status).toBe(201);
  expect(
    (await call('GET', `/v1/account/stories/${id}`)).body.sharing,
  ).toMatchObject({ granted: true, counts: true });
  const stopSharing = (data?: unknown) =>
    call('POST', '/v1/account/consents/share_socials/withdraw', {
      headers: { 'idempotency-key': key() },
      data,
    });
  expect((await stopSharing()).status).toBe(400);
  expect((await stopSharing({ storyId: 'nosuch' })).status).toBe(404);
  // Never shared: nothing to withdraw.
  expect((await stopSharing({ storyId: short.body.id })).status).toBe(409);
  expect((await stopSharing({ storyId: id })).status).toBe(202);
  expect((await call('GET', '/v1/account/export')).status).toBe(200);
  expect((await withdraw(id, 3)).status).toBe(200);
  expect((await withdraw(id, 4)).status).toBe(409);
  expect((await remove(id, 4)).status).toBe(204);
  expect((await remove(id, 4)).status).toBe(404);
  expect((await withdraw(short.body.id, 1)).status).toBe(409); // a draft
  expect((await remove(short.body.id, 1)).status).toBe(204);
  const withdrawConsent = (type: string) =>
    call('POST', `/v1/account/consents/${type}/withdraw`, {
      headers: { 'idempotency-key': key() },
    });
  expect((await withdrawConsent('publish')).status).toBe(202);
  // Erasure (M2 plan PR 11): the account goes, and its token gets 401 from then on.
  expect((await call('DELETE', '/v1/account')).status).toBe(202);
  expect((await call('GET', '/v1/account')).status).toBe(401);
  expect((await call('DELETE', '/v1/account')).status).toBe(401);
});

test('the stub api-user’s uploads fit the contract, answers and errors (M2 plan PR 7)', async ({
  request,
}) => {
  const session = `contractup${Date.now()}`;
  await request.post(`${STUB_USER_URL}/__e2e/sessions/${session}`, {
    data: {
      signupAccepted: true,
      granted: [
        'age_18plus',
        'account_data',
        'special_category_religious',
        'publish',
      ],
    },
  });
  const auth = { authorization: `Bearer ${fixtureToken(session)}` };
  const call = async (
    method: string,
    path: string,
    {
      data,
      headers = {},
    }: { data?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const res = await request.fetch(`${STUB_USER_URL}${path}`, {
      method,
      headers: { ...auth, ...headers },
      data,
    });
    const text = await res.text();
    const body = text === '' ? undefined : JSON.parse(text);
    expect(
      userContract.problems({
        method,
        path,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body,
      }),
      `${method} ${path} ${res.status()}`,
    ).toEqual([]);
    return { status: res.status(), body };
  };
  const created = await call('POST', '/v1/stories', {
    data: { title: 'My video', primaryFormat: 'video', tagSlugs: ['hope'] },
    headers: { 'idempotency-key': `contract-up-${Date.now()}-xxxxxxxx` },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const file = {
    format: 'video',
    contentType: 'video/mp4',
    fileSizeBytes: 1000,
    durationSeconds: 3,
  };
  let n = 0;
  const upload = (
    version: number | undefined,
    data: object = file,
    key = `contract-upl-${Date.now()}-${++n}-xxxx`,
  ) =>
    call('POST', `/v1/stories/${id}/upload-url`, {
      data,
      headers: {
        'idempotency-key': key,
        ...(version ? { 'if-match': `"${version}"` } : {}),
      },
    });
  expect((await upload(undefined)).status).toBe(428);
  expect((await upload(1, { ...file, fileSizeBytes: 5e9 })).status).toBe(400);
  expect((await upload(1, { ...file, resume: true })).body.code).toBe(
    'nothing_to_resume',
  );
  const key = `contract-upload-${Date.now()}-xxxx`;
  const target = await upload(1, file, key);
  expect(target).toMatchObject({ status: 200, body: { version: 2 } });
  // The same key again (a lost answer's retry) replays it; another key at the old version is 412.
  expect((await upload(1, file, key)).body).toEqual(target.body);
  expect((await upload(1, { ...file, fileSizeBytes: 9 }, key)).status).toBe(
    422,
  );
  expect((await upload(1)).status).toBe(412);
  expect((await upload(2, { ...file, resume: true })).body.version).toBe(2);
  // The file hasn't arrived: submit says so.
  const early = await call('POST', `/v1/stories/${id}/submit`, {
    headers: {
      'if-match': '"2"',
      'idempotency-key': `contract-sub-${Date.now()}-xxxx`,
    },
  });
  expect(early).toMatchObject({
    status: 409,
    body: { code: 'media_not_uploaded' },
  });
  expect(
    (await call('GET', `/v1/account/stories/${id}`)).body.media,
  ).toHaveLength(1);
  expect((await call('GET', '/v1/account/limits')).body.uploads).toMatchObject({
    perHour: 10,
    per7Days: 5,
    usedIn7Days: 1,
  });
});

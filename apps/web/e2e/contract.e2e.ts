import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { Contract } from '@heisreal/contracts/testing';
import { fixtureToken, STUB_URL, STUB_USER_URL } from './servers';

// T3: the stub api-public-read (stub-api.mjs) answers as libs/contracts/openapi/
// api-public-read.yaml says, like the real service does in its integration tests
// (apps/api-public-read/integration/contract.ts). Every kind of answer the stub gives is
// checked: lists with filters, search and cursors, every story, related, health, the
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
    '?theme=healing&format=video',
    '?theme=no_such_theme',
    '?format=audio&sort=oldest',
    '?q=placeholder',
    '?q=nothing-matches-this',
    '?theme=hide_test',
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

test('every story and its related list fit the contract', async ({
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
  expect((await check(request, '/health')).status).toBe(200);
});

test('the founder’s video routes fit the contract', async ({ request }) => {
  for (const key of ['founder-intro', 'next-steps']) {
    const { status, body } = await check(request, `/v1/site-videos/${key}`);
    expect(status, key).toBe(200);
    expect(body.key).toBe(key);
  }
  expect((await check(request, '/v1/site-videos/contact')).status).toBe(404);
});

test('the four legal texts and their versions fit the contract (plan 4e)', async ({
  request,
}) => {
  for (const document of [
    'terms-of-use',
    'testimony-consent',
    'social-media-sharing-consent',
    'privacy-notice',
  ]) {
    const { status, body } = await check(
      request,
      `/v1/legal/documents/${document}`,
    );
    expect(status, document).toBe(200);
    expect(body.versions.at(-1).version, document).toBe(0);
    for (const { version } of body.versions) {
      const one = await check(
        request,
        `/v1/legal/documents/${document}/versions/${version}`,
      );
      expect(one.status).toBe(200);
      expect(one.body.latest).toBe(version === body.latest.version);
    }
    expect(
      (await check(request, `/v1/legal/documents/${document}/versions/99`))
        .status,
    ).toBe(404);
  }
  expect((await check(request, '/v1/legal/documents/no-such')).status).toBe(
    404,
  );
});

test('the stub’s errors fit the contract', async ({ request }) => {
  expect((await check(request, '/v1/themes')).status).toBe(200);
  expect((await check(request, '/v1/stories/no-such-story')).status).toBe(404);
  expect(
    (await check(request, '/v1/stories/no-such-story/related')).status,
  ).toBe(404);
  expect((await check(request, '/v1/stories/restarting')).status).toBe(503);
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
  // Download my data (M2 plan PR 12): a session with stories, agreements and a video draft.
  const session = `export-${randomUUID()}`;
  await request.post(`${STUB_USER_URL}/__e2e/sessions/${session}`, {
    data: {
      testimony: 3,
      stories: [
        {
          id: 'e1',
          status: 'changes_requested',
          title: 'Mine',
          themeIds: ['healing'],
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
  const failing = `export-fails-${randomUUID()}`;
  expect(
    (
      await get('/v1/account/export', {
        authorization: `Bearer ${fixtureToken(failing)}`,
      })
    ).status(),
  ).toBe(503);
  expect((await get('/v1/account/export')).status()).toBe(401);
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
  // Its own session, so no other test's (or repeat's) hearts show up.
  const me = {
    authorization: `Bearer ${fixtureToken(`contract-${randomUUID()}`)}`,
  };
  // Plan 4e: a person on older terms can't add a heart until they agree to the latest.
  const older = `older-terms-contract-${randomUUID()}`;
  await request.post(`${STUB_USER_URL}/__e2e/sessions/${older}`, {
    data: { terms: 0 },
  });
  const noConsent = { authorization: `Bearer ${fixtureToken(older)}` };
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

/**
 * Calls the stub api-user as a new person of its own (a UUID session, so no other test or repeat
 * shares it) and checks every answer against api-user.yaml.
 */
async function userCaller(request: APIRequestContext, seed: object) {
  const session = `contract-${randomUUID()}`;
  await request.post(`${STUB_USER_URL}/__e2e/sessions/${session}`, {
    data: seed,
  });
  const auth = { authorization: `Bearer ${fixtureToken(session)}` };
  return async (
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
}
const key = () => `contract-${randomUUID()}`;

// One check per answer the share flow and the profile read. The rules behind them (limits,
// versions, locking) are the real api-user's, checked in its integration tests.
test('the stub api-user’s submit flow answers fit the contract', async ({
  request,
}) => {
  const call = await userCaller(request, { terms: 0 });
  const draft = {
    title: 'T',
    primaryFormat: 'written',
    body: 'A story long enough to submit. '.repeat(8),
    themeIds: ['hope'],
  };
  const create = (data: object = draft) =>
    call('POST', '/v1/stories', {
      data,
      headers: { 'idempotency-key': key() },
    });
  const agree = (agreement: string, version: number) =>
    call('POST', `/v1/account/agreements/${agreement}`, {
      data: { version },
    });

  expect((await call('GET', '/v1/account/limits')).status).toBe(200);
  expect((await call('GET', '/v1/themes')).status).toBe(200);
  // A refusal with a code (the agree-again screen reads it), then the agreements.
  expect((await create()).status).toBe(403);
  expect((await agree('terms-of-use', 2)).status).toBe(200);
  expect((await agree('testimony-consent', 3)).status).toBe(200);
  // A refusal with field errors (the form reads their pointers).
  expect((await create({ title: ' ' })).status).toBe(400);
  const created = await create();
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await call('GET', '/v1/account/stories?status=draft')).status).toBe(
    200,
  );
  expect((await call('GET', `/v1/account/stories/${id}`)).status).toBe(200);
  const patched = await call('PATCH', `/v1/stories/${id}`, {
    data: { description: 'About it' },
    headers: {
      'content-type': 'application/merge-patch+json',
      'if-match': '"1"',
    },
  });
  expect(patched.status).toBe(200);
  const submitted = await call('POST', `/v1/stories/${id}/submit`, {
    data: { socialMediaSharingConsent: { version: 1 } },
    headers: {
      'if-match': `"${patched.body.version}"`,
      'idempotency-key': key(),
    },
  });
  expect(submitted.status).toBe(200);
  const withdrawn = await call('POST', `/v1/stories/${id}/withdraw`, {
    headers: { 'if-match': `"${submitted.body.version}"` },
  });
  expect(withdrawn.status).toBe(200);
  expect(
    (
      await call('DELETE', `/v1/stories/${id}`, {
        headers: { 'if-match': `"${withdrawn.body.version}"` },
      })
    ).status,
  ).toBe(204);
  expect((await call('DELETE', '/v1/account')).status).toBe(202);
});

test('the stub api-user’s upload answers fit the contract (M2 plan PR 7)', async ({
  request,
}) => {
  const call = await userCaller(request, { testimony: 3 });
  const created = await call('POST', '/v1/stories', {
    data: { title: 'My video', primaryFormat: 'video', themeIds: ['hope'] },
    headers: { 'idempotency-key': key() },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const file = {
    format: 'video',
    contentType: 'video/mp4',
    fileSizeBytes: 1000,
    durationSeconds: 3,
  };
  const upload = (data: object) =>
    call('POST', `/v1/stories/${id}/upload-url`, {
      data,
      headers: { 'idempotency-key': key(), 'if-match': '"1"' },
    });
  expect((await upload({ ...file, resume: true })).status).toBe(409);
  const target = await upload(file);
  expect(target.status).toBe(200);
  // Submitting before the file has arrived: a refusal the upload step reads.
  const early = await call('POST', `/v1/stories/${id}/submit`, {
    headers: {
      'if-match': `"${target.body.version}"`,
      'idempotency-key': key(),
    },
  });
  expect(early.status).toBe(409);
  expect((await call('GET', `/v1/account/stories/${id}`)).status).toBe(200);
  expect((await call('GET', '/v1/account/limits')).status).toBe(200);
});

// Plan 4e: the stub api-admin's legal texts (/admin/consent) answer as api-admin.yaml says.
const adminContract = new Contract('api-admin.yaml');

test('the stub api-admin’s legal texts fit the contract', async ({
  request,
}) => {
  const admin = {
    authorization: `Bearer ${fixtureToken(`admin-contract${Date.now()}`)}`,
  };
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    { data, headers = admin }: { data?: unknown; headers?: object } = {},
  ) => {
    const res = await request.fetch(`${STUB_USER_URL}${path}`, {
      method,
      headers: headers as Record<string, string>,
      data,
    });
    const text = await res.text();
    const body = text === '' ? undefined : JSON.parse(text);
    expect(
      adminContract.problems({
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
  const path = '/v1/admin/legal-documents/privacy-notice/versions';
  const list = await call('GET', path);
  expect(list.status).toBe(200);
  const next = list.body.latest.version + 1;
  const content = `${list.body.latest.content}\n\nOne more line.`;
  expect((await call('POST', path, { data: { version: next } })).status).toBe(
    400,
  );
  expect(
    (await call('POST', path, { data: { version: next, content } })).status,
  ).toBe(201);
  // The same number again, as a second admin would send it: nothing is written.
  expect(
    (await call('POST', path, { data: { version: next, content } })).body.code,
  ).toBe('document_changed');
  expect((await call('GET', path)).body.latest.version).toBe(next);
  expect(
    (await call('GET', '/v1/admin/legal-documents/no-such/versions')).status,
  ).toBe(404);
  expect(
    (
      await call('GET', path, {
        headers: { authorization: `Bearer ${fixtureToken('contract')}` },
      })
    ).status,
  ).toBe(403);
  expect((await call('GET', path, { headers: {} })).status).toBe(401);
});

// M3 plan PR 4: the stub api-admin's staff list (/admin/staff) answers as api-admin.yaml says.
test('the stub api-admin’s staff list fits the contract', async ({
  request,
}) => {
  const admin = {
    authorization: `Bearer ${fixtureToken(`admin-contract${Date.now()}`)}`,
  };
  const call = async (
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    { data, headers = admin }: { data?: unknown; headers?: object } = {},
  ) => {
    const res = await request.fetch(`${STUB_USER_URL}${path}`, {
      method,
      headers: headers as Record<string, string>,
      data,
    });
    const text = await res.text();
    const body = text === '' ? undefined : JSON.parse(text);
    expect(
      adminContract.problems({
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
  expect((await call('GET', '/v1/admin/staff')).status).toBe(200);
  const ann = '/v1/admin/staff/ann%40heisreal.today';
  expect((await call('PUT', ann, { data: { role: 'Moderator' } })).status).toBe(
    200,
  );
  expect((await call('PUT', ann, { data: { role: 'User' } })).status).toBe(400);
  expect(
    (
      await call('PUT', '/v1/admin/staff/ann%40example.com', {
        data: { role: 'Admin' },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call('PUT', '/v1/admin/staff/nobody%40heisreal.today', {
        data: { role: 'Moderator' },
      })
    ).status,
  ).toBe(400);
  expect((await call('DELETE', ann)).status).toBe(204);
  expect(
    (await call('DELETE', '/v1/admin/staff/info%40heisreal.today')).status,
  ).toBe(204);
  expect(
    (await call('DELETE', '/v1/admin/staff/joel%40heisreal.today')).body.code,
  ).toBe('last_admin');
  expect(
    (
      await call('GET', '/v1/admin/staff', {
        headers: { authorization: `Bearer ${fixtureToken('contract')}` },
      })
    ).status,
  ).toBe(403);
});

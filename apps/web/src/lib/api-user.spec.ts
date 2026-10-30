/**
 * @jest-environment node
 */
import {
  ApiUserProblem,
  ApiUserUnavailable,
  apiUser,
  NotSignedIn,
  StaleVersion,
} from './api-user';

// The client's error handling has no page that reaches it yet (no commands until M2's later
// PRs), so it is pinned here; the bootstrap's happy path and outages are in the e2e suite.
const BASE = 'https://api-user.example';
const sent: { url: string; init: RequestInit }[] = [];
const answer = (status: number, body?: unknown, type = 'application/json') =>
  jest.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': type, ETag: 'W/"1"' },
    });
  });
const token = async () => 'tok';
// Node's fetch, Headers and Response (jsdom lacks them), and the client's browser-only check.
(globalThis as { window?: unknown }).window = globalThis;

beforeEach(() => {
  sent.length = 0;
});

it('sends a fresh token, If-Match and the Idempotency-Key, and no cookies', async () => {
  global.fetch = answer(200, { id: 's1', version: 3 }) as typeof fetch;
  const api = apiUser(`${BASE}/`, token);
  const res = await api.command('/v1/stories/s1/submit', {
    method: 'POST',
    version: 2,
    idempotencyKey: 'k'.repeat(20),
    body: {},
  });
  expect(res).toMatchObject({ status: 200, data: { id: 's1', version: 3 } });
  const [{ url, init }] = sent;
  expect(url).toBe(`${BASE}/v1/stories/s1/submit`);
  const headers = init.headers as Headers;
  expect(headers.get('Authorization')).toBe('Bearer tok');
  expect(headers.get('If-Match')).toBe('"2"');
  expect(headers.get('Idempotency-Key')).toBe('k'.repeat(20));
  expect(init.credentials).toBe('omit');
});

it('surfaces 412 as StaleVersion and other errors as their problem', async () => {
  global.fetch = answer(
    412,
    { type: 'about:blank', title: 'Precondition failed', status: 412 },
    'application/problem+json',
  ) as typeof fetch;
  const stale = await apiUser(BASE, token)
    .command('/v1/stories/s1', { method: 'PATCH', version: 1, body: {} })
    .catch((e) => e);
  expect(stale).toBeInstanceOf(StaleVersion);

  global.fetch = answer(
    403,
    {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'consent_required',
    },
    'application/problem+json',
  ) as typeof fetch;
  const refused = await apiUser(BASE, token)
    .get('/v1/account/stories')
    .catch((e) => e);
  expect(refused).toBeInstanceOf(ApiUserProblem);
  expect(refused).not.toBeInstanceOf(StaleVersion);
  expect([refused.status, refused.code]).toEqual([403, 'consent_required']);

  // Not a problem body (e.g. a proxy's page): a bare problem with the status.
  global.fetch = answer(502, '<html>', 'text/html') as typeof fetch;
  const bare = await apiUser(BASE, token)
    .get('/v1/account')
    .catch((e) => e);
  expect([bare.status, bare.code]).toEqual([502, undefined]);
});

it('sends nothing when signed out, and reports an unreachable api-user', async () => {
  global.fetch = answer(200, {}) as typeof fetch;
  await expect(
    apiUser(BASE, async () => null).get('/v1/account'),
  ).rejects.toBeInstanceOf(NotSignedIn);
  expect(sent).toHaveLength(0);

  global.fetch = jest.fn(async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await expect(apiUser(BASE, token).get('/v1/account')).rejects.toBeInstanceOf(
    ApiUserUnavailable,
  );
});

// Codex #118 round 4: work started for one person (a Share save, a heart) asks Clerk for a
// token after someone else has signed in. Clerk answers for whoever is signed in now, so the
// client bound to the first person must send nothing with the second person's token.
it('sends nothing when the token is someone else’s', async () => {
  const { personalApiUser } = await import('./personal-session');
  const tokenFor = (sub: string) =>
    `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
  global.fetch = answer(201, { id: 's1', version: 1 }) as typeof fetch;
  let signedIn = 'user_a';
  const api = personalApiUser({
    status: 'signed-in',
    userId: 'user_a',
    apiUserUrl: BASE,
    getToken: async () => tokenFor(signedIn),
  });
  await api.command('/v1/stories', { method: 'POST', body: {} });
  expect(sent).toHaveLength(1);

  signedIn = 'user_b';
  await expect(
    api.command('/v1/stories', { method: 'POST', body: { title: 'A’s' } }),
  ).rejects.toBeInstanceOf(NotSignedIn);
  expect(sent).toHaveLength(1);
});

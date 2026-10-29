// A stand-in api-user for the e2e tests (T3), as the browser calls it from web's origin, with
// CORS like the real service (libs/http's corsOptions: web's origins only, no credentials, the
// preflight for Authorization). contract.e2e.ts checks every answer against
// libs/contracts/openapi/api-user.yaml.
//
// - `GET /v1/account`, the signed-in header's account bootstrap: an account that has accepted
//   the sign-up form and needs no testimony re-acceptance, so pages carry on as usual (sessions
//   starting `unaccepted` haven't accepted the sign-up form: the site sends them to the step).
//   Tests of the consent step and banner answer it themselves (consent.e2e.ts).
// - `POST /v1/account/consents`, one box ticked on a form version: only dev's v1 of each form is
//   in force (stub-api.mjs serves the same), with the real service's checks: the version in
//   force (409), a statement on that form (409), an `Idempotency-Key` (400; the same key with
//   another body 422, the same body answers as before). No state but the keys, which are
//   random per test.
// - Hearts (M2): `PUT`/`DELETE /v1/account/favourites/{storyId}` and `GET /v1/account/favourites`
//   (a page of cards, or `?storyId=…` for "which of these are hearted"). Cards come from the
//   stub api-public-read (STUB_PUBLIC_URL, `/__test/cards`), as the real one reads publicStory,
//   so a story hidden there leaves the list too.
//
// It accepts only the fixtures' token (account-control.tsx): `e2e.<payload>.fixture`, whose payload
// is the fixture person (`sub`) and an optional session a test picks (localStorage
// `e2e-session`); anything else is 401.
// Hearts are kept per token, so tests running in parallel never see each other's. A session
// starting `no-consent` has lost the sign-up consent since the page loaded (its account answer
// still says accepted): hearting answers 403 `consent_required` (D73).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.STUB_USER_PORT ?? 4313);
const publicUrl = process.env.STUB_PUBLIC_URL ?? 'http://127.0.0.1:4310';
const origins = (process.env.STUB_USER_ORIGINS ?? '')
  .split(',')
  .filter(Boolean);
const SESSION = /^Bearer e2e\.([A-Za-z0-9_-]{1,200})\.fixture$/;
const FIXTURE_USER = 'user_e2efixture';
/** The fixture token's session ('' for none), or null if it isn't the fixture person's. */
function sessionOf(authorization) {
  const match = SESSION.exec(authorization ?? '');
  if (!match) return null;
  try {
    const { sub, session } = JSON.parse(
      Buffer.from(match[1], 'base64url').toString('utf8'),
    );
    if (sub !== FIXTURE_USER) return null;
    return typeof session === 'string' && /^[a-z0-9-]{0,64}$/.test(session)
      ? session
      : null;
  } catch {
    return null;
  }
}
const ACCOUNT = {
  id: 'e2efixture',
  version: null,
  role: 'User',
  createdAt: '2026-10-25T12:00:00.000Z',
  signupConsent: { accepted: true },
  testimonyConsent: { acceptanceRequired: false },
};
const ID = /^[A-Za-z0-9_]{1,64}$/;

/** Hearts per session token: story id → when (a counter, newest highest). */
const hearts = new Map();
let clock = 0;

/** The statements of each form's version in force, v1 (D84, D93). */
const FORMS = {
  signup: ['age_18plus', 'account_data'],
  testimony: ['special_category_religious', 'publish'],
  social: ['share_socials'],
};
const MECHANISMS = [
  'web_form_submission',
  'account_settings',
  'reconsent_prompt',
];
/** Idempotency-Key → { body, answer } (D29). */
const replies = new Map();
let events = 0;

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((done) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => done(text));
  });

/** `POST /v1/account/consents` (GrantConsent), checked like the real service. */
async function grant(req, res) {
  const text = await readBody(req);
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
    return problem(res, 400, 'Bad request', 'idempotency_key_required');
  }
  const earlier = replies.get(key);
  if (earlier) {
    if (earlier.text !== text) {
      return problem(
        res,
        422,
        'Idempotency key reused',
        'idempotency_key_reused',
      );
    }
    return send(res, 201, earlier.answer);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return problem(res, 400, 'Bad request', 'validation_failed');
  }
  const { form, formVersion, statement, mechanism } = body ?? {};
  if (
    !(form in FORMS) ||
    typeof formVersion !== 'string' ||
    typeof statement !== 'string' ||
    !MECHANISMS.includes(mechanism) ||
    Object.keys(body).length !== 4
  ) {
    return problem(res, 400, 'Bad request', 'validation_failed');
  }
  if (formVersion !== 'v1') {
    return problem(res, 409, 'Conflict', 'form_version_not_in_force');
  }
  if (!FORMS[form].includes(statement)) {
    return problem(res, 409, 'Conflict', 'statement_not_on_form');
  }
  events += 1;
  const answer = { id: `stubconsent${events}`, version: null };
  replies.set(key, { text, answer });
  return send(res, 201, answer);
}

const problem = (res, status, title, code) => {
  res.writeHead(status, {
    'content-type': 'application/problem+json',
    'cache-control': 'no-store',
  });
  res.end(
    JSON.stringify({
      type: 'about:blank',
      title,
      status,
      ...(code ? { code } : {}),
    }),
  );
};

/** A JSON answer with a weak ETag; 304 to a matching If-None-Match. */
function cached(req, res, body) {
  const text = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
  const headers = { etag, 'cache-control': 'private, no-store' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-type': 'application/json' });
  return res.end(text);
}

/** The public cards now, by id (the stub api-public-read's dev port). */
async function publicCards() {
  const res = await fetch(`${publicUrl}/__test/cards`);
  const { data } = await res.json();
  return new Map(data.map((card) => [card.id, card]));
}

async function listFavourites(req, res, url, mine) {
  const p = url.searchParams;
  const known = new Set(['storyId', 'limit', 'cursor']);
  const ids = p.getAll('storyId');
  const bad = (pointer) => {
    res.writeHead(400, {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Validation failed',
        status: 400,
        code: 'validation_failed',
        errors: [{ pointer, message: 'Invalid.' }],
      }),
    );
  };
  for (const name of p.keys()) if (!known.has(name)) return bad(`/${name}`);
  const cards = await publicCards();
  // Newest heart first, public stories only (C15).
  const listed = [...mine.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => cards.get(id))
    .filter(Boolean);
  if (ids.length) {
    if (p.has('limit') || p.has('cursor')) return bad('/storyId');
    if (ids.length > 50 || !ids.every((id) => ID.test(id)))
      return bad('/storyId');
    const asked = new Set(ids);
    return cached(req, res, {
      data: listed.filter((c) => asked.has(c.id)),
      nextCursor: null,
    });
  }
  const limit = p.has('limit') ? Number(p.get('limit')) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return bad('/limit');
  const cursor = p.get('cursor');
  const offset = cursor === null ? 0 : Number(/^o(\d{1,4})$/.exec(cursor)?.[1]);
  if (!Number.isInteger(offset)) return bad('/cursor');
  const page = listed.slice(offset, offset + limit);
  return cached(req, res, {
    data: page,
    nextCursor: offset + limit < listed.length ? `o${offset + limit}` : null,
  });
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-expose-headers', 'ETag,Location');
  }
  const url = new URL(req.url ?? '/', 'http://stub');
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    if (origin && origins.includes(origin)) {
      res.setHeader(
        'access-control-allow-methods',
        'GET,HEAD,POST,PUT,PATCH,DELETE',
      );
      res.setHeader(
        'access-control-allow-headers',
        'Authorization,Content-Type,If-Match,If-None-Match,Idempotency-Key',
      );
      res.setHeader('access-control-max-age', '600');
    }
    res.writeHead(204);
    return res.end();
  }
  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ status: 'ok', service: 'api-user', db: 'up' }),
    );
  }
  const token = sessionOf(req.headers.authorization);
  const signedIn = () => {
    if (token === null) {
      problem(res, 401, 'Unauthorized');
      return null;
    }
    if (!hearts.has(token)) hearts.set(token, new Map());
    return hearts.get(token);
  };

  if (path === '/v1/account' && req.method === 'GET') {
    if (!signedIn()) return;
    // The sign-up consent is accepted, except for the `unaccepted…` sessions.
    return cached(req, res, {
      ...ACCOUNT,
      signupConsent: { accepted: !token.startsWith('unaccepted') },
    });
  }
  if (path === '/v1/account/consents' && req.method === 'POST') {
    if (!signedIn()) return;
    return void grant(req, res);
  }
  if (path === '/v1/account/favourites' && req.method === 'GET') {
    const mine = signedIn();
    if (!mine) return;
    return listFavourites(req, res, url, mine);
  }
  const one = /^\/v1\/account\/favourites\/([^/]+)$/.exec(path);
  if (one && (req.method === 'PUT' || req.method === 'DELETE')) {
    const mine = signedIn();
    if (!mine) return;
    const id = decodeURIComponent(one[1]);
    if (req.method === 'DELETE') {
      mine.delete(id);
      res.writeHead(204);
      return res.end();
    }
    if (token.startsWith('no-consent'))
      return problem(res, 403, 'Forbidden', 'consent_required');
    if (!ID.test(id) || !(await publicCards()).has(id))
      return problem(res, 404, 'Not found', 'story_not_found');
    if (!mine.has(id)) mine.set(id, ++clock);
    res.writeHead(204);
    return res.end();
  }
  return problem(res, 404, 'Not found');
}).listen(port, '127.0.0.1');

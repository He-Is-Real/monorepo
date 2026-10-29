// A stand-in api-user for the e2e tests (T3), as the browser calls it from web's origin, with
// CORS like the real service (libs/http's corsOptions: web's origins only, no credentials, the
// preflight for Authorization):
// - `GET /v1/account`, the signed-in header's account bootstrap: an account that has accepted
//   the sign-up form and needs no testimony re-acceptance, so pages carry on as usual. Tests of
//   the consent step and banner answer it themselves (consent.e2e.ts).
// - `POST /v1/account/consents`, one box ticked on a form version: only dev's v1 of each form is
//   in force (stub-api.mjs serves the same), with the real service's checks: the version in
//   force (409), a statement on that form (409), an `Idempotency-Key` (400; the same key with
//   another body 422, the same body answers as before). No state but the keys, which are
//   random per test.
// It accepts only the fixtures' session token (account-control.tsx, E2E_FIXTURE_TOKEN);
// anything else is 401. contract.e2e.ts checks every answer against
// libs/contracts/openapi/api-user.yaml.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.STUB_USER_PORT ?? 4313);
const origins = (process.env.STUB_USER_ORIGINS ?? '')
  .split(',')
  .filter(Boolean);
const TOKEN = 'e2e-fixture-session-token';
const ACCOUNT = {
  id: 'e2efixture',
  version: null,
  role: 'User',
  createdAt: '2026-10-25T12:00:00.000Z',
  signupConsent: { accepted: true },
  testimonyConsent: { acceptanceRequired: false },
};
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

createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-expose-headers', 'ETag,Location');
  }
  const path = new URL(req.url ?? '/', 'http://stub').pathname;
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
  if (path === '/v1/account' && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return problem(res, 401, 'Unauthorized');
    }
    const body = JSON.stringify(ACCOUNT);
    const etag = `W/"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    const headers = { etag, 'cache-control': 'private, no-store' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    return res.end(body);
  }
  if (path === '/v1/account/consents' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return problem(res, 401, 'Unauthorized');
    }
    return void grant(req, res);
  }
  return problem(res, 404, 'Not found');
}).listen(port, '127.0.0.1');

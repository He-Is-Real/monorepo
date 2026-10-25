// A stand-in api-user for the e2e tests (T3): the signed-in header's account bootstrap,
// `GET /v1/account`, as the browser calls it from web's origin, with CORS like the real
// service (libs/http's corsOptions: web's origins only, no credentials, the preflight for
// Authorization). It accepts only the fixtures' session token (account-control.tsx,
// E2E_FIXTURE_TOKEN); anything else is 401. contract.e2e.ts checks every answer against
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
  signupConsent: { accepted: false },
};

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
  return problem(res, 404, 'Not found');
}).listen(port, '127.0.0.1');

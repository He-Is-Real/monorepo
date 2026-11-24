import { request as httpRequest } from 'node:http';
import { expect, test } from '@playwright/test';
import { STUB_USER_PORT, STUB_USER_URL } from './servers';

// The stub api-user (stub-api-user.mjs) outlives a client that drops its connection part-way
// through sending a body: that one request ends and the next is served, so one cancelled
// request can't fail every later test. One device: nothing here depends on the screen.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
});

/** Starts a request whose body promises 1000 bytes, sends 10, then cuts the connection. */
const hangUp = (method: string, path: string, authorization?: string) =>
  new Promise<void>((done) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: STUB_USER_PORT,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': 1000,
        ...(authorization ? { authorization, 'if-match': '"0"' } : {}),
      },
    });
    req.on('error', () => done());
    req.on('close', () => done());
    req.write('{"terms":', () => req.destroy());
  });

/** The stub's fixture token for an admin session (see `sessionOf` in stub-api-user.mjs). */
const ADMIN = `Bearer e2e.${Buffer.from(
  JSON.stringify({ sub: 'user_e2efixture', session: 'admin-disconnect' }),
).toString('base64url')}.fixture`;

for (const [what, method, path, authorization] of [
  ['an image upload (streamed body)', 'PUT', '/__s3/stub-disconnect.webp'],
  ['a session seed (JSON body)', 'POST', '/__e2e/sessions/stub-disconnect'],
  ['an admin settings save', 'PUT', '/v1/admin/submission-settings', ADMIN],
  ['an admin themes save', 'PUT', '/v1/admin/themes', ADMIN],
]) {
  test(`hanging up mid-way through ${what} leaves the stub serving the next request`, async ({
    request,
  }) => {
    await hangUp(method, path, authorization);
    for (let i = 0; i < 2; i++) {
      const res = await request.get(`${STUB_USER_URL}/health`);
      expect(res.status()).toBe(200);
    }
  });
}

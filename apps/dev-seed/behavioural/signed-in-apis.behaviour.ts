import { expect, test } from '@playwright/test';
import { API_ADMIN_URL, API_USER_URL, WEB_URL } from './playwright.config';

// api-user and api-admin on dev: they start with the deployed configuration (Clerk settings,
// their own database logins) and the browser may call them from web's origin only (D31). Their
// routes need a Clerk session token; those are tested once M2's pages use them.
for (const [service, url] of [
  ['api-user', API_USER_URL],
  ['api-admin', API_ADMIN_URL],
] as const) {
  test(`${service} reports the database up`, async ({ request }) => {
    const res = await request.get(`${url}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ service, db: 'up' });
  });

  test(`${service} lets the browser call it from web’s origin only`, async ({
    request,
  }) => {
    const preflight = (origin: string) =>
      request.fetch(`${url}/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
    const web = new URL(WEB_URL).origin;
    const allowed = await preflight(web);
    expect(allowed.headers()['access-control-allow-origin']).toBe(web);
    const other = await preflight('https://example.com');
    expect(other.headers()['access-control-allow-origin']).toBeUndefined();
  });
}

import {
  API_ADMIN_URL,
  API_URL,
  API_USER_URL,
  WEB_URL,
} from './playwright.config';

/**
 * Global setup: wake every Cloud Run service (they scale to zero) before any test runs, so no
 * test needs a retry to survive a cold start (T4). Gives up after 3 minutes. Each API must also
 * report its own database login working (`db: 'up'`), or no test runs.
 */
export default async function warmUp(): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (const [service, base] of [
    ['api-public-read', API_URL],
    ['api-user', API_USER_URL],
    ['api-admin', API_ADMIN_URL],
    ['web', WEB_URL],
  ] as const) {
    const url = `${base}/health`;
    for (;;) {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (res?.status === 200) {
        if (service !== 'web') {
          const body = (await res.json()) as { service?: string; db?: string };
          if (body.service !== service || body.db !== 'up')
            throw new Error(`${url} answers ${JSON.stringify(body)}`);
        }
        break;
      }
      if (Date.now() > deadline)
        throw new Error(`${url} still answers ${res?.status || 'nothing'}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

import { API_URL, WEB_URL } from './playwright.config';

/**
 * Global setup: wake both Cloud Run services (they scale to zero) before any test runs, so no
 * test needs a retry to survive a cold start (T4). Gives up after 3 minutes.
 */
export default async function warmUp(): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (const url of [`${API_URL}/health`, `${WEB_URL}/health`]) {
    for (;;) {
      const status = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        .then((r) => r.status)
        .catch(() => 0);
      if (status === 200) break;
      if (Date.now() > deadline)
        throw new Error(`${url} still answers ${status || 'nothing'}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

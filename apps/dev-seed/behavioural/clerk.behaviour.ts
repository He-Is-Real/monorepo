import { expect, type Page, test } from '@playwright/test';
import { expectClerkTargetsFullSize, expectFitsScreen } from './clerk-card';

// web on dev with the real Clerk dev instance, whose script loads from Clerk over the internet.
// Moved from the web e2e suite (Codex review of #72, round 3): that suite runs without the
// network (local equals CI, T4), with a stand-in for Clerk's Sign in, so the real one is checked
// here, on the deployed site, after each deploy.

async function expectFullSizeTarget(page: Page, name: string) {
  const button = page.getByRole('link', { name });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  const width = page.viewportSize()?.width ?? 0;
  expect(
    (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    'no horizontal scroll',
  ).toBe(true);
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 1280, height: 800 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`${viewport.width} px, ${colorScheme}`, () => {
      test.use({ viewport, colorScheme });

      test('Sign in fits the header and opens the sign-in page, where Clerk’s sign-in fits', async ({
        page,
      }) => {
        await page.goto('/');
        await expectFullSizeTarget(page, 'Sign in');
        await page.getByRole('link', { name: 'Sign in' }).click();
        await expect(page).toHaveURL(/\/sign-in$/);
        // The page's "Welcome" is its only h1: Clerk's step titles are hidden, and the page
        // names the form instead.
        const form = page.getByRole('region', {
          name: 'Sign in or create an account',
        });
        await expect(form.getByLabel(/email address/i)).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText([
          'Welcome',
        ]);
        // Google and email, never Apple (D2; Project Opinion).
        await expect(
          form.getByRole('button', { name: /google/i }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: /apple/i })).toHaveCount(
          0,
        );
        await expect(
          form.getByRole('button', { name: 'Continue', exact: true }),
        ).toBeVisible();
        await expectClerkTargetsFullSize(page);
        await expectFitsScreen(page, viewport.width);
      });
    });
  }
}

test.describe('as a real visitor’s browser', () => {
  // Clerk turns its telemetry off for automated browsers (navigator.webdriver) and robot user
  // agents, so look like an ordinary Chrome, or this test would pass whatever the setting.
  test.use({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });

  test('no optional Clerk telemetry: collector off, no request to clerk-telemetry.com, nothing stored', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false,
      });
    });
    const telemetry: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).hostname.endsWith('clerk-telemetry.com'))
        telemetry.push(r.url());
    });
    await page.goto('/about');
    // Deterministic, no waiting for a flush: once Clerk has loaded, its telemetry collector is
    // either absent (telemetry={false}) or would report itself enabled (it did before the fix).
    await page.waitForFunction(
      () => (window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true,
    );
    const collector = await page.evaluate(() => {
      const t = (window as { Clerk?: { telemetry?: { isEnabled?: boolean } } })
        .Clerk?.telemetry;
      return t ? { enabled: t.isEnabled === true } : null;
    });
    expect(collector?.enabled ?? false).toBe(false);
    await page.goto('/sign-in');
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    const keys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ]);
    expect(keys.filter((k) => k.startsWith('clerk_telemetry'))).toEqual([]);
    expect(telemetry).toEqual([]);
  });
});

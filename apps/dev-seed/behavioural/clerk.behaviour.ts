import { expect, type Page, test } from '@playwright/test';

// web on dev with the real Clerk dev instance, whose script loads from Clerk over the internet.
// Moved from the web e2e suite (Codex review of #72, round 3): that suite runs without the
// network (local equals CI, T4), with a stand-in for Clerk's Sign in, so the real one is checked
// here, on the deployed site, after each deploy.

async function expectFullSizeTarget(page: Page, name: string) {
  const button = page.getByRole('button', { name });
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
  test.describe(`${viewport.width} px`, () => {
    test.use({ viewport });

    test('Clerk’s Sign in loads, fits the header and opens Clerk’s sign-in', async ({
      page,
    }) => {
      await page.goto('/');
      await expectFullSizeTarget(page, 'Sign in');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(
        page.getByRole('heading', { name: /sign in/i }),
      ).toBeVisible();
    });
  });
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
    await page.getByRole('button', { name: 'Sign in' }).click();
    const keys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ]);
    expect(keys.filter((k) => k.startsWith('clerk_telemetry'))).toEqual([]);
    expect(telemetry).toEqual([]);
  });
});

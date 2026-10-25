import { expect, type Page } from '@playwright/test';

// Every control in Clerk's card, measured (44 px touch targets, AGENTS.md). The web e2e suite
// can't see these: its stand-in for Clerk is a plain box with nothing to press. One exception:
// Clerk's own logo link ("Secured by Clerk"), which Clerk's appearance settings can't reach.
// Used on the first step (clerk.behaviour.ts) and the email code step (account.behaviour.ts,
// which signs in anyway, so no extra code is sent to the test user).
export async function expectClerkTargetsFullSize(page: Page) {
  const small = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.cl-rootBox a, .cl-rootBox button, .cl-rootBox input',
      ),
    ]
      .filter(
        (e) =>
          e.getClientRects().length > 0 &&
          e.getAttribute('tabindex') !== '-1' &&
          !e.closest('[aria-hidden="true"]') &&
          !e.matches('a[href^="https://go.clerk.com/"]'),
      )
      .map((e) => {
        const r = e.getBoundingClientRect();
        const name =
          e.getAttribute('aria-label') ||
          e.textContent?.trim() ||
          e.getAttribute('name') ||
          '';
        return { name, width: r.width, height: r.height };
      })
      .filter((t) => t.width < 44 || t.height < 44),
  );
  expect(small, 'Clerk controls smaller than 44 × 44 px').toEqual([]);
}

export async function expectFitsScreen(page: Page, width: number) {
  const box = await page.locator('.cl-cardBox').boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    'no horizontal scroll',
  ).toBe(true);
}

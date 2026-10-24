import { expect, type Locator, type Page } from '@playwright/test';

// Shared checks for the responsive suite (Joel, decision 20): no sideways scrolling, 44 px
// touch targets fully on screen, and a full-page screenshot per device and scheme.

export const MIN_TARGET = 44;

export async function expectNoHorizontalOverflow(page: Page) {
  // The device's width, not window.innerWidth: mobile browsers zoom out to fit overflowing
  // content, which would hide the problem.
  const deviceWidth = page.viewportSize()?.width ?? 0;
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(innerWidth, 'the page zoomed out to fit overflowing content').toBe(
    deviceWidth,
  );
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(
    deviceWidth,
  );
}

export async function expectTarget(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
  const width = page.viewportSize()?.width ?? 0;
  expect(
    (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
  ).toBe(true);
}

export async function screenshot(
  page: Page,
  project: string,
  scheme: string,
  name: string,
) {
  // The full header in every screenshot: Clerk's sign-in button loads in the browser.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.screenshot({
    path: `test-output/e2e/screenshots/${project}/${scheme}-${name}.png`,
    fullPage: true,
  });
}

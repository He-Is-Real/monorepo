import { expect, type Locator, type Page } from '@playwright/test';
import { SCREENSHOT_DEVICES } from './devices';

// Shared by the e2e suites: screenshots, the no-sideways-scroll check and 44 px targets.

export const MIN_TARGET = 44;
export async function shots(
  page: Page,
  project: string,
  scheme: string,
  name: string,
) {
  // T8: images to look at, on 4 sizes only (dark on the smallest and 1280), nothing compares
  // them, and the CI artifact stays small.
  if (!SCREENSHOT_DEVICES.includes(project)) return;
  if (scheme === 'dark' && !['phone-320', 'desktop-1280'].includes(project))
    return;
  // The full header in every screenshot: Clerk's sign-in button loads in the browser.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // JPEG: a fraction of PNG's size, plenty to look at (the CI artifact stays small).
  await page.screenshot({
    path: `test-output/e2e/screenshots/${project}/${scheme}-${name}.jpg`,
    fullPage: true,
    type: 'jpeg',
    scale: 'css',
    quality: 50,
  });
}

export async function expectNoHorizontalOverflow(page: Page) {
  // Compare with the device's width, not window.innerWidth: mobile browsers widen the layout
  // viewport (zoom out) to fit content that overflows, which would hide the problem.
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
  // Fully inside the viewport horizontally.
  const width = page.viewportSize()?.width ?? 0;
  expect(
    (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
  ).toBe(true);
}

/**
 * Every visible link, button and form control in the header, main content and footer is at
 * least 44 × 44 px (AGENTS.md). A card's title link is stretched over the whole card, so cards are
 * measured instead. Elements hidden at this width (display: none) are skipped.
 */
export async function expectAllTargets(page: Page) {
  const small = await page.evaluate((min) => {
    const out: string[] = [];
    const scope = document.querySelectorAll(
      'header a, header button, header select, header input, main a, main button, main select, main input:not([type=hidden]), main summary, main article, footer a, footer button',
    );
    for (const el of Array.from(scope)) {
      if (el.tagName !== 'ARTICLE' && el.closest('article')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // not displayed
      if (el.closest('.sr-only') || el.classList.contains('sr-only')) continue;
      if (r.width < min || r.height < min)
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
    }
    return out;
  }, MIN_TARGET);
  expect(small, 'targets smaller than 44 × 44 px').toEqual([]);
}

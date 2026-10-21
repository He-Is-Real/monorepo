import { expect, type Page, test } from '@playwright/test';

// Responsive everywhere (Joel, 0.9) and the walking-skeleton page: on every device in the
// matrix and in both colour schemes, no horizontal scrolling, the key elements visible, touch
// targets at least 44 px, and a screenshot of each page for review.

const MIN_TARGET = 44;
async function shots(
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

async function expectNoHorizontalOverflow(page: Page) {
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

async function expectTarget(page: Page, locator: ReturnType<Page['locator']>) {
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

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('home: the featured story, header and sign-in fit', async ({
      page,
    }, info) => {
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      // Noindex in dev (ROBOTS_NOINDEX): header and meta tag.
      expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex, nofollow',
      );

      // Follows the device by default.
      await expect(page.locator('html')).toHaveClass(
        scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );

      await expect(
        page.getByRole('link', { name: 'He Is Real Today, home' }),
      ).toBeVisible();
      await expectTarget(page, page.getByRole('button', { name: /theme/i }));
      await expectTarget(page, page.getByRole('button', { name: 'Sign in' }));
      await expect(
        page.getByRole('heading', { level: 1, name: 'He Is Real Today' }),
      ).toBeVisible();
      const story = page.getByRole('heading', {
        level: 2,
        name: 'Test story: the walking skeleton',
      });
      await expect(story).toBeVisible();
      await expect(page.getByText('Nobody shared this story')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'home');
    });

    test('story page: long words wrap without sideways scrolling', async ({
      page,
    }, info) => {
      await page.goto('/stories/long-words');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Tags' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'story');
    });

    test('unknown story: the 404 page', async ({ page }, info) => {
      const response = await page.goto('/stories/no-such-story');
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole('heading', { name: 'We couldn’t find that page' }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, '404');
    });

    test('api-public-read down: the friendly error page', async ({
      page,
    }, info) => {
      await page.goto('/stories/down');
      await expect(
        page.getByRole('heading', { name: 'Something went wrong on our side' }),
      ).toBeVisible();
      await expectTarget(page, page.getByRole('button', { name: 'Try again' }));
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'error');
    });
  });
}

test('the theme toggle cycles light → dark → system and is remembered on reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: /theme/i });
  const html = page.locator('html');
  await expect(toggle).toHaveAttribute('data-theme-choice', 'system');

  await toggle.click(); // → light
  await expect(toggle).toHaveAttribute('data-theme-choice', 'light');
  await toggle.click(); // → dark
  await expect(html).toHaveClass(/\bdark\b/);

  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/); // set before paint, from localStorage
  await expect(toggle).toHaveAttribute('data-theme-choice', 'dark');

  await toggle.click(); // → system (the device is light)
  await expect(html).not.toHaveClass(/\bdark\b/);
});

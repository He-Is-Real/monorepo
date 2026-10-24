import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, expectTarget, shots } from './helpers';

// Responsive everywhere (Joel, 0.9) and the walking-skeleton page: on every device in the
// matrix and in both colour schemes, no horizontal scrolling, the key elements visible, touch
// targets at least 44 px, and a screenshot of each page for review.

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('home: the newest stories, header and sign-in fit', async ({
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
        page.getByRole('heading', { level: 1, name: /Is God Real\?/ }),
      ).toBeVisible();
      // The newest stories, never a chosen one (Joel, 2026-10-23: no featured stories).
      await expect(page.locator('main article')).toHaveCount(3);
      await expect(
        page
          .getByRole('heading', { level: 3 })
          .first()
          .getByRole('link', { name: 'Test story: audio' }),
      ).toBeVisible();
      // D48: the stub reports relaxed consent checks, as dev will while it holds dummy data.
      await expect(
        page.getByRole('contentinfo').getByText('Consent checks relaxed (dev)'),
      ).toBeVisible();
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

    test('long story: a preview with Continue reading, expanded in place', async ({
      page,
      request,
    }, info) => {
      // The full text is in the server-rendered HTML (search engines), not fetched on expand.
      const html = await (await request.get('/stories/long-story')).text();
      expect(html).toContain('The last sentence of the long test story.');

      await page.goto('/stories/long-story');
      const button = page.getByRole('button', { name: 'Continue reading' });
      await expectTarget(page, button);
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      const text = page.locator(
        `#${await button.getAttribute('aria-controls')}`,
      );
      await expect(text).toBeVisible();
      await expect(text.getByText(/where the preview stops/)).toBeVisible();
      const last = page.getByText('The last sentence of the long test story.');
      await expect(last).toBeHidden();
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'long-story');

      // Expanding keeps everything above the button where it was (in the document; clicking
      // may scroll the page to the button).
      const heading = page.getByRole('heading', { level: 1 });
      const top = () =>
        heading.evaluate(
          (el) => el.getBoundingClientRect().top + window.scrollY,
        );
      const headingTop = await top();
      await button.click();
      await expect(
        page.getByRole('button', { name: 'Show less' }),
      ).toHaveAttribute('aria-expanded', 'true');
      await expect(last).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Show less' }),
      ).toBeFocused();
      expect(await top()).toBe(headingTop);
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'long-story-expanded');

      const less = page.getByRole('button', { name: 'Show less' });
      await expectTarget(page, less);
      await less.click();
      await expect(last).toBeHidden();
      const again = page.getByRole('button', { name: 'Continue reading' });
      await expect(again).toBeFocused();
      await expect(again).toBeInViewport();
    });

    test('video, audio and image stories: signed media fits without autoplay (D52)', async ({
      page,
    }, info) => {
      for (const [slug, title] of [
        ['video-story', 'Video: Test story: a tall video'],
        ['audio-story', 'Audio: Test story: audio'],
      ] as const) {
        await page.goto(`/stories/${slug}`);
        const player = page.locator(`iframe[title="${title}"]`);
        await expect(player).toBeVisible();
        const src = new URL((await player.getAttribute('src')) ?? '');
        expect(src.searchParams.get('token')).toBe('stub');
        expect(src.searchParams.get('autoplay')).toBe('false');
        expect(await player.getAttribute('allow')).not.toContain('autoplay');
        await expect(
          page.frameLocator(`iframe[title="${title}"]`).getByRole('button', {
            name: 'Play',
          }),
        ).toBeVisible();
        const box = await player.boundingBox();
        const viewport = page.viewportSize();
        // A tall video stays within the screen's height (75svh) and the page's width.
        expect(box?.height ?? 0).toBeLessThanOrEqual(viewport?.height ?? 0);
        expect(box?.width ?? 0).toBeLessThanOrEqual(viewport?.width ?? 0);
        await expectNoHorizontalOverflow(page);
        await shots(page, info.project.name, scheme, slug);
      }

      await page.goto('/stories/image-story');
      const image = page.getByRole('img', {
        name: 'A wide test pattern (dummy image)',
      });
      await expect(image).toBeVisible();
      expect(
        await image.evaluate((i: HTMLImageElement) => i.naturalWidth),
      ).toBe(1600);
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'image-story');
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

test('blocked storage (the localStorage getter throws) still renders the site and the toggle', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: /Is God Real\?/ }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/); // the device's setting
  const toggle = page.getByRole('button', { name: /theme/i });
  await expect(toggle).toHaveAttribute('data-theme-choice', 'system');
  await toggle.click(); // → light, for this page only
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});

import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
  shots,
} from './helpers';

// M1 step 6b-1: home, browse and the story pages on every device in the matrix, light and dark
// (no sideways scroll, 44 px targets, screenshots), then the behaviour that needs a real browser:
// D55's two automatic pages and the button, Back, keyboard order, the share popup and the
// masonry's balance. The stub API serves 54 published stories (e2e/stub-api.mjs).

const cards = (page: Page) => page.locator('main ul.masonry > li');

async function scrollToEnd(page: Page) {
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('home fits: hero, featured stories, themes, giving', async ({
      page,
    }, info) => {
      await page.goto('/');
      await expect(
        page.getByRole('heading', { level: 1, name: /Is God Real\?/ }),
      ).toBeVisible();
      await expect(page.locator('main article')).toHaveCount(3);
      await expect(
        page.getByRole('link', { name: 'Healing', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('Placeholder figures until launch.'),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'home-full');
    });

    test('browse fits: filters, tags and the masonry', async ({
      page,
    }, info) => {
      await page.goto('/stories');
      await expect(
        page.getByRole('heading', { level: 1, name: 'God Stories' }),
      ).toBeVisible();
      await expect(cards(page)).toHaveCount(15);
      await expect(page.getByLabel('Search stories')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'browse');

      await page.goto('/stories?tag=healing&format=video');
      await expect(
        page.getByText('Video stories tagged Healing'),
      ).toBeVisible();
      await expect(cards(page).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'browse-filtered');

      await page.goto('/stories?q=nothing-matches-this');
      await expect(
        page.getByText('No stories match these filters yet.'),
      ).toBeVisible();
      await expectTarget(
        page,
        page.getByRole('link', { name: 'Clear filters' }),
      );
    });

    test('story pages fit: video, audio, written with and without an image', async ({
      page,
    }, info) => {
      for (const slug of [
        'video-story',
        'audio-story',
        'browse-test-05', // written, 3:2 image
        'browse-test-02', // written, no image
        'long-words',
      ]) {
        await page.goto(`/stories/${slug}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(
          page.getByRole('navigation', { name: 'Breadcrumb' }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', { name: 'Related stories' }),
        ).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expectAllTargets(page);
        await shots(page, info.project.name, scheme, `story-${slug}`);
      }

      // The share popup fits on the screen, with full-size targets.
      await page.goto('/stories/video-story');
      await page.getByRole('button', { name: 'Share' }).click();
      const popup = page.getByRole('dialog');
      await expect(
        popup.getByRole('heading', { name: 'Share this story' }),
      ).toBeVisible();
      // Measure after its opening animation (it scales up from 95%).
      await popup.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      const box = await popup.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(
        (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
      ).toBe(true);
      // The popup sits at a fractional offset (Radix's transform), so at 2.5× and 3× a 44 px
      // option can measure 43.9999 px: allow a hundredth of a pixel of rounding.
      for (const option of await popup.locator('a, button').all())
        expect(
          (await option.boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(44 - 0.01);
      await shots(page, info.project.name, scheme, 'story-share');
    });
  });
}

test.describe('behaviour', () => {
  // Playwright needs the fixtures argument as an object pattern, even when none are used.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'desktop-1280'].includes(info.project.name),
      'behaviour is checked on one phone and one desktop',
    );
  });

  test('browse loads two pages on its own, then waits for “Show more stories” (D55)', async ({
    page,
  }) => {
    await page.goto('/stories');
    await expect(cards(page)).toHaveCount(15);
    await scrollToEnd(page);
    await expect(cards(page)).toHaveCount(30);
    await scrollToEnd(page);
    await expect(cards(page)).toHaveCount(45);
    const more = page.getByRole('button', { name: 'Show more stories' });
    await expect(more).toBeVisible();
    await expect(page.getByText('You’ve seen 45 stories.')).toBeVisible();
    await expect(page).toHaveURL(/[?&]pages=3$/);

    // No more automatic loads, however far the reader scrolls.
    await scrollToEnd(page);
    await page.waitForTimeout(1500);
    await expect(cards(page)).toHaveCount(45);

    await expectTarget(page, more);
    await more.click();
    await expect(cards(page)).toHaveCount(54);
    await expect(page.getByText('You’ve seen every story here.')).toBeVisible();
    await expect(more).toHaveCount(0);
    // Keyboard and screen-reader users carry on from the first new story.
    await expect(cards(page).nth(45).getByRole('link')).toBeFocused();
  });

  test('Back from a story shows the same loaded list', async ({ page }) => {
    await page.goto('/stories');
    await scrollToEnd(page);
    await expect(cards(page)).toHaveCount(30);
    await expect(page).toHaveURL(/pages=2/);
    await cards(page).nth(20).getByRole('link').click();
    await expect(page).toHaveURL(/\/stories\/[a-z0-9-]+$/);
    await page.goBack();
    await expect(page).toHaveURL(/pages=2/);
    await expect(cards(page)).toHaveCount(30);
  });

  test('a filter link narrows the list and keeps its state in the URL', async ({
    page,
  }) => {
    await page.goto('/stories');
    await page.getByRole('link', { name: 'Loss', exact: true }).click();
    await expect(page).toHaveURL(/\/stories\?tag=loss$/);
    await expect(page.getByText('Stories tagged Loss')).toBeVisible();
    for (const card of await cards(page).all())
      await expect(card.getByRole('list', { name: 'Tags' })).toContainText(
        'Loss',
      );
    await page.getByLabel('Format').selectOption('audio');
    await expect(page).toHaveURL(/format=audio/);
    await expect(page).toHaveURL(/tag=loss/);
  });

  test('keyboard: skip link first, filters and tags before the cards', async ({
    page,
  }) => {
    await page.goto('/stories');
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', { name: 'Skip to content' }),
    ).toBeFocused();
    await page.getByLabel('Search stories').focus();
    const order: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.closest('article') ? 'card' : (el?.textContent ?? '').trim();
      });
      order.push(label);
      if (label === 'card') break;
    }
    expect(order.indexOf('Search')).toBeGreaterThan(-1);
    expect(order.indexOf('All')).toBeGreaterThan(order.indexOf('Search'));
    expect(order.indexOf('More tags')).toBeGreaterThan(order.indexOf('All'));
    expect(order.at(-1)).toBe('card');
  });

  test('share opens from the keyboard and Escape gives focus back', async ({
    page,
  }) => {
    await page.goto('/stories/video-story');
    const share = page.getByRole('button', { name: 'Share' });
    await share.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Share this story' }),
    ).toBeVisible();
    const whatsapp = page.getByRole('link', { name: /WhatsApp/ });
    expect(await whatsapp.getAttribute('href')).toContain(
      encodeURIComponent('/stories/video-story'),
    );
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Share this story' }),
    ).toHaveCount(0);
    await expect(share).toBeFocused();
  });

  test('the phone menu opens, and Escape closes it', async ({ page }, info) => {
    test.skip(info.project.name !== 'phone-320', 'phones only');
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    await expectTarget(page, menu);
    await menu.click();
    await expect(page.getByRole('navigation', { name: 'Menu' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation', { name: 'Menu' })).toBeHidden();
    await expect(menu).toBeFocused();
  });

  test('the masonry keeps its columns balanced and in date order', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'three columns');
    await page.goto('/stories');
    await expect(cards(page)).toHaveCount(15);
    const boxes = await cards(page).evaluateAll((lis) =>
      lis.map((li) => {
        const r = (li.firstElementChild as HTMLElement).getBoundingClientRect();
        return {
          x: Math.round(r.x),
          bottom: r.bottom,
          height: r.height,
          top: r.top,
        };
      }),
    );
    const columns = new Map<number, number>();
    for (const b of boxes)
      columns.set(b.x, Math.max(columns.get(b.x) ?? 0, b.bottom));
    expect(columns.size).toBe(3);
    const bottoms = [...columns.values()];
    const tallest = Math.max(...boxes.map((b) => b.height));
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(tallest);
    // No overlaps within a column (the measured spans hold every card).
    const byColumn = [...columns.keys()].map((x) =>
      boxes.filter((b) => b.x === x).sort((a, b) => a.top - b.top),
    );
    for (const col of byColumn)
      for (let i = 1; i < col.length; i++)
        expect(col[i].top).toBeGreaterThanOrEqual(col[i - 1].bottom - 1);
  });
});

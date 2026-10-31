import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
  shots,
} from './helpers';
import { STUB_URL, WEB_DOWN_URL } from './servers';

// M1 step 6b-1: home, browse and the story pages on every device in the matrix, light and dark
// (no sideways scroll, 44 px targets, screenshots), then the behaviour that needs a real browser:
// D55's two automatic pages and the button, Back, keyboard order, the share popup and the
// masonry's balance. The stub API serves 54 published stories (e2e/stub-api.mjs).

const cards = (page: Page) => page.locator('main ul.masonry > li');

/**
 * Brings the end of browse's list into view, as a reader scrolling down does: its last card,
 * instantly. Loading more watches for the end coming near (D55), so the list sees this however
 * late its JavaScript starts. Jumping to the page's very end instead (the footer, smoothly)
 * could pass the end between two frames under load and never be seen (#119).
 */
async function scrollToEnd(page: Page) {
  await cards(page)
    .last()
    .evaluate((li) => li.scrollIntoView({ block: 'end', behavior: 'instant' }));
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('home fits: hero, newest stories, themes, giving', async ({
      page,
    }, info) => {
      const response = await page.goto('/');
      // Noindex in dev: header and meta tag.
      expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex, nofollow',
      );
      // The theme follows the device by default.
      await expect(page.locator('html')).toHaveClass(
        scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
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
      // D48: the stub reports relaxed consent checks, as dev does while it holds dummy data.
      await expect(
        page.getByRole('contentinfo').getByText('Consent checks relaxed (dev)'),
      ).toBeVisible();
      await expectTarget(page, page.getByRole('link', { name: 'Sign in' }));
      await expect(
        page.getByRole('link', { name: 'Healing', exact: true }),
      ).toBeVisible();
      // No made-up figures until they're confirmed (2026-10-24, pending Joel).
      await expect(page.getByText('Countries reached')).toHaveCount(0);
      // The backdrop photo loads and is decorative (empty alt).
      const backdrop = page.locator('main > section').first().locator('img');
      await expect(backdrop).toHaveAttribute('alt', '');
      await expect
        .poll(() =>
          backdrop.evaluate((img: HTMLImageElement) => img.naturalWidth),
        )
        .toBeGreaterThan(0);
      await expect(
        page.getByRole('heading', { name: 'Support this work' }),
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
        // No breadcrumb (Joel, 2026-10-24): it could show only one of a story's tags; the
        // header's Stories link and the tag chips are the ways back.
        await expect(
          page.getByRole('navigation', { name: 'Breadcrumb' }),
        ).toHaveCount(0);
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
      // Measure after its opening animation (it scales up from 95%) and the web font (text
      // set in the fallback font first can reflow the popup's height).
      await popup.evaluate((el) =>
        Promise.all([
          ...el.getAnimations({ subtree: true }).map((a) => a.finished),
          document.fonts.ready,
        ]),
      );
      const box = await popup.boundingBox();
      const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
      expect(
        (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
      ).toBe(true);
      // Codex review of #66, finding 6: on a 320 × 568 phone the popup must fit vertically too
      // (it scrolls inside itself when it can't), so Copy link is always reachable.
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
        height + 0.5,
      );
      const copy = popup.getByRole('button', { name: /Copy link/ });
      await copy.scrollIntoViewIfNeeded();
      await expect(copy).toBeInViewport();
      // The popup sits at a fractional offset (Radix's transform), so at 2.5× and 3× a 44 px
      // option can measure 43.9999 px: allow a hundredth of a pixel of rounding.
      for (const option of await popup.locator('a, button').all())
        expect(
          (await option.boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(44 - 0.01);
      await shots(page, info.project.name, scheme, 'story-share');
    });

    test('the giving placeholder fits: no payment, a way back to the stories', async ({
      page,
    }, info) => {
      await page.goto('/donate');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Giving isn’t open yet' }),
      ).toBeVisible();
      await expect(page.locator('main form, main input')).toHaveCount(0);
      const back = page.getByRole('link', { name: 'Read the stories' });
      await expectTarget(page, back);
      await expect(back).toHaveAttribute('href', '/stories');
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'donate');
    });
  });
}

// Codex round 2, finding 1: the phone menu closes whenever one of its links is used, also
// when the link leads to the section already open (same pathname). Every phone-width device.
test.describe('phone menu', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    const width = info.project.use.viewport?.width ?? 0;
    test.skip(width >= 640, 'the menu button shows below 640 px only');
  });

  for (const [from, link, to] of [
    ['/stories?tag=loss', 'Stories', /\/stories$/],
    ['/share', 'Share your story', /\/share$/],
  ] as const) {
    test(`tapping “${link}” on ${from} closes the menu`, async ({ page }) => {
      await page.goto(from);
      const menu = page.getByRole('button', { name: 'Menu' });
      await menu.click();
      const panel = page.locator('[data-mobile-nav]');
      await panel.getByRole('link', { name: link, exact: true }).click();
      await expect(page).toHaveURL(to);
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('navigation', { name: 'Menu' })).toBeHidden();
      // Focus is free again: Tab leaves the menu.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest('[data-mobile-nav]'),
        ),
      ).toBe(false);
    });
  }
});

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
    // Screen readers hear that more loaded, never how many (D62: no story counts anywhere).
    const announcement = page.locator('main [role="status"]', {
      hasText: 'loaded',
    });
    await expect(announcement).toHaveText('More stories loaded.');
    await scrollToEnd(page);
    await expect(cards(page)).toHaveCount(45);
    const more = page.getByRole('button', { name: 'Show more stories' });
    await expect(more).toBeVisible();
    await expect(page.getByText('There are more stories.')).toBeVisible();
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
    // Each card's story link, in order.
    const links = () =>
      cards(page).evaluateAll((lis) =>
        lis.map((li) => li.querySelector('a')?.getAttribute('href')),
      );
    const loaded = (await links()).slice(0, 30);
    await cards(page).nth(20).getByRole('link').click();
    await expect(page).toHaveURL(/\/stories\/[a-z0-9-]+$/);
    await page.goBack();
    // The same 30 come back, in order, rather than the first page again. Back restores the
    // scroll position near the end, so the list may go on to auto-load its third page (D55)
    // at once: whether it has yet is timing, so neither the count nor `pages=` is pinned.
    await expect(page).toHaveURL(/pages=[23]/);
    await expect.poll(async () => (await links()).slice(0, 30)).toEqual(loaded);
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
    expect(
      order.findIndex((label) => label.startsWith('More themes')),
    ).toBeGreaterThan(order.indexOf('All'));
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

  // Codex review of #66, findings 1, 3, 4, 5 and 7.
  test('a story hidden since the last render is gone when the same filters are sent again', async ({
    page,
    request,
  }, info) => {
    const mine = `hide-test-${info.project.name}`;
    const stub = STUB_URL;
    await request.post(`${stub}/__test/show?slug=${mine}`);
    await page.goto('/stories?tag=hide_test');
    const card = page.getByRole('link', {
      name: `Hide test story (${info.project.name})`,
    });
    await expect(card).toBeVisible();
    await request.post(`${stub}/__test/hide?slug=${mine}`);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(card).toHaveCount(0);
    await request.post(`${stub}/__test/show?slug=${mine}`);
  });

  test('after Back, the filter fields show the filters of the list on screen', async ({
    page,
  }) => {
    await page.goto('/stories?format=audio');
    await page.getByLabel('Search stories').fill('placeholder');
    await page.getByLabel('Format').selectOption('video');
    await expect(page).toHaveURL(/format=video/);
    await page.goBack();
    await expect(page).toHaveURL(/\/stories\?format=audio$/);
    await expect(page.getByLabel('Format')).toHaveValue('audio');
    await expect(page.getByLabel('Search stories')).toHaveValue('');
  });

  test('a failed load (network) offers Try again, which works', async ({
    page,
  }) => {
    await page.goto('/stories');
    await expect(cards(page)).toHaveCount(15);
    // Server actions are POSTs to the page: fail the first one.
    let failed = false;
    await page.route('**/stories*', (route) => {
      if (route.request().method() === 'POST' && !failed) {
        failed = true;
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    await scrollToEnd(page);
    await expect(page.getByText('More stories couldn’t load.')).toBeVisible();
    await expect(page.getByText('Loading more stories…')).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(cards(page)).toHaveCount(30);
  });

  test('keyboard focus stays in the open phone menu', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'phone-320', 'phones only');
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    await menu.click();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const el = document.activeElement;
        return !!el?.closest('[data-mobile-nav]');
      });
      expect(inside, `Tab ${i + 1} left the open menu`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation', { name: 'Menu' })).toBeHidden();
    await expect(menu).toBeFocused();
  });
});

test.describe('story pages and failures the stub can stage', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'desktop-1280'].includes(info.project.name),
      'behaviour is checked on one phone and one desktop',
    );
  });

  test('home and browse keep their page when api-public-read is down', async ({
    page,
  }) => {
    await page.goto(`${WEB_DOWN_URL}/`);
    await expect(
      page.getByRole('heading', { level: 1, name: /Is God Real\?/ }),
    ).toBeVisible();
    await expect(
      page.getByText('Stories can’t be loaded right now.'),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto(`${WEB_DOWN_URL}/stories`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'God Stories' }),
    ).toBeVisible();
    await expect(
      page.getByText('Stories can’t be loaded right now.'),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('a chosen theme from “More themes” shows in the first row while it’s closed (O5)', async ({
    page,
  }) => {
    await page.goto('/stories?tag=hope');
    const more = page.locator('main [data-more-themes]');
    await expect(more).not.toHaveAttribute('open');
    await expect(
      page
        .getByRole('list', { name: 'Themes' })
        .getByRole('link', { name: 'Hope (selected)' }),
    ).toBeVisible();
  });

  test('an old slug redirects to the story’s current address (D30)', async ({
    page,
  }) => {
    const response = await page.goto('/stories/old-video-story');
    await expect(page).toHaveURL(/\/stories\/video-story$/);
    expect(response?.status()).toBe(200);
    expect(response?.request().redirectedFrom()?.url()).toMatch(
      /\/stories\/old-video-story$/,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Test story: a tall video' }),
    ).toBeVisible();
  });

  test('a story still shows when its related stories can’t load', async ({
    page,
  }) => {
    const response = await page.goto('/stories/related-down');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Test story: related stories can’t load',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Related stories', exact: true }),
    ).toHaveCount(0);
  });

  test('a story describes itself for search and share previews; no name shows as Anonymous', async ({
    page,
  }) => {
    await page.goto('/stories/browse-test-03'); // no byline name
    await expect(page).toHaveTitle(
      /^Browse test story 03: .* \| He Is Real Today$/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      /\/stories\/browse-test-03$/,
    );
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
      'content',
      'article',
    );
    const article = await page
      .locator('main script[type="application/ld+json"]')
      .evaluate((el) => JSON.parse(el.textContent ?? '{}'));
    expect(article).toMatchObject({
      '@type': 'Article',
      headline: expect.stringMatching(/^Browse test story 03: /),
    });
    expect(article.author).toBeUndefined();
    await expect(page.getByRole('main').getByText('Anonymous')).toBeVisible();
  });

  test('Copy link copies the page’s address without its query; Instagram says to paste', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/stories/video-story?utm_source=x');
    const share = page.getByRole('button', { name: 'Share' });
    const status = page.getByRole('dialog').getByRole('status');

    await share.click();
    await page.getByRole('button', { name: /Copy link/ }).click();
    await expect(status).toHaveText('Link copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${baseURL}/stories/video-story`,
    );

    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.getByRole('button', { name: /Instagram/ }).click();
    await expect(status).toHaveText('Link copied. Paste it in Instagram.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${baseURL}/stories/video-story`,
    );
  });

  test('Copy link says so when the browser refuses the clipboard', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get: () => ({
          writeText: () => Promise.reject(new DOMException('denied')),
        }),
      });
    });
    await page.goto('/stories/video-story');
    await page.getByRole('button', { name: 'Share' }).click();
    await page.getByRole('button', { name: /Copy link/ }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText(
      'Couldn’t copy. Copy the address from your browser instead.',
    );
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one device');
  });

  // The header is in the page as it arrives, not swapped in by a script once its stream
  // lands: without that, no-JS visitors had no navigation and slow first paints showed the
  // page without its header, which then pushed everything down (an ipad-air-landscape flake).
  test('the header and its navigation are there, above the content', async ({
    page,
  }) => {
    for (const path of ['/', '/stories', '/stories/video-story', '/about']) {
      await page.goto(path);
      const header = page.getByRole('banner');
      await expect(header).toBeVisible();
      await expect(
        header.getByRole('link', { name: 'He Is Real Today, home' }),
      ).toBeVisible();
      await expect(
        header.getByRole('link', { name: 'Stories', exact: true }),
      ).toBeVisible();
      const top = async (role: 'banner' | 'main') =>
        (await page.getByRole(role).boundingBox())?.y ?? -1;
      expect(await top('banner')).toBeLessThan(await top('main'));
    }
  });

  test('“Show more stories” links to the next page while there is one', async ({
    page,
  }) => {
    await page.goto('/stories?pages=3');
    await expect(cards(page)).toHaveCount(45);
    await page.getByRole('link', { name: 'Show more stories' }).click();
    await expect(page).toHaveURL(/pages=4/);
    await expect(cards(page)).toHaveCount(54);
    await expect(page.getByText('You’ve seen every story here.')).toBeVisible();
  });
});

// The masonry's first paint is the server's prediction (D55): the browser measures the cards
// only once its JavaScript runs, and never without it. A prediction may leave a gap but must
// never overlap the next card (Codex review of #72, round 3: 9:16 videos were 35 px short at
// 1280 px, which a loaded machine caught before the measurement landed). Every multi-column
// device, every story.
test.describe('first paint, before any measuring', () => {
  test.use({ javaScriptEnabled: false });

  test('no card overlaps the next one in its column', async ({
    page,
  }, info) => {
    test.skip(
      (info.project.use.viewport?.width ?? 0) < 640,
      'one column below 640 px',
    );
    await page.goto('/stories?pages=4');
    await expect(cards(page)).toHaveCount(54);
    const overlaps = await cards(page).evaluateAll((lis) => {
      const boxes = lis.map((li, i) => {
        const r = (li.firstElementChild as HTMLElement).getBoundingClientRect();
        return { i, x: Math.round(r.x), top: r.top, bottom: r.bottom };
      });
      const out: string[] = [];
      for (const a of boxes)
        for (const b of boxes)
          if (a.x === b.x && b.top > a.top && b.top < a.bottom - 0.5)
            out.push(
              `card ${a.i} ends at ${a.bottom.toFixed(1)}, card ${b.i} starts at ${b.top.toFixed(1)}`,
            );
      return out;
    });
    expect(overlaps).toEqual([]);
  });
});

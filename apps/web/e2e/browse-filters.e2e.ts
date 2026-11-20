import { expect, type Page, test } from '@playwright/test';
import {
  browseFilters,
  chooseOption,
  expectAllTargets,
  expectNoHorizontalOverflow,
  shots,
} from './helpers';

// The Stories page's filters (BS-1 C, Joel 2026-11-20: "for compact search implement option
// C"). On a computer (content 70rem wide or more) "Favourites only", sort, format and every theme are a
// column beside the stories, and only the search box sits above them. On tablets and phones a
// "Filters" button beside the search box opens them in a panel, and what's chosen shows under
// the search box as removable chips, with a count on the button. Everything stays in the address.

/** One phone and one tablet: the panel. */
const PANEL_DEVICES = ['phone-320', 'ipad-mini-portrait'];

const filtersButton = (page: Page) =>
  page.getByRole('button', { name: /^Filters/ });
const chips = (page: Page) =>
  page.getByRole('list', { name: 'Chosen filters' });

test.describe('tablets and phones: the Filters panel', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !PANEL_DEVICES.includes(info.project.name),
      'one phone and one tablet',
    );
  });

  test('opens from the button, chooses, shows chips, and gives focus back', async ({
    page,
  }) => {
    await page.goto('/stories');
    const button = filtersButton(page);
    await expect(button).toHaveAccessibleName('Filters');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(chips(page)).toHaveCount(0);
    // The filters aren't on the page until the panel opens.
    await expect(page.getByLabel('Format', { exact: true })).toBeHidden();

    const panel = await browseFilters(page);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // Focus moves into the panel.
    await expect(
      panel.getByRole('button', { name: 'Close filters' }),
    ).toBeFocused();

    // A theme and a format: each applies at once, and the panel stays open for the next.
    await panel.getByRole('link', { name: 'Hope' }).click();
    await expect(page).toHaveURL(/\/stories\?theme=hope$/);
    await expect(panel.getByRole('link', { name: 'Hope' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await chooseOption(panel.getByLabel('Format', { exact: true }), 'Video');
    await expect(page).toHaveURL(/[?&]format=video(&|$)/);
    await expect(page).toHaveURL(/[?&]theme=hope(&|$)/);
    await expect(panel).toBeVisible();
    // Sort: radio buttons, as the moderators' list's (Joel, 2026-11-20).
    const sort = panel.getByRole('group', { name: 'Sort' });
    await sort.locator('label').filter({ hasText: 'Oldest first' }).click();
    await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
    await expect(
      sort.getByRole('radio', { name: 'Oldest first' }),
    ).toBeChecked();

    await panel.getByRole('button', { name: 'Show stories' }).click();
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toHaveAccessibleName('Filters (3 on)');
    await expect(chips(page).getByRole('link')).toHaveText([
      'Remove Hope',
      'Remove Video',
      'Remove Oldest first',
      'Clear all',
    ]);
    await expect(page.getByText('Video stories about Hope')).toBeVisible();
  });

  test('a chip removes its filter, Clear all removes every one, and the address keeps them', async ({
    page,
  }) => {
    // Straight from an address: the chips are the address's filters.
    await page.goto('/stories?theme=hope&format=video&sort=oldest');
    await expect(chips(page).getByRole('link')).toHaveText([
      'Remove Hope',
      'Remove Video',
      'Remove Oldest first',
      'Clear all',
    ]);
    await expect(filtersButton(page)).toHaveAccessibleName('Filters (3 on)');

    await chips(page).getByRole('link', { name: 'Remove Hope' }).click();
    await expect(page).toHaveURL(/\/stories\?format=video&sort=oldest$/);
    await expect(chips(page).getByRole('link')).toHaveText([
      'Remove Video',
      'Remove Oldest first',
      'Clear all',
    ]);
    // Back brings it back, chip and all.
    await page.goBack();
    await expect(page).toHaveURL(/theme=hope/);
    await expect(
      chips(page).getByRole('link', { name: 'Remove Hope' }),
    ).toBeVisible();

    // A search isn't a filter in the panel: Clear all keeps it.
    await page.goto('/stories?q=test&format=audio');
    await chips(page).getByRole('link', { name: 'Clear all' }).click();
    await expect(page).toHaveURL(/\/stories\?q=test$/);
    await expect(chips(page)).toHaveCount(0);
    await expect(filtersButton(page)).toHaveAccessibleName('Filters');
    await expect(page.getByLabel('Search stories')).toHaveValue('test');
  });

  test('Escape closes the panel and gives focus back; Clear all works inside it', async ({
    page,
  }) => {
    await page.goto('/stories?theme=hope&format=audio');
    const panel = await browseFilters(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(filtersButton(page)).toBeFocused();

    await filtersButton(page).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('link', { name: 'Clear all' }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await expect(panel.getByRole('link', { name: 'Clear all' })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: 'Hope' })).not.toHaveAttribute(
      'aria-current',
    );
    await page.keyboard.press('Escape');
    await expect(filtersButton(page)).toBeFocused();
    await expect(chips(page)).toHaveCount(0);
  });

  test('Favourites only is in the panel and shows as a chip', async ({
    page,
  }) => {
    await page.goto('/stories?theme=hope');
    const panel = await browseFilters(page);
    const only = panel.getByRole('switch', { name: 'Favourites only' });
    await only.click();
    await expect(only).toBeChecked();
    await expect(page).toHaveURL(/\/stories\?theme=hope&favourites=1$/);
    await panel.getByRole('button', { name: 'Show stories' }).click();
    await expect(filtersButton(page)).toHaveAccessibleName('Filters (2 on)');
    // A chip's link keeps Favourites only on.
    await expect(
      chips(page).getByRole('link', { name: 'Remove Hope' }),
    ).toHaveAttribute('href', '/stories?favourites=1');
    await chips(page)
      .getByRole('button', { name: 'Remove Favourites only' })
      .click();
    await expect(page).toHaveURL(/\/stories\?theme=hope$/);
    await expect(filtersButton(page)).toHaveAccessibleName('Filters (1 on)');
  });
});

test.describe('computers: the filters column', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one computer');
  });

  test('every filter sits in a column beside the stories, only the search above them, no chips', async ({
    page,
  }) => {
    await page.goto('/stories?theme=hope&format=video');
    const column = page.getByRole('complementary', { name: 'Filters' });
    await expect(column.getByRole('group', { name: 'Sort' })).toBeVisible();
    await expect(column.getByLabel('Format', { exact: true })).toBeVisible();
    await expect(
      column
        .getByRole('navigation', { name: 'Themes' })
        .getByRole('link', { name: 'Hope' }),
    ).toHaveAttribute('aria-current', 'true');
    await expect(
      column.getByRole('switch', { name: 'Favourites only' }),
    ).toBeVisible();
    await expect(filtersButton(page)).toBeHidden();
    await expect(chips(page)).toBeHidden();

    // The column is to the left of the search box and the stories; the search box is the only
    // control above them.
    const box = async (selector: string) =>
      (await page.locator(selector).first().boundingBox()) ?? {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
    const side = await box('[data-filters-column]');
    const search = await box('form[role="search"]');
    const first = await box('main ul.masonry > li');
    expect(side.x + side.width).toBeLessThan(search.x);
    expect(side.x + side.width).toBeLessThan(first.x);
    expect(search.y + search.height).toBeLessThan(first.y);
  });
});

test.describe('computers: sort', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one computer');
  });

  // Joel, 2026-11-20: "can we set sort to be radio buttons for sorting on the public search
  // instead of pills in the same way as the moderator view?"
  test('sort is radio buttons, as the moderators’ list’s, kept in the address; arrow keys choose too', async ({
    page,
  }) => {
    await page.goto('/stories');
    const titles = page.locator('main article h3');
    const latestFirst = await titles.allTextContents();
    expect(latestFirst.length).toBeGreaterThan(1);
    const sort = page
      .getByRole('complementary', { name: 'Filters' })
      .getByRole('group', { name: 'Sort' });
    const radios = sort.getByRole('radio');
    await expect(radios).toHaveCount(2);
    await expect(sort.locator('label')).toHaveText([
      'Latest first',
      'Oldest first',
    ]);
    await expect(
      sort.getByRole('radio', { name: 'Latest first' }),
    ).toBeChecked();
    for (const line of await sort.locator('label').all()) {
      const box = await line.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44 - 0.01);
    }

    await sort.locator('label').filter({ hasText: 'Oldest first' }).click();
    await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
    await expect(
      sort.getByRole('radio', { name: 'Oldest first' }),
    ).toBeChecked();
    await expect(titles.first()).not.toHaveText(latestFirst[0]);

    // The keyboard: an arrow key moves the choice, which applies it.
    await page.reload();
    await expect(page.locator('[data-favourites-only]')).toBeAttached();
    await sort.getByRole('radio', { name: 'Oldest first' }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(page).toHaveURL(/[?&]sort=latest(&|$)/);
    await expect(titles.first()).toHaveText(latestFirst[0]);

    // With a search, Best match joins them (and is the first choice).
    await page.goto('/stories?q=test');
    await expect(sort.locator('label')).toHaveText([
      'Best match',
      'Latest first',
      'Oldest first',
    ]);
    await expect(sort.getByRole('radio', { name: 'Best match' })).toBeChecked();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the open Filters panel fits the screen, with 44 px targets', async ({
      page,
    }, info) => {
      await page.goto('/stories?theme=hope&format=video');
      test.skip(
        !(await filtersButton(page).isVisible()),
        'computers have the column instead',
      );
      const panel = await browseFilters(page);
      const viewport = page.viewportSize() ?? { width: 0, height: 0 };
      const at = (await panel.boundingBox()) ?? {
        x: -1,
        y: -1,
        width: 0,
        height: 0,
      };
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x + at.width).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(at.y + at.height).toBeLessThanOrEqual(viewport.height + 0.5);
      // Its buttons stay reachable: the filters scroll inside it.
      await expect(
        panel.getByRole('button', { name: 'Show stories' }),
      ).toBeInViewport();
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'browse-filters-open');
    });
  });
}

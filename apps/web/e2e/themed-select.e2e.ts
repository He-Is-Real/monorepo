import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalOverflow,
  expectTarget,
  MIN_TARGET,
} from './helpers';

// Themed dropdowns (Joel, 2026-10-24: "the drop down menus look dated, bring them in line with
// the site theme"). They stay native <select>s, so the browse form works without JavaScript and
// keeps the keyboard behaviour browsers give them. The closed select has the theme's field and
// chevron everywhere; in Chromium the open list is styled too (customizable select:
// `appearance: base-select`, `::picker(select)`), in the theme's colours, light and dark.

/** A colour as the browser computes it, from any CSS colour (custom properties included). */
const colour = (page: Page, css: string) =>
  page.evaluate((value) => {
    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, css);

const pickerStyle = (select: Locator) =>
  select.evaluate((el) => {
    const s = getComputedStyle(el, '::picker(select)');
    return {
      open: el.matches(':open'),
      background: s.backgroundColor,
      color: s.color,
      radius: parseFloat(s.borderTopLeftRadius),
    };
  });

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the closed selects use the theme’s field and chevron', async ({
      page,
    }) => {
      await page.goto('/stories');
      for (const name of ['Sort', 'Format']) {
        const select = page.getByLabel(name, { exact: true });
        await expectTarget(page, select);
        const style = await select.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            appearance: s.appearance,
            background: s.backgroundColor,
            color: s.color,
          };
        });
        expect(['none', 'base-select']).toContain(style.appearance);
        expect(style.background).toBe(
          await colour(page, 'var(--input-background)'),
        );
        expect(style.color).toBe(await colour(page, 'var(--foreground)'));
        // The theme's chevron, not the browser's.
        await expect(
          select.locator('xpath=..').locator('svg[data-chevron]'),
        ).toBeVisible();
      }
    });

    test('the open list uses the theme’s colours, with 44 px options', async ({
      page,
    }) => {
      await page.goto('/stories');
      const select = page.getByLabel('Format', { exact: true });
      await select.click();
      const picker = await pickerStyle(select);
      expect(picker.open).toBe(true);
      expect(picker.background).toBe(await colour(page, 'var(--popover)'));
      expect(picker.color).toBe(
        await colour(page, 'var(--popover-foreground)'),
      );
      expect(picker.radius).toBeGreaterThanOrEqual(8);

      const options = select.locator('option');
      const width = page.viewportSize()?.width ?? 0;
      for (const option of await options.all()) {
        const box = await option.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
        // The list fits on the screen, also on a 320 px phone.
        expect(
          (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
        ).toBe(true);
      }
      // The chosen option is marked in the theme's teal.
      const checked = select.locator('option:checked');
      expect(await checked.evaluate((el) => getComputedStyle(el).color)).toBe(
        await colour(page, 'var(--link)'),
      );
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press('Escape');
      expect((await pickerStyle(select)).open).toBe(false);
    });
  });
}

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'ipad-mini-portrait', 'desktop-1280'].includes(
        info.project.name,
      ),
      'checked on a phone, a tablet and a desktop',
    );
  });

  test('choosing from the keyboard applies the filter, as before', async ({
    page,
  }) => {
    await page.goto('/stories');
    const format = page.getByLabel('Format', { exact: true });
    await format.focus();
    await page.keyboard.press('Enter');
    expect((await pickerStyle(format)).open).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/stories\?.*format=video/);
    await expect(page.getByText('Video stories')).toBeVisible();
    await expect(page.getByLabel('Format', { exact: true })).toHaveValue(
      'video',
    );
  });

  test('choosing with a pointer applies the filter', async ({ page }) => {
    await page.goto('/stories');
    const sort = page.getByLabel('Sort', { exact: true });
    await sort.click();
    await sort.getByRole('option', { name: 'Oldest first' }).click();
    await expect(page).toHaveURL(/sort=oldest/);
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one device');
  });

  test('the selects still submit with the form', async ({ page }) => {
    await page.goto('/stories');
    await page.getByLabel('Format', { exact: true }).selectOption('audio');
    await page.getByLabel('Sort', { exact: true }).selectOption('oldest');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/format=audio/);
    await expect(page).toHaveURL(/sort=oldest/);
    await expect(page.getByText('Audio stories')).toBeVisible();
  });
});

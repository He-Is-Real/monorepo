import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalOverflow,
  expectTarget,
  expectAtLeastTarget,
} from './helpers';

// Themed dropdowns (Joel, 2026-10-24: "the drop down menus look dated, bring them in line with
// the site theme"). They stay native <select>s, so the browse form works without JavaScript and
// keeps the keyboard behaviour browsers give them. The closed select has the theme's field and
// chevron everywhere. On computers (a mouse or trackpad) the open list is styled too, in
// Chromium (customizable select: `appearance: base-select`, `::picker(select)`), in the theme's
// colours, light and dark. Phones and tablets keep their own picker (Joel, U3 = A).

/** The device matrix's touch devices (phones, tablets): their own picker, not the themed list. */
const touch = (info: { project: { use: { hasTouch?: boolean } } }) =>
  !!info.project.use.hasTouch;

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

/** The open list has finished its opening transition (sizes are final). */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished)),
  );

/**
 * An option's text and focus ring against what is really behind them: its own background (a
 * translucent tint) composited on the picker's surface, through a 1 px canvas. WCAG 2.1
 * contrast ratios.
 */
const optionContrast = async (select: Locator, option: Locator) =>
  option.evaluate(
    (el, sel) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2D canvas');
      const paint = (...colours: string[]) => {
        ctx.clearRect(0, 0, 1, 1);
        for (const c of colours) {
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
        }
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: number[], b: number[]) => {
        const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
        return (x + 0.05) / (y + 0.05);
      };
      const pickerBg = getComputedStyle(
        sel as Element,
        '::picker(select)',
      ).backgroundColor;
      const s = getComputedStyle(el);
      const behind = paint(pickerBg, s.backgroundColor);
      return {
        focusVisible: el.matches(':focus-visible'),
        text: ratio(paint(pickerBg, s.backgroundColor, s.color), behind),
        outline: {
          style: s.outlineStyle,
          width: parseFloat(s.outlineWidth),
          offset: parseFloat(s.outlineOffset),
          ratio: ratio(paint(pickerBg, s.outlineColor), paint(pickerBg)),
        },
      };
    },
    await select.elementHandle(),
  );

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the closed selects use the theme’s field and chevron', async ({
      page,
    }, info) => {
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
        // Touch screens: a plain styled select, so the system picker opens (U3).
        expect(style.appearance).toBe(touch(info) ? 'none' : 'base-select');
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
    }, info) => {
      test.skip(touch(info), 'touch screens keep their own picker (U3)');
      await page.goto('/stories');
      const select = page.getByLabel('Format', { exact: true });
      await select.click();
      await settled(page);
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
        expectAtLeastTarget(box?.height, 'option height');
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
      // Hovered, the chosen option stays readable on the tint (4.5:1 for 14 px text).
      await checked.hover();
      expect(
        (await optionContrast(select, checked)).text,
      ).toBeGreaterThanOrEqual(4.5);
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press('Escape');
      expect((await pickerStyle(select)).open).toBe(false);
    });

    test('keyboard focus in the open list shows the site’s focus ring, and text stays readable', async ({
      page,
    }, info) => {
      test.skip(touch(info), 'touch screens keep their own picker (U3)');
      await page.goto('/stories');
      const select = page.getByLabel('Format', { exact: true });
      await select.focus();
      await page.keyboard.press('Enter');
      expect((await pickerStyle(select)).open).toBe(true);
      await settled(page);
      // The chosen option has focus first; then the next one.
      for (const option of [
        select.locator('option:checked'),
        select.locator('option').nth(1),
      ]) {
        if (!(await option.evaluate((el) => el.matches(':checked'))))
          await page.keyboard.press('ArrowDown');
        await expect(option).toBeFocused();
        const c = await optionContrast(select, option);
        expect(c.focusVisible).toBe(true);
        expect(c.outline.style).toBe('solid');
        expect(c.outline.width).toBeGreaterThanOrEqual(2);
        // Inside the option (the site-wide ring sits 2 px outside, under the next option).
        expect(
          c.outline.offset + c.outline.width,
          'ring inside the option',
        ).toBeLessThanOrEqual(0);
        expect(
          c.outline.ratio,
          'focus ring on the picker',
        ).toBeGreaterThanOrEqual(3);
        expect(c.text, 'text on the tint').toBeGreaterThanOrEqual(4.5);
      }
      await page.keyboard.press('Escape');
    });
  });
}

test.describe('on phones and tablets (U3)', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(!touch(info), 'touch screens only');
  });

  test('the select opens the system picker, and choosing applies the filter', async ({
    page,
  }) => {
    await page.goto('/stories');
    // The emulated device really is a touch screen without hover.
    expect(
      await page.evaluate(
        () => matchMedia('(hover: hover) and (pointer: fine)').matches,
      ),
    ).toBe(false);
    const format = page.getByLabel('Format', { exact: true });
    const appearance = await format.evaluate((el) => ({
      select: getComputedStyle(el).appearance,
      picker: getComputedStyle(el, '::picker(select)').appearance,
    }));
    expect(appearance.select).toBe('none');
    expect(appearance.picker).not.toBe('base-select');
    // What the system picker does: set the value, which applies the filter.
    await format.selectOption('video');
    await expect(page).toHaveURL(/\/stories\?.*format=video/);
    await expect(page.getByText('Video stories')).toBeVisible();
  });
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      info.project.name !== 'desktop-1280',
      'the themed list: computers only (U3)',
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
    await settled(page);
    // Click where the open option is, as a person would: Playwright's own scrolling to an
    // option in the picker's top layer can lose it (Codex, #78).
    const box = await sort
      .getByRole('option', { name: 'Oldest first' })
      .boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await expect(page).toHaveURL(/sort=oldest/);
  });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      info.project.name !== 'desktop-1280',
      'the themed list: computers only (U3)',
    );
  });

  test('the open list appears without its fade', async ({ page }) => {
    await page.goto('/stories');
    const select = page.getByLabel('Format', { exact: true });
    await select.click();
    expect((await pickerStyle(select)).open).toBe(true);
    const durations = await select.evaluate((el) =>
      getComputedStyle(el, '::picker(select)')
        .transitionDuration.split(',')
        .map((d) => parseFloat(d)),
    );
    expect(durations.every((d) => d === 0)).toBe(true);
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

import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  expectAtLeastTarget,
  expectChosen,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';

// The site's drop-down (`Select`, libs/web-ui). Joel, 2026-10-24: "the drop down menus look
// dated, bring them in line with the site theme"; 2026-11-17: the styled drop-down is the
// default for every drop-down, in every browser. Closed, it's the theme's field and chevron
// everywhere. On computers (a mouse or trackpad), once the page's JavaScript runs, the open list
// is the themed one (Radix Select) in every browser, light and dark. Before that and without
// JavaScript it's a native <select>, so the browse form works without JavaScript; phones and
// tablets keep the native one and their own picker (Joel, U3 = A).

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

/** The control once the page's JavaScript has run: the themed list's button on a computer. */
async function hydrated(control: Locator, info: Parameters<typeof touch>[0]) {
  await expect(control).toHaveAttribute(
    'data-slot',
    touch(info) ? 'select-native' : 'select-trigger',
  );
  return control;
}

/** The open list has finished its opening animation (sizes are final). */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished)),
  );

/**
 * An option's text and focus ring against what is really behind them: its own background (a
 * translucent tint) composited on the list's surface, through a 1 px canvas. WCAG 2.1 contrast
 * ratios.
 */
const optionContrast = async (list: Locator, option: Locator) =>
  option.evaluate(
    (el, listEl) => {
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
      const surface = getComputedStyle(listEl as Element).backgroundColor;
      const s = getComputedStyle(el);
      const behind = paint(surface, s.backgroundColor);
      return {
        focusVisible: el.matches(':focus-visible'),
        text: ratio(paint(surface, s.backgroundColor, s.color), behind),
        outline: {
          style: s.outlineStyle,
          width: parseFloat(s.outlineWidth),
          offset: parseFloat(s.outlineOffset),
          ratio: ratio(paint(surface, s.outlineColor), paint(surface)),
        },
      };
    },
    await list.elementHandle(),
  );

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the closed drop-downs use the theme’s field and chevron', async ({
      page,
    }, info) => {
      await page.goto('/stories');
      for (const name of ['Sort', 'Format']) {
        const control = await hydrated(
          page.getByLabel(name, { exact: true }),
          info,
        );
        await expectTarget(page, control);
        const style = await control.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            appearance: s.appearance,
            background: s.backgroundColor,
            color: s.color,
          };
        });
        // Touch screens: a plain styled select, so the system picker opens (U3).
        if (touch(info)) expect(style.appearance).toBe('none');
        expect(style.background).toBe(
          await colour(page, 'var(--input-background)'),
        );
        expect(style.color).toBe(await colour(page, 'var(--foreground)'));
        // The theme's chevron, not the browser's.
        await expect(
          control.locator('xpath=..').locator('svg[data-chevron]'),
        ).toBeVisible();
      }
    });

    test('the open list uses the theme’s colours, with 44 px options', async ({
      page,
    }, info) => {
      test.skip(touch(info), 'touch screens keep their own picker (U3)');
      await page.goto('/stories');
      const control = await hydrated(
        page.getByLabel('Format', { exact: true }),
        info,
      );
      await control.click();
      const list = page.getByRole('listbox');
      await expect(list).toBeVisible();
      await settled(page);
      const surface = await list.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          background: s.backgroundColor,
          color: s.color,
          radius: parseFloat(s.borderTopLeftRadius),
        };
      });
      expect(surface.background).toBe(await colour(page, 'var(--popover)'));
      expect(surface.color).toBe(
        await colour(page, 'var(--popover-foreground)'),
      );
      expect(surface.radius).toBeGreaterThanOrEqual(8);

      const width = page.viewportSize()?.width ?? 0;
      for (const option of await list.getByRole('option').all()) {
        const box = await option.boundingBox();
        expectAtLeastTarget(box?.height, 'option height');
        // The list fits on the screen.
        expect(
          (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
        ).toBe(true);
      }
      // The chosen option is marked in the theme's teal, with a check mark (with the pointer on
      // another option: the one under the pointer is tinted).
      const checked = list.locator('[role=option][data-state=checked]');
      await expect(checked).toHaveText('All formats');
      await list.getByRole('option').nth(1).hover();
      expect(await checked.evaluate((el) => getComputedStyle(el).color)).toBe(
        await colour(page, 'var(--link)'),
      );
      await expect(checked.locator('svg')).toBeVisible();
      // Hovered, the chosen option stays readable on the tint (4.5:1 for 14 px text).
      await checked.hover();
      expect((await optionContrast(list, checked)).text).toBeGreaterThanOrEqual(
        4.5,
      );
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
    });

    test('keyboard focus in the open list shows the site’s focus ring, and text stays readable', async ({
      page,
    }, info) => {
      test.skip(touch(info), 'touch screens keep their own picker (U3)');
      await page.goto('/stories');
      const control = await hydrated(
        page.getByLabel('Format', { exact: true }),
        info,
      );
      await control.focus();
      await page.keyboard.press('Enter');
      const list = page.getByRole('listbox');
      await expect(list).toBeVisible();
      await settled(page);
      const options = list.getByRole('option');
      // The chosen option has focus first; then the next one.
      for (const [i, option] of [options.nth(0), options.nth(1)].entries()) {
        if (i > 0) await page.keyboard.press('ArrowDown');
        await expect(option).toBeFocused();
        const c = await optionContrast(list, option);
        expect(c.focusVisible).toBe(true);
        expect(c.outline.style).toBe('solid');
        expect(c.outline.width).toBeGreaterThanOrEqual(2);
        // Inside the option, not under the next one.
        expect(
          c.outline.offset + c.outline.width,
          'ring inside the option',
        ).toBeLessThanOrEqual(0);
        expect(
          c.outline.ratio,
          'focus ring on the list',
        ).toBeGreaterThanOrEqual(3);
        expect(c.text, 'text on the tint').toBeGreaterThanOrEqual(4.5);
      }
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
      // Focus goes back to the drop-down.
      await expect(control).toBeFocused();
    });
  });
}

test.describe('on phones and tablets (U3)', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(!touch(info), 'touch screens only');
  });

  test('the drop-down is a native select that opens the system picker, and choosing applies the filter', async ({
    page,
  }, info) => {
    await page.goto('/stories');
    // The emulated device really is a touch screen.
    expect(
      await page.evaluate(
        () => matchMedia('(hover: none), (pointer: coarse)').matches,
      ),
    ).toBe(true);
    const format = await hydrated(
      page.getByLabel('Format', { exact: true }),
      info,
    );
    expect(await format.evaluate((el) => el.tagName)).toBe('SELECT');
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

  test('choosing from the keyboard applies the filter', async ({
    page,
  }, info) => {
    await page.goto('/stories');
    const format = await hydrated(
      page.getByLabel('Format', { exact: true }),
      info,
    );
    await format.focus();
    await page.keyboard.press('Enter');
    // The list opens with the chosen option focused.
    await expect(
      page.getByRole('listbox').getByRole('option', { name: 'All formats' }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/stories\?.*format=video/);
    await expect(page.getByText('Video stories')).toBeVisible();
    await expectChosen(page.getByLabel('Format', { exact: true }), 'Video');
  });

  test('choosing with a mouse reloads the stories sorted', async ({
    page,
  }, info) => {
    await page.goto('/stories');
    const titles = page.locator('main article h3');
    const latestFirst = await titles.allTextContents();
    expect(latestFirst.length).toBeGreaterThan(1);
    const sort = await hydrated(page.getByLabel('Sort', { exact: true }), info);
    await sort.click();
    await page
      .getByRole('listbox')
      .getByRole('option', { name: 'Oldest first' })
      .click();
    await expect(page).toHaveURL(/sort=oldest/);
    await expectChosen(
      page.getByLabel('Sort', { exact: true }),
      'Oldest first',
    );
    // The oldest story now comes first.
    await expect(titles.first()).not.toHaveText(latestFirst[0]);
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

  test('the open list appears without its animation', async ({
    page,
  }, info) => {
    await page.goto('/stories');
    const control = await hydrated(
      page.getByLabel('Format', { exact: true }),
      info,
    );
    await control.click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    // Radix puts the list inside a positioning wrapper; the animation is on the list's panel.
    const animation = await list.evaluate((el) => {
      const panel = el.closest('[data-state]') ?? el;
      return getComputedStyle(panel).animationName;
    });
    expect(animation).toBe('none');
  });
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one device');
  });

  test('the native drop-downs still submit with the form', async ({ page }) => {
    await page.goto('/stories');
    await page.getByLabel('Format', { exact: true }).selectOption('audio');
    await page.getByLabel('Sort', { exact: true }).selectOption('oldest');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/format=audio/);
    await expect(page).toHaveURL(/sort=oldest/);
    await expect(page.getByText('Audio stories')).toBeVisible();
  });
});

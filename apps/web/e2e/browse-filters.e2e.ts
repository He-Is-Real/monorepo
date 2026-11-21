import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  browseFilters,
  chooseOption,
  closeBrowseFilters,
  expectAllTargets,
  expectNoHorizontalOverflow,
  shots,
  storiesColumns,
} from './helpers';

// The Stories page's filters (BS-1 C, Joel 2026-11-20: "for compact search implement option
// C"). From 1024 px screens (BS-5 B, Joel 2026-11-21) "Favourites only", sort, format and every
// theme are a column beside the stories, and only the search box sits above them. On portrait
// tablets and phones a "Filters" button beside the search box opens them in a panel, and what's
// chosen shows under the search box as removable chips, with a count on the button. Themes stack
// (BS-6 B): a story shows only if it has every chosen theme. Everything stays in the address.

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
    // The chosen chip has the ✓ (CH-1 A); the others don't.
    await expect(
      panel.getByRole('link', { name: 'Hope' }).locator('[data-chip-tick]'),
    ).toBeVisible();
    await expect(
      panel.getByRole('link', { name: 'Grief' }).locator('[data-chip-tick]'),
    ).toHaveCount(0);
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

// BS-5 B (Joel, 2026-11-21): the column from 1024 px screens (small laptops, landscape tablets);
// the Filters button below that (portrait tablets, phones). Beside the column the stories take 2
// columns until about 1200 px, then 3.
test.describe('where the column starts', () => {
  const AROUND_1024 = [
    'ipad-mini-portrait',
    'galaxy-z-fold5-unfolded',
    'ipad-pro-12.9-portrait',
    'ipad-air-landscape',
    'desktop-1280',
  ];
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !AROUND_1024.includes(info.project.name),
      'the screens either side of 1024 px',
    );
  });

  test('a column from 1024 px, the Filters button below it, and the stories’ columns beside it', async ({
    page,
  }, info) => {
    const width = info.project.use.viewport?.width ?? 0;
    await page.goto('/stories');
    await expect(page.locator('[data-favourites-only]')).toBeAttached();
    const column = page.locator('[data-filters-column]');
    if (width >= 1024) {
      await expect(column).toBeVisible();
      await expect(filtersButton(page)).toBeHidden();
    } else {
      await expect(column).toBeHidden();
      await expect(filtersButton(page)).toBeVisible();
    }
    const cards = page.locator('main ul.masonry > li');
    await expect(cards).toHaveCount(15);
    await expect
      .poll(() =>
        cards.evaluateAll(
          (lis) =>
            new Set(lis.map((li) => Math.round(li.getBoundingClientRect().x)))
              .size,
        ),
      )
      .toBe(storiesColumns(width));
    expect(storiesColumns(width)).toBe(
      width >= 1280 ? 3 : width >= 640 ? 2 : 1,
    );
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  });
});

// BS-5 B exactly at its edge (Codex, #259): 1023 px has the Filters button, 1024 px the column
// with 2 story columns beside it.
test('the column starts at exactly 1024 px', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one computer, resized');
  for (const [width, column] of [
    [1023, false],
    [1024, true],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/stories');
    await expect(page.locator('[data-favourites-only]')).toBeAttached();
    await expect(page.locator('[data-filters-column]'), `${width}`).toBeVisible(
      { visible: column },
    );
    await expect(filtersButton(page), `${width}`).toBeVisible({
      visible: !column,
    });
    const cards = page.locator('main ul.masonry > li');
    await expect(cards).toHaveCount(15);
    await expect
      .poll(() =>
        cards.evaluateAll(
          (lis) =>
            new Set(lis.map((li) => Math.round(li.getBoundingClientRect().x)))
              .size,
        ),
      )
      .toBe(2);
    await expectNoHorizontalOverflow(page);
  }
});

// Joel 2026-11-21: the browser's "Large" text (20 px) keeps the column on a desktop screen; from
// "Very large" (24 px) the Filters button takes over, so the stories aren't squeezed.
test('a desktop screen keeps the column at Large text, the Filters button from Very large', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one computer, resized');
  await page.setViewportSize({ width: 1920, height: 1000 });
  for (const [percent, column] of [
    ['125%', true],
    ['150%', false],
  ] as const) {
    await page.goto('/stories');
    await page.addStyleTag({
      content: `html { font-size: ${percent} !important; }`,
    });
    await expect(page.locator('[data-favourites-only]')).toBeAttached();
    await expect(page.locator('[data-filters-column]'), percent).toBeVisible({
      visible: column,
    });
    await expect(filtersButton(page), percent).toBeVisible({ visible: !column });
    await expectNoHorizontalOverflow(page);
  }
});

// BS-6 B (Joel, 2026-11-21): themes stack, and a story shows only if it has every chosen theme.
test.describe('stacked themes', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'desktop-1280'].includes(info.project.name),
      'one phone (the panel) and one computer (the column)',
    );
  });

  const cards = (page: Page) => page.locator('main article');
  const theme = (filters: Locator, name: string) =>
    filters
      .getByRole('navigation', { name: 'Themes' })
      .getByRole('link', { name, exact: true });

  test('each theme turns on and off on its own, only stories with every one show, and Clear themes clears them', async ({
    page,
  }) => {
    await page.goto('/stories');
    let filters = await browseFilters(page);
    await theme(filters, 'Healing').click();
    await expect(page).toHaveURL(/\/stories\?theme=healing$/);
    await expect(cards(page).first()).toContainText('Healing');
    const healing = await cards(page).count();
    filters = await browseFilters(page);
    await theme(filters, 'Hope').click();
    // Both in the address, each chosen with its ✓.
    await expect(page).toHaveURL(/\/stories\?theme=healing&theme=hope$/);
    for (const name of ['Healing', 'Hope'])
      await expect(theme(filters, name)).toHaveAttribute(
        'aria-current',
        'true',
      );
    // Fewer stories: each about both.
    await expect.poll(() => cards(page).count()).toBeLessThan(healing);
    await expect(cards(page)).not.toHaveCount(0);
    for (const card of await cards(page).all()) {
      await expect(card).toContainText('Healing');
      await expect(card).toContainText('Hope');
    }
    // Pressing one again takes only that one off.
    await theme(filters, 'Healing').click();
    await expect(page).toHaveURL(/\/stories\?theme=hope$/);
    await expect(theme(filters, 'Hope')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(theme(filters, 'Healing')).not.toHaveAttribute('aria-current');
    await theme(filters, 'Healing').click();
    await expect(page).toHaveURL(/\/stories\?theme=healing&theme=hope$/);

    await filters.getByRole('link', { name: 'Clear themes' }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await expect(
      filters.getByRole('link', { name: 'Clear themes' }),
    ).toHaveCount(0);
    await expect(cards(page)).toHaveCount(15);
  });

  test('an address with themes in any order, repeated, or the old single theme shows the same stories', async ({
    page,
  }) => {
    // Hope and Faith share one story only.
    for (const address of [
      '/stories?theme=hope&theme=faith',
      '/stories?theme=faith&theme=hope&theme=hope',
      // An id that isn't a theme filters nothing (A8).
      '/stories?theme=faith&theme=no_such_theme&theme=hope',
    ]) {
      await page.goto(address);
      await expect(cards(page), address).toHaveCount(1);
      await expect(cards(page)).toContainText('Browse test story 01');
    }
    // The old single-theme link still works.
    await page.goto('/stories?theme=faith');
    await expect(cards(page)).toHaveCount(4);
    await expect(theme(await browseFilters(page), 'Faith')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  // Joel 2026-11-21: "yes display a theme limit note".
  test('with 10 themes chosen, an 11th stays unchosen and a note says so until one is taken off', async ({
    page,
  }) => {
    const ten = [
      'faith',
      'answered_prayers',
      'forgiveness',
      'salvation',
      'doubt',
      'peace',
      'grief',
      'joy',
      'waiting',
      'healing',
    ];
    const address = `/stories?${ten
      .sort()
      .map((id) => `theme=${id}`)
      .join('&')}`;
    await page.goto(address);
    const filters = await browseFilters(page);
    const note = filters.getByRole('status').filter({
      hasText: 'You can choose up to 10 themes.',
    });
    await expect(note).toHaveCount(0);
    // The empty live region is already in the accessibility tree, so the note is announced.
    await expect(filters.locator('[data-theme-limit]')).toHaveAttribute(
      'role',
      'status',
    );
    expect(
      await filters
        .locator('[data-theme-limit]')
        .evaluate((el) => getComputedStyle(el).display),
    ).not.toBe('none');
    await theme(filters, 'Hope').click();
    await expect(note).toBeVisible();
    await expect(theme(filters, 'Hope')).not.toHaveAttribute('aria-current');
    await expect(page).not.toHaveURL(/theme=hope/);
    // Taking one off removes the note; the 11th can then be chosen.
    await theme(filters, 'Healing').click();
    await expect(page).not.toHaveURL(/theme=healing/);
    await expect(note).toHaveCount(0);
    await theme(filters, 'Hope').click();
    await expect(page).toHaveURL(/theme=hope/);
    await expect(theme(filters, 'Hope')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  // Codex, #259: a second theme pressed before the first one's page has loaded builds on it.
  test('two themes pressed quickly both stay chosen', async ({ page }) => {
    await page.goto('/stories');
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen = () => undefined as void;
    const asked = new Promise<void>((resolve) => (seen = resolve));
    await page.route(
      (url) =>
        url.pathname === '/stories' &&
        url.searchParams.getAll('theme').join() === 'healing',
      async (route) => {
        seen();
        await held;
        await route.continue().catch(() => undefined);
      },
    );
    try {
      const filters = await browseFilters(page);
      await theme(filters, 'Healing').click();
      await asked;
      await theme(filters, 'Hope').click();
    } finally {
      release();
    }
    await expect(page).toHaveURL(/\/stories\?theme=healing&theme=hope$/);
    const filters = await browseFilters(page);
    for (const name of ['Healing', 'Hope'])
      await expect(theme(filters, name)).toHaveAttribute(
        'aria-current',
        'true',
      );
    for (const card of await cards(page).all()) {
      await expect(card).toContainText('Healing');
      await expect(card).toContainText('Hope');
    }
  });

  // Codex, #259 round 2: the choice outlives the panel closing and opening again (which
  // remounts the filters) while its page is still loading.
  test('on a phone, a theme chosen, the panel closed and opened, another chosen: both stay', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'phone-320', 'the panel is the phone’s');
    await page.goto('/stories');
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen = () => undefined as void;
    const asked = new Promise<void>((resolve) => (seen = resolve));
    await page.route(
      (url) =>
        url.pathname === '/stories' &&
        url.searchParams.getAll('theme').join() === 'healing',
      async (route) => {
        seen();
        await held;
        await route.continue().catch(() => undefined);
      },
    );
    try {
      let filters = await browseFilters(page);
      await theme(filters, 'Healing').click();
      await asked;
      await closeBrowseFilters(page);
      filters = await browseFilters(page);
      await expect(theme(filters, 'Healing')).toHaveAttribute(
        'aria-current',
        'true',
      );
      await theme(filters, 'Hope').click();
    } finally {
      release();
    }
    await expect(page).toHaveURL(/\/stories\?theme=healing&theme=hope$/);
    await closeBrowseFilters(page);
    await expect(chips(page).getByRole('link')).toHaveText([
      'Remove Healing',
      'Remove Hope',
      'Clear all',
    ]);
  });

  /** Holds the page load for exactly these themes (and no search) until released. */
  async function holdThemes(page: Page, themes: string) {
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen = () => undefined as void;
    const asked = new Promise<void>((resolve) => (seen = resolve));
    await page.route(
      (url) =>
        url.pathname === '/stories' &&
        !url.searchParams.get('q') &&
        url.searchParams.getAll('theme').join() === themes,
      async (route) => {
        seen();
        await held;
        await route.continue().catch(() => undefined);
      },
    );
    return { asked, release };
  }

  // Codex, #259 round 3: a newer navigation takes over from a theme still loading; what's chosen
  // then follows the address it reaches, and the next theme builds on that address.
  test('a search sent while a theme is still loading: the chosen themes follow the address', async ({
    page,
  }) => {
    await page.goto('/stories');
    const { asked, release } = await holdThemes(page, 'healing');
    try {
      const filters = await browseFilters(page);
      await theme(filters, 'Healing').click();
      await asked;
      await closeBrowseFilters(page);
      const box = page.getByLabel('Search stories');
      await box.fill('test');
      await box.press('Enter');
      // The search carries the themes as chosen.
      await expect(page).toHaveURL(
        /\/stories\?q=test&theme=healing(&sort=latest)?$/,
      );
    } finally {
      release();
    }
    await expect(page).toHaveURL(
      /\/stories\?q=test&theme=healing(&sort=latest)?$/,
    );
    const filters = await browseFilters(page);
    await expect(theme(filters, 'Healing')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await theme(filters, 'Hope').click();
    await expect(page).toHaveURL(
      /\/stories\?q=test&theme=healing&theme=hope(&sort=latest)?$/,
    );
  });

  test('Back while a theme is still loading, to an address with the same filters: no theme stays chosen', async ({
    page,
  }) => {
    await page.goto('/stories');
    // The same filters written another way: a second history entry.
    await page.goto('/stories?sort=latest');
    const { asked, release } = await holdThemes(page, 'healing');
    try {
      const filters = await browseFilters(page);
      await theme(filters, 'Healing').click();
      await asked;
      await page.goBack();
      await expect(page).toHaveURL(/\/stories$/);
    } finally {
      release();
    }
    await expect(page).toHaveURL(/\/stories$/);
    const filters = await browseFilters(page);
    await expect(theme(filters, 'Healing')).not.toHaveAttribute('aria-current');
    await theme(filters, 'Hope').click();
    await expect(page).toHaveURL(/\/stories\?theme=hope$/);
    await expect(theme(filters, 'Healing')).not.toHaveAttribute('aria-current');
  });

  test('on a phone, each chosen theme is its own chip', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'phone-320', 'the chips are the panel’s');
    await page.goto('/stories?theme=hope&theme=healing');
    await expect(chips(page).getByRole('link')).toHaveText([
      'Remove Healing',
      'Remove Hope',
      'Clear all',
    ]);
    await expect(filtersButton(page)).toHaveAccessibleName('Filters (2 on)');
    await chips(page).getByRole('link', { name: 'Remove Hope' }).click();
    await expect(page).toHaveURL(/\/stories\?theme=healing$/);
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
    // Latest first is the usual order, so the address leaves it out.
    await expect(page).toHaveURL(/\/stories$/);
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

// The search box and the filters are one form (Codex, #254): pressing Search or changing a filter
// sends the typed search, the sort and the format together, whichever was changed first.
test.describe('search and filters send each other’s live values', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !['phone-320', 'desktop-1280'].includes(info.project.name),
      'one phone (the panel) and one computer (the column)',
    );
  });

  test('a filter changed after typing a search keeps the typed search', async ({
    page,
  }) => {
    await page.goto('/stories');
    const box = page.getByLabel('Search stories');
    await box.fill('test');
    const filters = await browseFilters(page);
    await filters.locator('label').filter({ hasText: 'Oldest first' }).click();
    await expect(page).toHaveURL(/[?&]q=test(&|$)/);
    await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
    await expect(page.getByText('Results for “test”')).toBeVisible();
    await expect(box).toHaveValue('test');
  });

  test('a search sent while a sort change is still loading keeps the new sort', async ({
    page,
  }) => {
    await page.goto('/stories');
    // Hold the sort change's page load until the search has been sent.
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen = () => undefined as void;
    const asked = new Promise<void>((resolve) => (seen = resolve));
    await page.route(
      (url) =>
        url.pathname === '/stories' &&
        url.searchParams.get('sort') === 'oldest' &&
        !url.searchParams.get('q'),
      async (route) => {
        seen();
        await held;
        await route.continue().catch(() => undefined);
      },
    );
    try {
      const filters = await browseFilters(page);
      await filters
        .locator('label')
        .filter({ hasText: 'Oldest first' })
        .click();
      await asked;
      await closeBrowseFilters(page);
      const box = page.getByLabel('Search stories');
      await box.fill('test');
      await box.press('Enter');
      await expect(page).toHaveURL(/[?&]q=test(&|$)/);
      await expect(page).toHaveURL(/[?&]sort=oldest(&|$)/);
      await expect(page.getByText('Results for “test”')).toBeVisible();
    } finally {
      release();
    }
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

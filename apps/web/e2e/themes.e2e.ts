import { randomUUID } from 'node:crypto';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  enlargeText,
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// Themes (O5, Joel 2026-10-31). Where people choose themes (Share's details step) and filter by
// them (browse), the main themes come first and every other theme is behind "More themes": closed
// at first, a search box at its top, a list of limited height, "Fewer themes" just above it, and
// chosen themes in the first row while it's closed. Admins add and rename themes and choose the
// main ones at /admin/themes (the stub api-admin in stub-api-user.mjs keeps each session's own
// themes, so a rename shows on that session's stories). Browse's main themes are stub-api.mjs's
// "theme" tags; Share's are Hope, Faith, Loss and Healing.

const PHONE = 'phone-320';

/** A new person (an admin when `prefix` is 'admin'): their session in the stub and the page. */
async function person(
  page: Page,
  request: APIRequestContext,
  seed: Record<string, unknown> = {},
  prefix = '',
) {
  const id = `${prefix}${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: { signupAccepted: true, ...seed },
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  return id;
}

/** "More themes" opened: the toggle stays in view above a compact, scrolling list. */
async function expectCompactOpen(page: Page, more: Locator) {
  await expect(more).toHaveAttribute('open');
  const toggle = more.locator('summary');
  await expect(toggle).toContainText('Fewer themes');
  await expect(toggle).toBeInViewport();
  await expectTarget(page, toggle);
  // The search box is at the top of the list.
  const search = more.getByLabel('Search themes');
  const list = more.locator('[data-more-themes-list]');
  const [s, l] = [await search.boundingBox(), await list.boundingBox()];
  expect(s && l && s.y < l.y).toBe(true);
  // The list is height-limited: never more than 40% of the screen.
  const screen = page.viewportSize()?.height ?? 0;
  expect((l?.height ?? 0) <= screen * 0.4 + 1).toBe(true);
  await expectNoHorizontalOverflow(page);
}

test.describe('browse: main themes first, the rest behind “More themes”', () => {
  test('on a phone: closed at first, opens compact, the search narrows, “Fewer themes” closes it, the chosen one stays shown', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== PHONE, 'the phone the picker is for');
    await page.goto('/stories');
    const first = page.getByRole('list', { name: 'Themes' });
    // The main themes, in the admin's order, after All; the others aren't in the first row.
    await expect(first.getByRole('link')).toHaveText([
      'All',
      'Healing',
      'Addiction',
      'Loss',
      'Depression',
      'Relationships',
      'Loneliness',
      'Illness',
      'Parenting',
    ]);
    const more = page.locator('main [data-more-themes]');
    await expect(more).not.toHaveAttribute('open');
    await expect(more.getByRole('link', { name: 'Hope' })).toBeHidden();

    await more.getByText('More themes').click();
    await expectCompactOpen(page, more);
    await expectAllTargets(page);
    const search = more.getByLabel('Search themes');
    await search.fill('  PRAY ');
    await expect(more.locator('[data-more-themes-list] a')).toHaveText([
      'Answered Prayers',
    ]);
    await search.fill('zzz');
    await expect(more).toContainText('No themes match “zzz”.');
    await search.fill('ho');
    await more.getByRole('link', { name: 'Hope' }).click();
    await expect(page).toHaveURL(/[?&]tag=hope/);
    // Still open where the person was, with Hope chosen.
    await expect(
      more.getByRole('link', { name: 'Hope (selected)' }),
    ).toBeVisible();
    await more.getByText('Fewer themes').click();
    await expect(more).not.toHaveAttribute('open');
    await expect(
      first.getByRole('link', { name: 'Hope (selected)' }),
    ).toBeVisible();
  });

  test('at 200% text on a 320 px phone it still fits, with full-size targets', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== PHONE, 'the smallest phone');
    await enlargeText(page);
    await page.goto('/stories');
    const more = page.locator('main [data-more-themes]');
    await more.getByText('More themes').click();
    await expectCompactOpen(page, more);
    await more.getByLabel('Search themes').fill('o');
    await expectAllTargets(page);
    await more.getByText('Fewer themes').click();
    await expect(more).not.toHaveAttribute('open');
  });
});

test.describe('share: choosing themes', () => {
  test('main themes first; a theme found under “More themes” is chosen and stays shown when it closes', async ({
    page,
    request,
  }, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
    await person(page, request, {
      granted: ['age_18plus', 'account_data', 'special_category_religious'],
      stories: [
        {
          id: 'd1',
          title: 'Found',
          body: 'I was lost for years, and I did not think anyone could reach me. '.repeat(
            5,
          ),
          primaryFormat: 'written',
        },
      ],
    });
    await page.goto(`${WEB_SIGNED_IN_URL}/share?draft=d1`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Add some details' }),
    ).toBeFocused();
    const themes = page.getByRole('group', { name: 'Themes' });
    const firstRow = themes.locator('ul').first();
    await expect(firstRow.getByRole('checkbox')).toHaveCount(4);
    await expect(firstRow).toHaveText(/Hope.*Faith.*Loss.*Healing/);
    const more = themes.locator('[data-more-themes]');
    await expect(more).not.toHaveAttribute('open');

    await more.getByText('More themes').click();
    await expectCompactOpen(page, more);
    await more.getByLabel('Search themes').fill('DOU');
    const list = more.locator('[data-more-themes-list]');
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await list.getByText('Doubt', { exact: true }).click();
    // Chosen where it is: nothing moves while the list is open.
    await expect(list.getByRole('checkbox', { name: 'Doubt' })).toBeChecked();
    await more.getByText('Fewer themes').click();
    await expect(more).not.toHaveAttribute('open');
    await expect(
      firstRow.getByRole('checkbox', { name: 'Doubt' }),
    ).toBeChecked();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('/admin/themes', () => {
  test('an admin adds a theme, renames one, and chooses the main themes, their order and how many', async ({
    page,
    request,
  }) => {
    await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/themes`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Themes' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Admin pages' })
        .getByRole('link', { name: 'Submission limits' }),
    ).toHaveAttribute('href', '/admin/limits');
    const main = page.getByRole('list', { name: 'Main themes, in order' });
    await expect(main.getByRole('listitem')).toHaveText([
      /Hope/,
      /Faith/,
      /Loss/,
      /Healing/,
    ]);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);

    // Add one; a name another theme has, in any case, is refused.
    const all = page.getByRole('list', { name: 'All themes' });
    await page.getByLabel('New theme').fill('Mental health');
    await page.getByRole('button', { name: 'Add theme' }).click();
    await expect(page.locator('[data-note="done"]')).toHaveText(
      'Added “Mental health”.',
    );
    await expect(all).toContainText('Mental health');
    await page.getByLabel('New theme').fill('HOPE');
    await page.getByRole('button', { name: 'Add theme' }).click();
    await expect(page.locator('[data-note="error"]')).toHaveText(
      'There is already a theme with this name.',
    );

    // Rename in place, from the keyboard.
    await page.getByRole('button', { name: 'Rename Doubt' }).click();
    const field = page.getByLabel('New name for Doubt');
    await expect(field).toBeFocused();
    await field.fill('Doubt and questions');
    await page.keyboard.press('Enter');
    await expect(all).toContainText('Doubt and questions');
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // Reorder with the buttons, add one, show 2.
    await main.getByRole('button', { name: 'Move Healing up' }).click();
    await main.getByRole('button', { name: 'Move Healing up' }).click();
    await main.getByRole('button', { name: 'Move Healing up' }).click();
    await main
      .getByRole('button', { name: 'Remove Loss from the main themes' })
      .click();
    await page
      .getByLabel('Add a main theme')
      .selectOption({ label: 'Mental health' });
    await page.getByRole('button', { name: 'Add to the list' }).click();
    await page.getByLabel('How many main themes people see').fill('2');
    await expect(main.getByRole('listitem')).toHaveText([
      /Healing/,
      /Hope/,
      /Faith.*Not shown first/,
      /Mental health.*Not shown first/,
    ]);
    await page.getByRole('button', { name: 'Save main themes' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Main themes' })
        .locator('[data-note="done"]'),
    ).toHaveText('Saved. People see the new main themes now.');
    await page.reload();
    await expect(
      page
        .getByRole('list', { name: 'Main themes, in order' })
        .getByRole('listitem'),
    ).toHaveText([/Healing/, /Hope/, /Faith/, /Mental health/]);
    await expect(
      page.getByLabel('How many main themes people see'),
    ).toHaveValue('2');
  });

  test('a theme renamed by an admin shows its new name on a story that already has it', async ({
    page,
    request,
  }, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
    await person(
      page,
      request,
      {
        stories: [
          {
            id: 'r1',
            status: 'pending',
            title: 'My healing',
            primaryFormat: 'written',
            tagSlugs: ['healing'],
          },
        ],
      },
      'admin',
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/account`);
    const story = page
      .locator('[data-submission]')
      .filter({ hasText: 'My healing' });
    await expect(story).toContainText('Healing');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/themes`);
    await page.getByRole('button', { name: 'Rename Healing' }).click();
    await page.getByLabel('New name for Healing').fill('Healing and recovery');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.locator('[data-note="done"]')).toHaveText(
      'Renamed to “Healing and recovery”.',
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/account`);
    await expect(story).toContainText('Healing and recovery');
  });

  test('only for admins: anyone else is told so and sees no themes', async ({
    page,
    request,
  }, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
    await person(page, request);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/themes`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for admins.',
    );
    await expect(page.locator('[data-theme]')).toHaveCount(0);
  });
});

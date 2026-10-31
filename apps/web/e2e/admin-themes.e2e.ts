import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// /admin/themes (themes plan v3), on every device: an admin changes themes and categories
// through the panel (phones and keyboards; dragging is never the only way), every change is held
// on the page, and one Save sends them all after a summary of what reaches beyond the page.
// Dragging is checked once, on a desktop mouse (A6). A save on themes another admin changed
// meanwhile asks to reload (A2). The stub api-admin (stub-api-user.mjs) keeps each test's
// themes apart by its session: Feelings (Grief, Hope★), Journeys (Coming to faith, Doubt used by
// 4 stories), Topics (Healing★, Loss★, Work) and an empty Other.

async function open(page: Page, session = `admin-${randomUUID().slice(0, 8)}`) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/themes`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Themes' }),
  ).toBeVisible();
  await expect(page.locator('section[data-category]').first()).toBeVisible();
}

const category = (page: Page, name: string) =>
  page.locator(`section[data-category="${name}"]`);
const zone = (page: Page, name: string, part: 'highlighted' | 'rest') =>
  category(page, name).locator(`[data-zone$="|${part}"]`);
const pill = (page: Page, name: string) =>
  page.locator(`[data-theme="${name}"]`);
const namesIn = (page: Page, name: string, part: 'highlighted' | 'rest') =>
  zone(page, name, part).locator('[data-theme]');

/** The pill's panel, the way a keyboard (or a tap) opens it. */
async function panel(page: Page, name: string) {
  await pill(page, name)
    .getByRole('button', { name, exact: true })
    .press('Enter');
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('/admin/themes', () => {
  test('an admin changes themes and categories, sees what reaches beyond the page, and saves them all at once', async ({
    page,
  }) => {
    await open(page);
    // Categories A–Z, Other last; each with its Highlighted themes first, A–Z.
    expect(
      await page
        .locator('section[data-category]')
        .evaluateAll((s) => s.map((x) => x.getAttribute('data-category'))),
    ).toEqual(['Feelings', 'Journeys', 'Topics', 'Other']);
    await expect(namesIn(page, 'Topics', 'highlighted')).toHaveText([
      'Healing×',
      'Loss×',
    ]);
    await expect(namesIn(page, 'Topics', 'rest')).toHaveText(['Work×']);
    // Other can't be renamed or deleted.
    await expect(
      category(page, 'Other').getByRole('button', { name: /Rename|Delete/ }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);

    // The panel: a new name (tidied), highlighted.
    let dialog = await panel(page, 'Work');
    await dialog.getByLabel('Name').fill('  work   and  money ');
    await dialog.getByRole('switch', { name: /Highlighted/ }).check();
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(namesIn(page, 'Topics', 'highlighted')).toHaveText([
      'Healing×',
      'Loss×',
      'Work and money×',
    ]);
    await expect(page.locator('[data-unsaved]')).toHaveAttribute(
      'data-unsaved',
      '2',
    );

    // The panel moves a theme to another category.
    dialog = await panel(page, 'Coming to faith');
    await dialog.getByLabel('Category').selectOption({ label: 'Topics' });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(namesIn(page, 'Topics', 'rest')).toHaveText([
      'Coming to faith×',
    ]);

    // Deleting a theme needs "delete <name>" typed (spaces at the ends and capitals don't matter).
    await pill(page, 'Doubt')
      .getByRole('button', { name: 'Delete Doubt' })
      .click();
    dialog = page.getByRole('dialog', { name: 'Delete “Doubt”?' });
    await expect(dialog).toContainText('used by 4 stories');
    const confirm = dialog.getByRole('button', { name: 'Delete theme' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('delete dou');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('  DELETE doubt ');
    await confirm.click();
    // Greyed out until Save, and it can be undone.
    await expect(pill(page, 'Doubt')).toHaveAttribute('data-deleted', '');
    await expect(
      pill(page, 'Doubt').getByRole('button', { name: 'Undo deleting Doubt' }),
    ).toBeVisible();

    // A new category, and a category deleted: its themes go to Other, not highlighted.
    await page.getByRole('button', { name: '+ Create category' }).click();
    await page.getByLabel('New category’s name').fill('prayer  life');
    await page.getByLabel('New category’s name').press('Enter');
    await expect(category(page, 'Prayer life')).toBeVisible();
    await category(page, 'Feelings')
      .getByRole('button', { name: 'Delete category Feelings' })
      .click();
    await expect(category(page, 'Feelings')).toHaveCount(0);
    await expect(namesIn(page, 'Other', 'rest')).toHaveText([
      'Grief×',
      'Hope×',
    ]);
    await expect(namesIn(page, 'Other', 'highlighted')).toHaveCount(0);

    // Save: what reaches beyond the page first, then the rest.
    await page.getByRole('button', { name: 'Save changes' }).click();
    dialog = page.getByRole('dialog', { name: /^Save \d+ changes\?$/ });
    await expect(dialog.locator('[data-side-effects] li')).toHaveText([
      'Feelings is deleted. Its 2 themes move to Other, not highlighted.',
      'Doubt is deleted. It’s used by 4 stories and will be removed from them.',
    ]);
    await expect(dialog).toContainText('Work renamed “Work and money”');
    await expect(dialog).toContainText('Coming to faith moved to Topics');
    await expect(dialog).toContainText('Prayer life created');
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('[data-save-status="done"]')).toHaveText(
      'Saved. Everyone sees the new themes now.',
    );

    // Stored as the page showed it.
    await page.reload();
    await expect(category(page, 'Prayer life')).toBeVisible();
    await expect(category(page, 'Feelings')).toHaveCount(0);
    await expect(pill(page, 'Doubt')).toHaveCount(0);
    await expect(namesIn(page, 'Topics', 'highlighted')).toHaveText([
      'Healing×',
      'Loss×',
      'Work and money×',
    ]);
    await expect(namesIn(page, 'Other', 'rest')).toHaveText([
      'Grief×',
      'Hope×',
    ]);
  });

  test('Discard puts everything back as it was loaded', async ({ page }) => {
    await open(page);
    const dialog = await panel(page, 'Healing');
    await dialog.getByRole('switch', { name: /Highlighted/ }).uncheck();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(namesIn(page, 'Topics', 'rest')).toHaveText([
      'Healing×',
      'Work×',
    ]);
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(namesIn(page, 'Topics', 'rest')).toHaveText(['Work×']);
    await expect(page.locator('[data-unsaved]')).toHaveAttribute(
      'data-unsaved',
      '0',
    );
  });

  test('a duplicate name (ignoring capitals) is refused by the server and nothing is saved', async ({
    page,
  }) => {
    await open(page);
    await zone(page, 'Other', 'rest')
      .getByRole('button', { name: 'Add a theme to Other' })
      .click();
    await page.getByLabel('New theme’s name').fill('HEALING');
    await page.getByLabel('New theme’s name').press('Enter');
    await expect(pill(page, 'HEALING')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page
      .getByRole('dialog', { name: 'Save 1 change?' })
      .getByRole('button', { name: 'Save changes' })
      .click();
    await expect(page.locator('[data-save-status="error"]')).toContainText(
      // Whichever of the two the server reads first.
      /There is already a theme called “healing”\./i,
    );
    // Still held on the page, to fix and save again.
    await expect(page.locator('[data-unsaved]')).toHaveAttribute(
      'data-unsaved',
      '1',
    );
  });

  test('on a desktop, a pill dragged into Highlighted is highlighted, and clicking its name edits it in place', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'one desktop (A6)');
    await open(page);
    // The mouse works in the viewport: Topics is below the fold.
    await category(page, 'Topics').scrollIntoViewIfNeeded();
    const from = await pill(page, 'Work').boundingBox();
    const to = await zone(page, 'Topics', 'highlighted').boundingBox();
    if (!from || !to) throw new Error('not laid out');
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(namesIn(page, 'Topics', 'highlighted')).toHaveText([
      'Healing×',
      'Loss×',
      'Work×',
    ]);

    await pill(page, 'Loss')
      .getByRole('button', { name: 'Loss', exact: true })
      .click();
    const box = page.getByRole('textbox', { name: 'Rename Loss' });
    await box.fill('loss and grief');
    await box.press('Enter');
    await expect(pill(page, 'Loss and grief')).toBeVisible();
    await expect(page.locator('[data-unsaved]')).toHaveAttribute(
      'data-unsaved',
      '2',
    );
  });

  test('a save on themes another admin changed meanwhile is refused and asks to reload', async ({
    browser,
  }, info) => {
    test.skip(!BEHAVIOUR_DEVICES.includes(info.project.name), 'behaviour');
    const session = `admin-${randomUUID().slice(0, 8)}`;
    const start = async () => {
      const page = await (await browser.newContext()).newPage();
      await open(page, session);
      return page;
    };
    const mine = await start();
    const theirs = await start();
    for (const [page, theme] of [
      [theirs, 'Grief'],
      [mine, 'Work'],
    ] as const) {
      const dialog = await panel(page, theme);
      await dialog.getByRole('switch', { name: /Highlighted/ }).check();
      await dialog.getByRole('button', { name: 'Done' }).click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page
        .getByRole('dialog', { name: 'Save 1 change?' })
        .getByRole('button', { name: 'Save changes' })
        .click();
    }
    await expect(theirs.locator('[data-save-status="done"]')).toBeVisible();
    const stale = mine.locator('[data-save-status="stale"]');
    await expect(stale).toContainText(
      'Someone else changed themes. Reload to see their changes',
    );
    await stale.getByRole('button', { name: 'Reload' }).click();
    // Theirs is there; mine is gone, to make again.
    await expect(namesIn(mine, 'Feelings', 'highlighted')).toHaveText([
      'Grief×',
      'Hope×',
    ]);
    await expect(namesIn(mine, 'Topics', 'rest')).toHaveText(['Work×']);
  });

  test('only for admins: anyone else is told so and sees no themes', async ({
    page,
  }, info) => {
    test.skip(!BEHAVIOUR_DEVICES.includes(info.project.name), 'behaviour');
    await page.addInitScript(() =>
      window.localStorage.setItem('e2e-session', 'user-themes'),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/themes`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for admins.',
    );
    await expect(page.locator('section[data-category]')).toHaveCount(0);
  });
});

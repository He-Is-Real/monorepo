import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  chooseOption,
  expectAllTargets,
  expectFocusedAndUncovered,
  expectNoHorizontalOverflow,
} from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// /admin/limits (W3, D94, D112, D113): an admin sees the limits in force in plain words with
// their units, changes one, confirms the change and it's saved; a save on limits another admin
// changed meanwhile asks to reload; anyone else is refused. The page and its confirmation fit
// every device; the behaviour runs on one phone and one desktop. The stub api-admin
// (stub-api-user.mjs) keeps each test's limits apart by its session.
// SL-1 C (Joel, 2026-11-17): one group at a time, from a side list (768 px and up) or a "Group"
// drop-down (phones), with a save bar that lists every unsaved change.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

/** Shows a group: the "Group" drop-down on phones, the side list from 768 px. */
async function showGroup(page: Page, name: string) {
  // The limits have loaded, so the drop-down or the side list is there.
  await expect(page.locator('[data-limit]').first()).toBeVisible();
  const select = page.getByLabel('Group', { exact: true });
  if (await select.isVisible()) {
    // A group with an error reads "<name> (needs fixing)".
    await chooseOption(select, new RegExp(`^${name}`));
  } else {
    await page
      .getByRole('group', { name: 'Limit groups' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click();
  }
}

const saveBar = (page: Page) => page.locator('[data-save-bar]');
const saveButton = (page: Page) =>
  saveBar(page).getByRole('button', { name: 'Save', exact: true });

test('/admin/limits fits with 44 px targets, and its save bar and confirmation fit the screen', async ({
  page,
}) => {
  await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
  // First load: Written stories.
  await expect(page.getByLabel('Longest story')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  // The longest units and notes.
  await showGroup(page, 'Deleting old stories');
  await expect(
    page.getByLabel('Keep a story we didn’t accept for'),
  ).toHaveValue('90');
  await expectNoHorizontalOverflow(page);
  await showGroup(page, 'Video and audio');
  const video = page.getByLabel('Largest video file');
  await expect(video).toHaveValue('4096');
  await video.fill('2048');
  await showGroup(page, 'How often');
  const weekly = page.getByLabel('Stories one person can send for review');
  await weekly.fill('2');
  await expect(saveBar(page)).toContainText('2 changes not saved yet');
  // The box being typed in stays visible above the save bar (Codex review of #237).
  await expectFocusedAndUncovered(weekly);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  await saveButton(page).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(
    'Largest video file: 4,096 MB → 2,048 MB',
  );
  await expect(confirm).toContainText(
    'Stories one person can send for review: 1 per 7 days → 2 per 7 days',
  );
  await expectNoHorizontalOverflow(page);
});

// Joel, 2026-11-17: the "Group" drop-down was the browser's plain list in Firefox. On a computer
// (a mouse or trackpad) it's the site's themed list in every browser; here in a window narrow
// enough for the drop-down (under 768 px).
test.describe('the Group drop-down on a computer', () => {
  test.use({ viewport: { width: 700, height: 900 } });
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-1280', 'a computer');
  });

  test('opens the themed list and switches the group, by mouse and by keyboard', async ({
    page,
  }) => {
    await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
    await expect(page.getByLabel('Longest story')).toBeVisible();
    const group = page.getByLabel('Group', { exact: true });
    await expect(group).toHaveAttribute('data-slot', 'select-trigger');

    await group.click();
    const list = page.getByRole('listbox');
    const surface = await list.evaluate((el) => {
      const probe = document.createElement('div');
      probe.style.color = 'var(--popover)';
      document.body.append(probe);
      const popover = getComputedStyle(probe).color;
      probe.remove();
      return { popover, background: getComputedStyle(el).backgroundColor };
    });
    expect(surface.background).toBe(surface.popover);
    for (const option of await list.getByRole('option').all())
      expect((await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        43.99,
      );
    // By mouse.
    await list.getByRole('option', { name: 'Video and audio' }).click();
    await expect(list).toHaveCount(0);
    await expect(page.getByLabel('Largest video file')).toBeVisible();
    await expect(page.getByLabel('Longest story')).toHaveCount(0);

    // By keyboard: the list opens on the chosen group; the next one down is Pictures.
    await expect(group).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      list.getByRole('option', { name: 'Video and audio' }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    // The highlight moves a moment after the key (Radix); Enter picks what is highlighted.
    await expect(list.getByRole('option', { name: 'Pictures' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(page.getByLabel('Largest picture file')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('/admin/limits', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('an admin changes a limit, confirms, and it is saved', async ({
    page,
  }) => {
    await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Submission limits' }),
    ).toBeVisible();
    // Linked from the other admin page, and back.
    await expect(
      page
        .getByRole('navigation', { name: 'Admin pages' })
        .getByRole('link', { name: 'Consent & legal' }),
    ).toHaveAttribute('href', '/admin/consent');
    // Pre-filled with what's in force, in the page's units; Written stories first.
    await expect(page.getByLabel('Longest story')).toBeVisible();
    await expect(saveBar(page)).toHaveCount(0);
    await showGroup(page, 'Video and audio');
    const video = page.getByLabel('Largest video file');
    await expect(video).toHaveValue('4096');
    await expect(page.getByLabel('Longest video or audio')).toHaveValue('15');

    // A change shows the save bar at once; Undo puts the saved values back.
    await video.fill('3000');
    await expect(video).toHaveAttribute('data-changed', '');
    await expect(saveBar(page)).toContainText('1 change not saved yet');
    await expect(saveBar(page)).toContainText(
      'Largest video file: 4,096 → 3,000 MB',
    );
    await saveBar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(video).toHaveValue('4096');
    await expect(saveBar(page)).toHaveCount(0);

    // A value out of bounds in a group that isn't shown: Save shows that group, marks and
    // focuses the field, and nothing is asked.
    await video.fill('99999');
    await showGroup(page, 'How often');
    await expect(video).toHaveCount(0);
    await saveButton(page).click();
    await expect(page.locator('[data-limit="videoMaxBytes"]')).toContainText(
      'Enter a whole number from 1 to 10,240 (MB).',
    );
    await expect(video).toBeFocused();
    // The group is marked in the side list or the drop-down.
    const select = page.getByLabel('Group', { exact: true });
    await expect(
      (await select.isVisible())
        ? select.locator('option', { hasText: 'Video and audio' })
        : page
            .getByRole('group', { name: 'Limit groups' })
            .getByRole('button', { name: /^Video and audio/ }),
    ).toContainText('eeds fixing');
    await expect(page.locator('[data-save-status="error"]')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // Values typed in one group survive switching to another and back.
    await video.fill('2048');
    await showGroup(page, 'How often');
    const weekly = page.getByLabel('Stories one person can send for review');
    await expect(weekly).toHaveValue('1');
    await weekly.fill('2');
    // G3 B: how long the nightly clean-up keeps stories that won't be published.
    await showGroup(page, 'Deleting old stories');
    const rejected = page.getByLabel('Keep a story we didn’t accept for');
    await expect(rejected).toHaveValue('90');
    await expect(
      page.getByLabel('Keep a sent-back or edited story nobody touches for'),
    ).toHaveValue('186');
    await rejected.fill('60');
    await showGroup(page, 'Video and audio');
    await expect(video).toHaveValue('2048');
    await expect(saveBar(page)).toContainText('3 changes not saved yet');

    await saveButton(page).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('apply to everyone');
    await expect(confirm).toContainText(
      'Keep a story we didn’t accept for: 90 days after the decision → 60 days after the decision',
    );
    await expect(confirm).toContainText(
      'Largest video file: 4,096 MB → 2,048 MB',
    );
    await expect(confirm).toContainText(
      'Stories one person can send for review: 1 per 7 days → 2 per 7 days',
    );
    await confirm.getByRole('button', { name: 'Yes, save' }).click();
    await expect(page.locator('[data-save-status="done"]')).toHaveText(
      'Saved. The new limits apply now.',
    );
    await expect(saveBar(page)).toHaveCount(0);
    await page.reload();
    await showGroup(page, 'Video and audio');
    await expect(page.getByLabel('Largest video file')).toHaveValue('2048');
    await showGroup(page, 'How often');
    await expect(
      page.getByLabel('Stories one person can send for review'),
    ).toHaveValue('2');
    await showGroup(page, 'Deleting old stories');
    await expect(
      page.getByLabel('Keep a story we didn’t accept for'),
    ).toHaveValue('60');
  });

  // Joel, 2026-11-20: the largest picture file, in KB (1,024 bytes), 200 KB to 20 MB.
  test('an admin changes the largest picture file, confirms, and it is saved', async ({
    page,
  }) => {
    await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
    await showGroup(page, 'Pictures');
    const picture = page.getByLabel('Largest picture file');
    await expect(picture).toHaveValue('3072');
    await expect(page.locator('[data-limit="imageMaxBytes"]')).toContainText(
      'Allowed 200–20,480',
    );
    await picture.fill('199');
    await saveButton(page).click();
    await expect(page.locator('[data-limit="imageMaxBytes"]')).toContainText(
      'Enter a whole number from 200 to 20,480 (KB).',
    );
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await picture.fill('2048');
    await saveButton(page).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(
      'Largest picture file: 3,072 KB → 2,048 KB',
    );
    await confirm.getByRole('button', { name: 'Yes, save' }).click();
    await expect(page.locator('[data-save-status="done"]')).toHaveText(
      'Saved. The new limits apply now.',
    );
    await page.reload();
    await showGroup(page, 'Pictures');
    await expect(page.getByLabel('Largest picture file')).toHaveValue('2048');
  });

  test('a stale save (another admin saved meanwhile) is refused and asks to reload', async ({
    browser,
  }) => {
    const session = `admin-${randomUUID().slice(0, 8)}`;
    const open = async () => {
      const page = await (await browser.newContext()).newPage();
      await useSession(page, session);
      await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
      await showGroup(page, 'How often');
      await expect(
        page.getByLabel('Unfinished drafts one person can have'),
      ).toHaveValue('3');
      return page;
    };
    const mine = await open();
    const theirs = await open();
    const save = async (page: Page, drafts: string) => {
      await page
        .getByLabel('Unfinished drafts one person can have')
        .fill(drafts);
      await saveButton(page).click();
      await page.getByRole('button', { name: 'Yes, save' }).click();
    };
    // Theirs is saved before mine is sent, so mine is the stale one.
    await save(theirs, '4');
    await expect(theirs.locator('[data-save-status="done"]')).toBeVisible();
    await save(mine, '5');
    const stale = mine.locator('[data-save-status="stale"]');
    await expect(stale).toContainText('Someone else changed the limits');
    await stale.getByRole('button', { name: 'Reload' }).click();
    await showGroup(mine, 'How often');
    await expect(
      mine.getByLabel('Unfinished drafts one person can have'),
    ).toHaveValue('4');
  });

  test('only for admins: anyone else is told so and sees no limits', async ({
    page,
  }) => {
    await useSession(page, `user-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for admins.',
    );
    await expect(page.locator('[data-limit]')).toHaveCount(0);
  });
});

import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { Contract } from '@heisreal/contracts/testing';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  chooseOption,
  expectAllTargets,
  expectChosen,
  expectNoHorizontalOverflow,
  optionLabels,
} from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// The moderators' pages (M3 plan PRs 1 and 6; MD-1 to MD-4; MQ-1 E and OQ-2): /moderation lists
// every story that isn't public, one state at a time as tabs with counts (opening on waiting for
// review, oldest sent first; drafts never sent for Admins only), narrowed by a title search,
// formats and themes in a side panel (folded into "Filters and sort" on phones) and sorted, all
// in the address; and /moderation/{id} shows one as the public would see it (the story page's
// own parts, with the player's speed menu), what the moderator can do with it, and its history
// with moderators' notes. Approve, Send back and Reject a waiting story (a note for the last two),
// Take down a published one and Show it again (G5); refusals in plain words; the first decision
// wins (D-1); only an Admin approves anyway, never in the upload-link hour (G11 B, G24); a
// rejected story can be approved, sent back or put back in the waiting list (OV-1 C), and any
// taken-down one shown again, sent back or rejected (OV-2 A); only an Admin deletes, after one
// question (P1-11).
// Moderators and up only; the admin menu shows Moderation to them. The pages fit every device;
// the behaviour runs on one phone and one desktop. The stub api-admin (stub-api-user.mjs) serves
// fixed stories and keeps each session's decisions; a published story's public page offers its
// Take down to moderators only (MD-1); sessions starting `moderator` are
// Moderators, `admin` Admins.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

/** A session of its own (the stub keeps each session's decisions): `prefix` sets the role. */
const fresh = (prefix: string) => `${prefix}-${randomUUID()}`;

const listItems = (page: Page) => page.locator('[data-list-item]');
const titles = (page: Page) => page.locator('[data-list-title]');
const tabs = (page: Page) =>
  page.getByRole('navigation', { name: 'Story states' }).getByRole('link');
const tab = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Story states' })
    .getByRole('link', { name: new RegExp(`^${name}`) });
/** A box or radio in the side panel, by its line (the input hides behind its drawn mark). */
const option = (panel: Locator, name: string) =>
  panel.locator('label').filter({ hasText: name });
/** The side panel; on phones it opens from "Filters and sort (N)" first. */
async function filters(page: Page) {
  await expect(page.locator('[data-filters]')).toBeAttached();
  const toggle = page.locator('[data-filters-toggle]');
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute('aria-expanded')) === 'false'
  )
    await toggle.click();
  return page.getByRole('region', { name: 'Filters and sort' });
}

test('/moderation and a story under review fit, with 44 px targets', async ({
  page,
}) => {
  await useSession(page, 'moderator-fit');
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
  await expect(listItems(page)).toHaveCount(20);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  // A long theme wraps inside its own cell, clear of the waiting time beside it.
  const long = page.locator('[data-list-item="mod_long_title"]');
  const chip = long.locator('[data-list-themes] li');
  await expect(chip).toHaveText('Recovery from addiction and alcoholism');
  const [c, cell, time] = await Promise.all(
    [
      chip,
      long.locator('[data-list-themes]'),
      long.locator('[data-list-waiting]'),
    ].map(async (l) => {
      const b = await l.boundingBox();
      if (!b) throw new Error('not rendered');
      return b;
    }),
  );
  expect(c.x + c.width).toBeLessThanOrEqual(cell.x + cell.width + 0.5);
  const apart =
    c.x + c.width <= time.x + 0.5 ||
    time.x + time.width <= c.x + 0.5 ||
    c.y + c.height <= time.y + 0.5 ||
    time.y + time.height <= c.y + 0.5;
  expect(apart, 'the theme overlaps the waiting time').toBe(true);
  // No column wider than 1200 px, on the widest screens too (Joel, 2026-11-17).
  const column = await page.locator('[data-list-column]').boundingBox();
  expect(column?.width ?? 0).toBeLessThanOrEqual(1200);
  // The side panel open, with every theme shown, and an Admin's five tabs.
  const panel = await filters(page);
  await panel.getByRole('button', { name: 'More themes' }).click();
  await expect(
    panel.getByRole('link', { name: 'Doubt', exact: true }),
  ).toBeAttached();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation?state=hidden`);
  await expect(listItems(page)).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  // Nothing matches: the message offers Clear filters.
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation?q=nothing+like+it`);
  await expect(page.locator('[data-list-empty]')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  for (const id of [
    'mod_video',
    'mod_written',
    'mod_long_title',
    'mod_taken_down',
  ]) {
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/${id}`);
    await expect(page.locator('[data-history-entry]').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  }
  // With the note form open.
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_written`);
  await page.getByRole('button', { name: 'Send back' }).click();
  await expect(page.getByLabel('Your note to the person')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  // An Admin's list (five tabs), and their view of a story: the sender's email and address, with
  // a Block confirm open (EM-2).
  await useSession(page, fresh('admin-fit'));
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
  await expect(tabs(page)).toHaveCount(5);
  await expect(listItems(page)).toHaveCount(20);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
  await page
    .locator('[data-sender-email]')
    .getByRole('button', { name: 'Block' })
    .click();
  await expect(page.locator('[data-sender-email]')).toContainText(
    'It stays until an Admin removes it.',
  );
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

test.describe('moderation', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('a moderator opens the list on waiting stories, oldest first, and reads a story with its history', async ({
    page,
  }) => {
    await useSession(page, 'moderator-reads');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Moderation' }),
    ).toBeVisible();
    // A moderator's menu has Moderation only: the other staff pages are for admins.
    const menu = page.getByRole('navigation', { name: 'Admin pages' });
    await expect(menu.getByRole('link')).toHaveText(['Moderation']);

    await expect(tab(page, 'Waiting for review')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(listItems(page)).toHaveCount(20);
    const first = listItems(page).first();
    await expect(first.locator('[data-list-title]')).toHaveText(
      'The night I stopped running',
    );
    await expect(first).toContainText('Video:');
    await expect(first.locator('[data-list-themes]')).toHaveText('Healing');
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(listItems(page)).toHaveCount(26);
    await expect(listItems(page).last()).toContainText('Just uploaded');
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(
      0,
    );

    // A written story sent back once with a note, then sent again.
    await page
      .locator('[data-list-item="mod_written"]')
      .getByRole('link')
      .click();
    await expect(page).toHaveURL(/\/moderation\/mod_written$/);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'A habit that became a faith',
      }),
    ).toBeVisible();
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Waiting for review',
    );
    await expect(page.getByRole('main')).toContainText(
      'Sent for review 1 November 2026 at 10:05 by Anonymous',
    );
    await expect(page.getByRole('list', { name: 'Themes' })).toContainText(
      'Doubt',
    );
    await expect(
      page.getByRole('img', { name: 'A photo shared with this story' }),
    ).toBeVisible();
    const history = page.locator('[data-history-entry]');
    await expect(history).toHaveCount(3);
    await expect(history.nth(1)).toContainText(
      'Sent back by e2e-moderator@heisreal.today',
    );
    await expect(history.nth(1)).toContainText(
      'Thank you for sharing this. Could you say a little more about what changed that winter?',
    );
    await expect(history.nth(2)).toContainText('Sent again by the person');

    // A video plays in Bunny's player with its speed menu on.
    await page.getByRole('link', { name: '← Back to the list' }).click();
    await page
      .locator('[data-list-item="mod_video"]')
      .getByRole('link')
      .click();
    const player = page.locator('[data-player] iframe');
    await expect(player).toHaveAttribute('src', /[?&]showSpeed=true(&|$)/);
    await expect(player).toHaveAttribute('src', /[?&]autoplay=false(&|$)/);
  });

  const decisions = (page: Page) => page.locator('[data-decisions]');
  const notice = (page: Page) => page.locator('[data-review-notice]');

  test('approve publishes it; the page then offers to take it down', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-approves'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await expect(notice(page)).toHaveText('Approved. It’s on the site now.');
    await expect(notice(page)).toBeFocused();
    await expect(page.locator('[data-review-status]')).toHaveText('Published');
    await expect(
      decisions(page).getByRole('button', { name: 'Take down' }),
    ).toBeVisible();
    await expect(page.locator('[data-history-entry]').last()).toContainText(
      'Approved by e2e-moderator@heisreal.today',
    );
  });

  test('send back and reject need a note, which the person will read', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-sends-back'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_written`);
    await decisions(page).getByRole('button', { name: 'Send back' }).click();
    const note = page.getByLabel('Your note to the person');
    await expect(note).toBeFocused();
    const send = decisions(page).getByRole('button', { name: 'Send back' });
    await expect(send).toBeDisabled();
    await note.fill('   ');
    await expect(send).toBeDisabled();
    await note.fill('Thank you. Could you say who helped you that winter?');
    await expect(decisions(page)).toContainText('52 / 2,000 characters');
    await send.click();
    await expect(notice(page)).toHaveText(
      'Sent back. The person can read your note.',
    );
    // Still open to moderators (MD-4), with nothing to decide.
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Sent back by a moderator',
    );
    await expect(decisions(page)).toHaveCount(0);

    // Cancel closes the note without deciding.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_long_title`);
    await decisions(page).getByRole('button', { name: 'Reject' }).click();
    await decisions(page).getByRole('button', { name: 'Cancel' }).click();
    await decisions(page).getByRole('button', { name: 'Reject' }).click();
    await page
      .getByLabel('Your note to the person')
      .fill('Thank you for sharing this with us.');
    await decisions(page).getByRole('button', { name: 'Reject' }).click();
    await expect(notice(page)).toHaveText(
      'Rejected. The person can read your note.',
    );
  });

  test('the first decision wins (D-1): the second moderator is told and the page refreshes', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-second'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_raced`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await expect(notice(page)).toHaveText(
      'Another moderator has already decided this story.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText('Rejected');
    // Now it's the rejection's buttons (OV-1 C), not the waiting story's.
    await expect(page.locator('[data-decisions] button')).toHaveText([
      'Approve',
      'Send back',
      'Put back in the waiting list',
    ]);
  });

  test('approval waits for the media, in plain words; only an Admin approves anyway, never in the upload-link hour', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-waits'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_processing`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    const refused = page.locator('[data-decision-refused]');
    await expect(refused).toHaveText(
      'The audio file is still being processed. Try again in a few minutes.',
    );
    await expect(
      page.getByRole('button', { name: 'Approve anyway' }),
    ).toHaveCount(0);

    // An Admin may approve anyway while it is still processing (G24)…
    await useSession(page, fresh('admin-approves-anyway'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_processing`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Approve anyway' }).click();
    await expect(notice(page)).toHaveText('Approved. It’s on the site now.');

    // …but not while the upload link could still replace the file (G11 B). The browser's clock is
    // fixed on the deadline's day, so the message names the time only, rounded up to the minute
    // (the stub's deadline is 14:05:59).
    await page.clock.setFixedTime(new Date('2026-11-01T13:30:00.000Z'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_cooldown`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await expect(refused).toHaveText(
      'The video is still being processed. You can approve it from 14:06.',
    );
    await expect(
      page.getByRole('button', { name: 'Approve anyway' }),
    ).toHaveCount(0);
  });

  test('take down a published story with a reason, and show it again (G5)', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-takes-down'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_published`);
    await expect(page.locator('[data-review-status]')).toHaveText('Published');
    await decisions(page).getByRole('button', { name: 'Take down' }).click();
    await page
      .getByLabel('Why it’s being taken down')
      .fill('A family member asked us to check it first.');
    await decisions(page).getByRole('button', { name: 'Take down' }).click();
    await expect(notice(page)).toHaveText(
      'Taken down. It stays off the site until a moderator shows it again.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Taken down by a moderator',
    );
    const last = page.locator('[data-history-entry]').last();
    await expect(last).toContainText(
      'Taken down by e2e-moderator@heisreal.today',
    );
    await expect(last).toContainText(
      'Why it was taken downA family member asked us to check it first.',
    );
    await decisions(page).getByRole('button', { name: 'Show again' }).click();
    await expect(notice(page)).toHaveText(
      'Shown again. It’s back on the site.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText('Published');
  });

  test('an audio file still being processed says so, with no player', async ({
    page,
  }) => {
    await useSession(page, 'moderator-processing');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_processing`);
    await expect(page.locator('[data-media-note="processing"]')).toHaveText(
      'This audio file is still being processed. Reload the page in a few minutes to watch it.',
    );
    await expect(page.locator('[data-player]')).toHaveCount(0);
  });

  // Part 1a (Joel, 2026-11-10; P1-5, P1-9, 2026-11-14): what moderators see of a file our side
  // couldn't check, and of one that couldn't be used.
  test('the list says when a story has a problem on our side', async ({
    page,
  }) => {
    await useSession(page, 'moderator-ours');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    const problems = page.locator('[data-list-problem]');
    await expect(problems).toHaveCount(1);
    await expect(
      page.locator('[data-list-item="mod_processing"] [data-list-problem]'),
    ).toHaveText('Can’t be reviewed yet: a problem on our side');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation?state=hidden`);
    await expect(
      page.locator('[data-list-item="mod_hidden_by_site"] [data-list-problem]'),
    ).toHaveText('A problem on our side');
    await expect(
      page.locator('[data-list-item="mod_taken_down"] [data-list-problem]'),
    ).toHaveCount(0);
  });

  test('a story sent back automatically shows it in its history, and an open page says when it changes', async ({
    page,
  }) => {
    await useSession(page, 'moderator-left');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    const history = page.locator('[data-history-entry]');
    await expect(history).toHaveCount(3);
    await expect(history.nth(1)).toContainText(
      'Sent back automatically: the video couldn’t be processed',
    );
    await expect(history.nth(1)).not.toContainText('by ');
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Waiting for review',
    );
    // A note being written when the story changes underneath.
    const NOTE = 'Please say a little more about how you came to faith.';
    const note = page.locator('[data-decisions] textarea');
    await page
      .locator('[data-decisions]')
      .getByRole('button', { name: 'Send back' })
      .click();
    await note.fill(NOTE);
    // Sent back while open: the page checks again when the tab is back in view.
    await page.route('**/v1/moderation/stories/mod_video', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'if-none-match': '' },
      });
      const body = await response.json();
      body.version += 1;
      body.status = 'editing';
      return route.fulfill({ response, json: body });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // It says so and waits: the page stays as it was, the note stays, the decisions are off.
    const stale = page.locator('[data-review-stale]');
    await expect(stale).toContainText(
      'This story changed while you had it open.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Waiting for review',
    );
    await expect(note).toHaveValue(NOTE);
    const decisions = page.locator('[data-decisions] button');
    await expect(decisions).toHaveCount(2);
    for (const button of await decisions.all())
      await expect(button).toBeDisabled();
    // Reload shows it as it is now.
    await stale.getByRole('button', { name: 'Reload to see it' }).click();
    await expect(stale).toHaveCount(0);
    await expect(page.locator('[data-review-status]')).not.toHaveText(
      'Waiting for review',
    );
  });

  test('an Admin’s open delete step waits once the story changes underneath', async ({
    page,
  }) => {
    await useSession(page, fresh('admin-stale-delete'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    await decisions(page).getByRole('button', { name: 'Delete' }).click();
    const confirm = page.locator('[data-confirm-delete]');
    await expect(
      confirm.getByRole('button', { name: 'Delete story' }),
    ).toBeEnabled();
    // Sent back while open: the page checks again when the tab is back in view.
    await page.route('**/v1/moderation/stories/mod_video', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'if-none-match': '' },
      });
      const body = await response.json();
      body.version += 1;
      body.status = 'editing';
      return route.fulfill({ response, json: body });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[data-review-stale]')).toContainText(
      'This story changed while you had it open.',
    );
    // It can't delete what the Admin hasn't seen; "Keep it" still closes the step.
    await expect(
      confirm.getByRole('button', { name: 'Delete story' }),
    ).toBeDisabled();
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(
      decisions(page).getByRole('button', { name: 'Delete' }),
    ).toBeDisabled();
  });

  test('a story that’s gone says so', async ({ page }) => {
    await useSession(page, 'moderator-gone');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/no_such_story`);
    await expect(page.locator('[data-review-gone]')).toContainText(
      'This story isn’t here any more.',
    );
  });

  // MD-3 and MD-4: every story that isn't public, by state; drafts for Admins only. MQ-1 E: the
  // states are tabs with counts, links in the address (Back works).
  test('a moderator moves between the states’ tabs, each with its count', async ({
    page,
  }) => {
    await useSession(page, 'moderator-states');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    // Counts whatever the filters; no drafts for a moderator.
    await expect(tabs(page)).toHaveText([
      'Waiting for review(26)',
      'Being edited(2)',
      'Taken down(2)',
      'Rejected(1)',
    ]);
    await tab(page, 'Being edited').click();
    await expect(page).toHaveURL(/\/moderation\?state=editing$/);
    await expect(tab(page, 'Being edited')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(titles(page)).toHaveText([
      'Waiting for a word',
      'Changing a line',
    ]);
    // Off the Waiting for review tab the time column is "In this state".
    await expect(page.getByRole('main')).not.toContainText('Waiting:');
    await tab(page, 'Taken down').click();
    await expect(titles(page)).toHaveText([
      'A video that stopped playing',
      'The letter I never sent',
    ]);
    await page.goBack();
    await expect(page).toHaveURL(/state=editing$/);
    await expect(titles(page)).toHaveText([
      'Waiting for a word',
      'Changing a line',
    ]);
    await tab(page, 'Rejected').click();
    await expect(titles(page)).toHaveText(['Not for this site']);
    // A rejected story opens with its history, and its rejection can be overturned (OV-1 C).
    await listItems(page).first().getByRole('link').click();
    await expect(page.locator('[data-review-status]')).toHaveText('Rejected');
    await expect(page.locator('[data-decisions] button')).toHaveText([
      'Approve',
      'Send back',
      'Put back in the waiting list',
    ]);
    await expect(page.locator('[data-history-entry]')).toHaveCount(2);

    // Drafts never sent aren't a moderator's, even by address.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation?state=draft`);
    await expect(tab(page, 'Waiting for review')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_draft`);
    await expect(page.locator('[data-review-gone]')).toBeVisible();
  });

  // MQ-1 E and OQ-2 (Joel, 2026-11-17): search, sort, formats (any) and themes (all) in the side
  // panel, every one of them in the address.
  test('a moderator searches, sorts and filters by format and theme, and clears the filters', async ({
    page,
  }) => {
    await useSession(page, 'moderator-filters');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    let panel = await filters(page);
    // One format at a time, as browse, with each one's count within the tab.
    const format = (p: Locator) => p.getByLabel('Format', { exact: true });
    expect(await optionLabels(format(panel))).toEqual([
      'All formats',
      'Video (2)',
      'Audio (1)',
      'Written (23)',
    ]);
    await chooseOption(format(panel), 'Audio (1)');
    await expect(page).toHaveURL(/\/moderation\?format=audio$/);
    await expect(titles(page)).toHaveText(['Singing again']);
    panel = await filters(page);
    await chooseOption(format(panel), 'Video (2)');
    await expect(page).toHaveURL(/\/moderation\?format=video$/);
    await expect(titles(page)).toHaveText([
      'The night I stopped running',
      'Just uploaded',
    ]);
    // Clear filters: the whole list again.
    panel = await filters(page);
    await panel.getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/moderation$/);
    await expect(listItems(page)).toHaveCount(20);

    // Themes stack, as browse (BS-7, Joel 2026-11-21), with browse's own picker: the folded ones
    // open in place, each turns on and off on its own, and a story must carry every chosen one.
    const theme = (p: Locator, name: string) =>
      p.getByRole('link', { name, exact: true });
    panel = await filters(page);
    await panel.getByRole('button', { name: 'More themes' }).click();
    await theme(panel, 'Doubt').click();
    await expect(page).toHaveURL(/\?theme=doubt$/);
    await expect(titles(page)).toHaveText(['A habit that became a faith']);
    panel = await filters(page);
    await theme(panel, 'Healing').click();
    await expect(page).toHaveURL(/\?theme=doubt&theme=healing$/);
    for (const name of ['Doubt', 'Healing'])
      await expect(theme(panel, name)).toHaveAttribute('aria-current', 'true');
    // No story here is about both.
    await expect(page.locator('[data-list-empty]')).toContainText(
      'No stories match these filters.',
    );
    panel = await filters(page);
    await theme(panel, 'Doubt').click();
    await expect(page).toHaveURL(/\?theme=healing$/);
    await expect(titles(page)).toContainText(['The night I stopped running']);
    panel = await filters(page);
    await panel.getByRole('link', { name: 'Clear themes' }).click();
    await expect(page).toHaveURL(/\/moderation$/);
    await expect(listItems(page)).toHaveCount(20);
    // At most 10, as browse (Joel 2026-11-21): an 11th stays unchosen, with a note.
    const ten = [
      'answered_prayers',
      'doubt',
      'faith',
      'forgiveness',
      'grief',
      'joy',
      'peace',
      'salvation',
      'waiting',
      'healing',
    ].sort();
    await page.goto(
      `${WEB_SIGNED_IN_URL}/moderation?${ten.map((id) => `theme=${id}`).join('&')}`,
    );
    panel = await filters(page);
    await theme(panel, 'Hope').click();
    await expect(
      panel.getByRole('status').filter({
        hasText: 'You can choose up to 10 themes.',
      }),
    ).toBeVisible();
    await expect(theme(panel, 'Hope')).not.toHaveAttribute('aria-current');
    await expect(page).not.toHaveURL(/theme=hope/);
    // The format and theme together: both must match.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation?format=audio&theme=doubt`);
    await expect(page.locator('[data-list-empty]')).toContainText(
      'No stories match these filters.',
    );
    await page
      .locator('[data-list-empty]')
      .getByRole('link', { name: 'Clear filters' })
      .click();
    await expect(listItems(page)).toHaveCount(20);

    // A title search, ignoring capitals; with the sort, all in the address.
    panel = await filters(page);
    await panel.getByLabel('Search titles').fill('WAITING STORY 1');
    await panel.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/\?q=WAITING\+STORY\+1$/);
    await expect(titles(page)).toHaveText(
      Array.from({ length: 10 }, (_, i) => `Waiting story ${i + 10}`),
    );
    panel = await filters(page);
    await option(panel, 'Newest first').click();
    await expect(page).toHaveURL(/q=WAITING\+STORY\+1&sort=newest$/);
    await expect(titles(page).first()).toHaveText('Waiting story 19');
    // The address alone opens the same list (a shared link, a reload).
    await page.reload();
    panel = await filters(page);
    await expect(panel.getByLabel('Search titles')).toHaveValue(
      'WAITING STORY 1',
    );
    await expect(
      panel.getByRole('radio', { name: 'Newest first' }),
    ).toBeChecked();
    await expect(titles(page).first()).toHaveText('Waiting story 19');
    // Recently changed: the stories changed since they were sent come first.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation?sort=changed`);
    await expect(titles(page).nth(0)).toHaveText(
      'Averyveryverylongwordthatkeepsgoingwithoutanyspacesatalltoseethatitwraps',
    );
    await expect(titles(page).nth(1)).toHaveText('A habit that became a faith');
    // Filters stay as the tab changes.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation?theme=doubt`);
    await tab(page, 'Being edited').click();
    await expect(page).toHaveURL(/state=editing&theme=doubt$/);
    await expect(titles(page)).toHaveText(['Waiting for a word']);
  });

  // Codex round 1: two quick choices both count, even before the first has reached the address.
  test('a format and a theme chosen quickly, before the page has caught up, both count', async ({
    page,
  }) => {
    await useSession(page, 'moderator-quick');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(listItems(page)).toHaveCount(20);
    // Hold the page's own navigations (Next's RSC requests) until both are chosen.
    const held: (() => Promise<void>)[] = [];
    const navigation = (url: URL) =>
      url.pathname === '/moderation' && url.searchParams.has('_rsc');
    await page.route(navigation, (route) => {
      held.push(() => route.continue().catch(() => undefined));
    });
    const panel = await filters(page);
    const format = panel.getByLabel('Format', { exact: true });
    const healing = panel.getByRole('link', { name: 'Healing', exact: true });
    await chooseOption(format, 'Video (2)');
    await expectChosen(format, 'Video (2)');
    await healing.click();
    await expect(healing).toHaveAttribute('aria-current', 'true');
    await expectChosen(format, 'Video (2)');
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.unroute(navigation);
    await Promise.all(held.map((go) => go()));
    await expect(page).toHaveURL(/\/moderation\?format=video&theme=healing$/);
    await expect(titles(page)).toHaveText(['The night I stopped running']);
    // Back: the choices follow the address again.
    await page.goBack();
    await expect(page).not.toHaveURL(/theme=healing/);
    const back = await filters(page);
    await expect(
      back.getByRole('link', { name: 'Healing', exact: true }),
    ).not.toHaveAttribute('aria-current', 'true');

    // Codex round 2: Clear filters, pressed before a choice has reached the address, drops it
    // too, even though it leads back to the address the page is already on.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(listItems(page)).toHaveCount(20);
    held.length = 0;
    await page.route(navigation, (route) => {
      held.push(() => route.continue().catch(() => undefined));
    });
    const again = await filters(page);
    const healing2 = again.getByRole('link', { name: 'Healing', exact: true });
    await healing2.click();
    await expect(healing2).toHaveAttribute('aria-current', 'true');
    await again.getByRole('link', { name: 'Clear filters' }).click();
    await expect(healing2).not.toHaveAttribute('aria-current', 'true');
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.unroute(navigation);
    await Promise.all(held.map((go) => go()));
    await expect(page).toHaveURL(/\/moderation$/);
    await expect(listItems(page)).toHaveCount(20);
    await expect(healing2).not.toHaveAttribute('aria-current', 'true');
    // A later choice builds on the cleared filters, not the dropped one.
    await option(again, 'Newest first').click();
    await expect(page).toHaveURL(/\/moderation\?sort=newest$/);
    await expect(titles(page).first()).toHaveText('Just uploaded');

    // A format chosen after a state tab, before the tab's page has loaded, keeps the new state.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(listItems(page)).toHaveCount(20);
    held.length = 0;
    await page.route(navigation, (route) => {
      held.push(() => route.continue().catch(() => undefined));
    });
    await tab(page, 'Being edited').click();
    await expect(tab(page, 'Being edited')).toHaveAttribute(
      'aria-current',
      'page',
    );
    const third = await filters(page);
    const thirdFormat = third.getByLabel('Format', { exact: true });
    await chooseOption(thirdFormat, 'Video (2)');
    await expectChosen(thirdFormat, 'Video (2)');
    await expect(tab(page, 'Being edited')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.unroute(navigation);
    await Promise.all(held.map((go) => go()));
    await expect(page).toHaveURL(/\/moderation\?state=editing&format=video$/);
    await expect(page.locator('[data-list-empty]')).toContainText(
      'No stories match these filters.',
    );
    // Back: the tabs and filters follow the address again.
    await page.goBack();
    await expect(page).not.toHaveURL(/format=video/);
    await expectChosen(
      (await filters(page)).getByLabel('Format', { exact: true }),
      'All formats',
    );
  });

  // OQ-2: on Waiting for review, the time turns orange after 2 days and red after 7.
  test('the Waiting column shows how long each story has waited, orange after 2 days and red after 7', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-11-08T10:00:00.000Z'));
    await useSession(page, 'moderator-waiting');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    const waiting = (id: string) =>
      page.locator(`[data-list-item="${id}"] [data-list-waiting]`);
    // Sent 1 November 09:05: 7 days and 55 minutes.
    await expect(waiting('mod_video')).toHaveText(/7 days$/);
    await expect(waiting('mod_video')).toHaveAttribute(
      'data-list-waiting',
      'overdue',
    );
    // Sent 2 November 04:05: 6 days.
    await expect(waiting('mod_wait_20')).toHaveText(/6 days$/);
    await expect(waiting('mod_wait_20')).toHaveAttribute(
      'data-list-waiting',
      'late',
    );
    await page.clock.setFixedTime(new Date('2026-11-01T11:19:00.000Z'));
    await page.reload();
    await expect(waiting('mod_video')).toHaveText(/2 h 14 min$/);
    await expect(waiting('mod_video')).toHaveAttribute('data-list-waiting', '');
    // Other tabs: the same time, "In this state", never coloured.
    await page.clock.setFixedTime(new Date('2026-11-30T10:00:00.000Z'));
    await tab(page, 'Being edited').click();
    await expect(
      listItems(page).first().locator('[data-list-waiting]'),
    ).toHaveAttribute('data-list-waiting', '');
  });

  // Phones: the tabs scroll sideways; the panel folds into "Filters and sort (N)".
  test('on a phone the filters fold into “Filters and sort”, counting those on', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'phone-320', 'phones only');
    await useSession(page, 'moderator-phone');
    await page.goto(
      `${WEB_SIGNED_IN_URL}/moderation?format=video&theme=healing`,
    );
    const toggle = page.getByRole('button', { name: 'Filters and sort (2)' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.getByRole('region', { name: 'Filters and sort' }),
    ).toBeHidden();
    await expect(titles(page)).toHaveText(['The night I stopped running']);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('region', { name: 'Filters and sort' });
    await expect(panel.getByLabel('Format', { exact: true })).toHaveValue(
      'video',
    );
    await toggle.click();
    await expect(panel).toBeHidden();
    // The tabs scroll sideways inside themselves; the page doesn't.
    const strip = page.locator('[data-state-tabs]');
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      true,
    );
    await expectNoHorizontalOverflow(page);
  });

  test('an Admin also lists drafts never sent, and opens one', async ({
    page,
  }) => {
    await useSession(page, 'admin-drafts');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(tab(page, 'Drafts never sent')).toHaveText(
      'Drafts never sent(1)',
    );
    await tab(page, 'Drafts never sent').click();
    await expect(page).toHaveURL(/\?state=draft$/);
    await expect(titles(page)).toHaveText(['Half written']);
    await expect(
      listItems(page).first().locator('[data-list-sent]'),
    ).toHaveText('Never sent');
    await listItems(page).first().getByRole('link').click();
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Draft, never sent',
    );
    await expect(page.getByRole('main')).toContainText('Never sent for review');
    // Nothing to decide: only an Admin's Delete (P1-11).
    await expect(decisions(page).getByRole('button')).toHaveText(['Delete']);
  });

  // P1-11: Admins delete a story in any state, after one question; Moderators never see it.
  test('an Admin deletes a story after “This can’t be undone”; a moderator has no Delete', async ({
    page,
  }) => {
    await useSession(page, fresh('admin-deletes'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_published`);
    await decisions(page).getByRole('button', { name: 'Delete' }).click();
    const confirm = page.locator('[data-confirm-delete]');
    await expect(confirm).toContainText('This can’t be undone.');
    await expect(confirm).toContainText('it comes off the site');
    // Keep it: nothing happens.
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('[data-review-status]')).toHaveText('Published');
    await decisions(page).getByRole('button', { name: 'Delete' }).click();
    // Focus lands on the question, never on the danger button (CD-1 A).
    await expect(
      confirm.getByText('Delete this story for good?'),
    ).toBeFocused();
    await expect(
      confirm.getByRole('button', { name: 'Delete story' }),
    ).not.toBeFocused();
    await confirm.getByRole('button', { name: 'Delete story' }).click();
    await expect(notice(page)).toHaveText(
      'Deleted. The story and its files are gone.',
    );
    await expect(page.locator('[data-review-gone]')).toBeVisible();

    // A moderator, on any story: no Delete.
    await useSession(page, fresh('moderator-no-delete'));
    for (const id of ['mod_published', 'mod_video', 'mod_rejected']) {
      await page.goto(`${WEB_SIGNED_IN_URL}/moderation/${id}`);
      await expect(page.locator('[data-review-status]')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Delete', exact: true }),
      ).toHaveCount(0);
    }
  });

  // OV-1 C, OV-2 A (Joel, 2026-11-20): a rejection or a take-down can be overturned.
  test('a rejected story can be put back in the waiting list, then decided again', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-puts-back'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_rejected`);
    await expect(page.locator('#decide-heading')).toHaveText(
      'Overturn the rejection',
    );
    // No note and no question: it goes back as it was.
    await decisions(page)
      .getByRole('button', { name: 'Put back in the waiting list' })
      .click();
    await expect(notice(page)).toHaveText(
      'Put back in the waiting list. Any moderator can decide it again.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Waiting for review',
    );
    await expect(page.locator('[data-history-entry]').last()).toContainText(
      'Put back in the waiting list by e2e-moderator@heisreal.today',
    );
    await expect(page.locator('[data-decisions] button')).toHaveText([
      'Approve',
      'Send back',
      'Reject',
    ]);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await expect(page.locator('[data-review-status]')).toHaveText('Published');
  });

  test('a rejected story can be approved straight away', async ({ page }) => {
    await useSession(page, fresh('moderator-overturns'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_rejected`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await expect(notice(page)).toHaveText('Approved. It’s on the site now.');
    await expect(page.locator('[data-review-status]')).toHaveText('Published');
  });

  test('any taken-down story can be shown again, sent back or rejected; a rejected one sent back', async ({
    page,
  }) => {
    await useSession(page, fresh('moderator-rejects-hidden'));
    for (const id of ['mod_taken_down', 'mod_hidden_by_site']) {
      await page.goto(`${WEB_SIGNED_IN_URL}/moderation/${id}`);
      await expect(page.locator('[data-decisions] button')).toHaveText([
        'Show again',
        'Send back',
        'Reject',
      ]);
    }
    // Taken down by a moderator, then rejected with a note.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_taken_down`);
    await decisions(page).getByRole('button', { name: 'Reject' }).click();
    await page
      .getByLabel('Your note to the person')
      .fill('Thank you for sharing this. We can’t name the people in it.');
    await decisions(page).getByRole('button', { name: 'Reject' }).click();
    await expect(notice(page)).toHaveText(
      'Rejected. The person can read your note.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText('Rejected');
    // Then sent back after all: the person can change it.
    await decisions(page).getByRole('button', { name: 'Send back' }).click();
    await page
      .getByLabel('Your note to the person')
      .fill('Please leave out the surnames and send it again.');
    await decisions(page).getByRole('button', { name: 'Send back' }).click();
    await expect(notice(page)).toHaveText(
      'Sent back. The person can read your note.',
    );
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Sent back by a moderator',
    );
  });

  // MD-1: Take down on the story's public page, for moderators only.
  test('a moderator takes a story down from its public page; others never see the button', async ({
    page,
  }) => {
    const story = `${WEB_SIGNED_IN_URL}/stories/test-story-walking-skeleton`;
    const takeDown = page.locator('[data-take-down]');
    // A visitor, and a signed-in User, see the story with no Take down.
    await page.goto('/stories/test-story-walking-skeleton');
    await expect(page.locator('[data-story-text]')).toBeVisible();
    await expect(takeDown).toHaveCount(0);
    await useSession(page, 'user-reader');
    await page.goto(story);
    await expect(
      page.getByRole('button', { name: /^Account: / }),
    ).toBeVisible();
    await expect(page.locator('[data-story-text]')).toBeVisible();
    await expect(takeDown).toHaveCount(0);

    await useSession(page, fresh('moderator-public'));
    await page.goto(story);
    await takeDown.getByRole('button', { name: 'Take down' }).click();
    const reason = page.getByLabel('Why it’s being taken down');
    await expect(reason).toBeFocused();
    await expect(takeDown).toContainText('The person can read this');
    const confirm = takeDown.getByRole('button', { name: 'Take down' });
    await expect(confirm).toBeDisabled();
    // OT-2 A: why it's greyed out, under it and read with it.
    await expect(confirm).toHaveAccessibleDescription('Write a reason first.');
    await reason.fill('Someone named in it asked us to check it first.');
    await expect(takeDown.getByText('Write a reason first.')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await confirm.click();
    await expect(page.locator('[data-take-down-notice]')).toHaveText(
      'Taken down. It stays off the site until a moderator shows it again.',
    );
    await takeDown.getByRole('link', { name: 'Open its review page' }).click();
    await expect(page.locator('[data-review-status]')).toHaveText(
      'Taken down by a moderator',
    );
    await expect(page.locator('[data-history-entry]').last()).toContainText(
      'Someone named in it asked us to check it first.',
    );
  });

  test('when api-admin fails, the page says only to try again later', async ({
    page,
  }) => {
    await useSession(page, 'moderator-fails');
    await page.route('**/v1/moderation/stories?*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          code: 'something_internal',
        }),
      }),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(page.locator('[data-moderation-error]')).toHaveText(
      'Something went wrong. Please try again later.',
    );
  });

  test('only for moderators and up: a User is told so and sees no stories', async ({
    page,
  }) => {
    await useSession(page, 'user-not-moderator');
    for (const path of ['/moderation', '/moderation/mod_video']) {
      await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
      await expect(page.locator('[data-admin-refused]')).toHaveText(
        'This page is for moderators.',
      );
      await expect(page.locator('[data-list-item]')).toHaveCount(0);
      await expect(page.locator('[data-history]')).toHaveCount(0);
      // Nor any staff link in the menu.
      await expect(
        page.getByRole('navigation', { name: 'Admin pages' }).getByRole('link'),
      ).toHaveCount(0);
    }
  });

  test('an admin’s menu has Moderation beside the admin pages', async ({
    page,
  }) => {
    await useSession(page, 'admin-menu');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(listItems(page)).toHaveCount(20);
    await expect(
      page.getByRole('navigation', { name: 'Admin pages' }).getByRole('link'),
    ).toHaveText([
      'Moderation',
      'Consent & legal',
      'Submission limits',
      'Themes',
      'Staff',
      'Block list',
    ]);
  });

  test('an admin, never a moderator, sees the email and address a story was sent with, and blocks each on the page (EM-1 B, EM-2)', async ({
    page,
  }) => {
    await useSession(page, 'moderator-no-sender');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    await expect(page.locator('[data-history-entry]').first()).toBeVisible();
    await expect(page.locator('[data-sender]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Block' })).toHaveCount(0);

    await useSession(page, fresh('admin-blocks'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    const email = page.locator('[data-sender-email]');
    const ip = page.locator('[data-sender-ip]');
    await expect(email).toContainText(
      'Sent with email robin.test@example.com. Only admins see this.',
    );
    await expect(ip).toContainText(
      'Sent from IP address 203.0.113.7. Only admins see this, for 30 days.',
    );
    await expect(page.locator('[data-sender]').getByRole('link')).toHaveCount(
      0,
    );
    // Block, then a short confirm; Cancel changes nothing.
    await email.getByRole('button', { name: 'Block' }).click();
    await expect(email).toContainText(
      'Block robin.test@example.com? It stays until an Admin removes it.',
    );
    await email.getByRole('button', { name: 'Cancel' }).click();
    await expect(email.locator('[data-sender-blocked]')).toHaveCount(0);
    await email.getByRole('button', { name: 'Block' }).click();
    // The note box starts with the story's title and when it was sent (BN-7 A); the Admin adds why.
    const note = email.getByLabel('Why is it blocked?');
    await expect(note).toBeFocused();
    await expect(note).toHaveValue(
      /^Story "The night I stopped running" \(sent \d{1,2} \w{3,4} \d{4}\): $/,
    );
    await page.keyboard.type('Advert spam.');
    await email.getByRole('button', { name: 'Block' }).click();
    await expect(email.locator('[data-sender-blocked]')).toHaveText('Blocked');
    await expect(page).toHaveURL(/\/moderation\/mod_video$/);
    // The address still has its own button.
    await expect(ip.getByRole('button', { name: 'Block' })).toBeVisible();
    // Opened again, the page says it's blocked; so does the Block list page.
    await page.reload();
    await expect(email.locator('[data-sender-blocked]')).toHaveText('Blocked');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/block-list`);
    await expect(
      page.locator('[data-blocked="robin.test@example.com"] [data-block-note]'),
    ).toHaveText(
      /^Story "The night I stopped running" \(sent .+\): Advert spam\.$/,
    );

    // A story whose address is past 30 days shows only its email, here already blocked.
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_written`);
    await expect(page.locator('[data-sender-ip]')).toHaveCount(0);
    await expect(
      page.locator('[data-sender-email] [data-sender-blocked]'),
    ).toHaveText('Blocked');
  });

  test('the history names the staff member who took each action, to staff (EM-1)', async ({
    page,
  }) => {
    await useSession(page, fresh('admin-approves-named'));
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    await decisions(page).getByRole('button', { name: 'Approve' }).click();
    await expect(notice(page)).toHaveText('Approved. It’s on the site now.');
    await expect(page.locator('[data-history-entry]').last()).toContainText(
      'Approved by e2e-admin@heisreal.today',
    );
  });
});

test('the stub api-admin’s moderation answers fit the contract', async ({
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
  const contract = new Contract('api-admin.yaml');
  // Its own session: the decisions below change it.
  const mine = fresh('moderator-contract');
  const check = async (path: string, session = mine) => {
    const res = await request.get(`${STUB_USER_URL}${path}`, {
      headers: { authorization: `Bearer ${fixtureToken(session)}` },
    });
    const text = await res.text();
    expect(
      contract.problems({
        method: 'GET',
        path: new URL(res.url()).pathname,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: text === '' ? undefined : JSON.parse(text),
      }),
      path,
    ).toEqual([]);
    return { status: res.status(), body: text ? JSON.parse(text) : undefined };
  };
  const first = await check('/v1/moderation/stories');
  const second = await check(
    `/v1/moderation/stories?cursor=${first.body.nextCursor}`,
  );
  const listed = [...first.body.data, ...second.body.data];
  for (const state of ['editing', 'hidden', 'rejected']) {
    listed.push(
      ...(await check(`/v1/moderation/stories?state=${state}`)).body.data,
    );
  }
  listed.push(
    ...(
      await check('/v1/moderation/stories?state=draft', fresh('admin-contract'))
    ).body.data,
  );
  for (const s of listed) {
    expect((await check(`/v1/moderation/stories/${s.id}`)).status).toBe(
      s.state === 'draft' ? 404 : 200,
    );
  }
  // An Admin's view carries the address it was sent from (block list).
  expect(
    (await check('/v1/moderation/stories/mod_video', 'admin-contract')).body
      .senderIp,
  ).toBe('203.0.113.7');
  expect(
    (await check('/v1/moderation/stories/mod_video', 'admin-contract')).body
      .senderEmail,
  ).toBe('robin.test@example.com');
  for (const id of ['mod_published', 'mod_taken_down']) {
    expect((await check(`/v1/moderation/stories/${id}`)).status).toBe(200);
  }
  expect(
    (await check('/v1/moderation/stories/mod_draft', fresh('admin-contract')))
      .status,
  ).toBe(200);
  // MQ-1 E: filtered (one format and stacked themes, as browse), sorted and paged; the counts (an
  // Admin's with drafts). A repeated format, or more than 10 themes, is refused, as browse
  // refuses it.
  for (const sort of ['oldest', 'newest', 'changed']) {
    const filtered = await check(
      `/v1/moderation/stories?q=story&format=written&theme=doubt&theme=healing&sort=${sort}`,
    );
    expect(filtered.status).toBe(200);
    const paged = await check(`/v1/moderation/stories?sort=${sort}`);
    expect(
      (
        await check(
          `/v1/moderation/stories?sort=${sort}&cursor=${paged.body.nextCursor}`,
        )
      ).status,
    ).toBe(200);
  }
  expect(first.body.counts.states).not.toHaveProperty('draft');
  expect(
    (await check('/v1/moderation/stories', fresh('admin-contract'))).body.counts
      .states,
  ).toHaveProperty('draft', 1);
  for (const bad of [
    'q=',
    'format=film',
    'format=video&format=audio',
    Array.from({ length: 11 }, (_, i) => `theme=t${i}`).join('&'),
    'sort=random',
    'limit=0',
  ]) {
    expect((await check(`/v1/moderation/stories?${bad}`)).status, bad).toBe(
      400,
    );
  }
  expect((await check('/v1/moderation/stories?state=draft')).status).toBe(403);
  // The decisions' answers too: applied, a missing note, a stale tag, a refusal.
  const post = async (path: string, body: unknown, ifMatch?: string) => {
    const res = await request.post(`${STUB_USER_URL}${path}`, {
      headers: {
        authorization: `Bearer ${fixtureToken(mine)}`,
        ...(ifMatch ? { 'if-match': ifMatch } : {}),
      },
      data: body,
    });
    const text = await res.text();
    expect(
      contract.problems({
        method: 'POST',
        path: new URL(res.url()).pathname,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: text === '' ? undefined : JSON.parse(text),
      }),
      path,
    ).toEqual([]);
    return res.status();
  };
  const { body: published } = await check(
    '/v1/moderation/stories/mod_published',
  );
  const tag = `"${published.reviewTag}"`;
  expect(await post('/v1/moderation/stories/mod_published/hide', {}, tag)).toBe(
    400,
  );
  expect(
    await post(
      '/v1/moderation/stories/mod_published/hide',
      { reason: 'Checking.' },
      '"old"',
    ),
  ).toBe(412);
  expect(
    await post('/v1/moderation/stories/mod_published/approve', {}, tag),
  ).toBe(409);
  expect(
    await post(
      '/v1/moderation/stories/mod_published/hide',
      { reason: 'Checking.' },
      tag,
    ),
  ).toBe(200);
  expect(
    await post(
      '/v1/moderation/stories/mod_cooldown/approve',
      {},
      '"mod_cooldown-1"',
    ),
  ).toBe(409);
  expect((await check('/v1/moderation/stories/no_such')).status).toBe(404);
  expect((await check('/v1/moderation/stories', 'user-x')).status).toBe(403);
  // An Admin's Delete (P1-11): Moderators refused (DEL-2 A); no If-Match (DEL-3), then gone.
  const admin = fresh('admin-contract-delete');
  const remove = async (session: string) => {
    const res = await request.delete(
      `${STUB_USER_URL}/v1/moderation/stories/mod_written`,
      { headers: { authorization: `Bearer ${fixtureToken(session)}` } },
    );
    const text = await res.text();
    expect(
      contract.problems({
        method: 'DELETE',
        path: new URL(res.url()).pathname,
        status: res.status(),
        contentType: res.headers()['content-type'] ?? null,
        body: text === '' ? undefined : JSON.parse(text),
      }),
    ).toEqual([]);
    return res.status();
  };
  expect(await remove(mine)).toBe(403);
  expect(await remove(admin)).toBe(204);
  expect(await remove(admin)).toBe(404);
  expect(
    (await check('/v1/moderation/stories/mod_written', admin)).status,
  ).toBe(404);
});

import { expect, type Page, test } from '@playwright/test';
import { Contract } from '@heisreal/contracts/testing';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// The moderators' read side (M3 plan PR 1; tasks 3.1 and 3.2): /moderation lists the stories
// waiting for review, oldest sent first, and /moderation/{id} shows one as the public would see it
// (the story page's own parts, with the player's speed menu) and its history with moderators'
// notes. No decisions yet. Moderators and up only; the admin menu shows Moderation to them. The
// pages fit every device; the behaviour runs on one phone and one desktop. The stub api-admin
// (stub-api-user.mjs) serves one fixed queue; sessions starting `moderator` are Moderators.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

const queueItems = (page: Page) => page.locator('[data-queue-item]');

test('/moderation and a story under review fit, with 44 px targets', async ({
  page,
}) => {
  await useSession(page, 'moderator-fit');
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
  await expect(queueItems(page)).toHaveCount(20);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  for (const id of ['mod_video', 'mod_written', 'mod_long_title']) {
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/${id}`);
    await expect(page.locator('[data-history-entry]').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  }
});

test.describe('moderation', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('a moderator opens the queue, oldest first, and reads a story with its history', async ({
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

    await expect(queueItems(page)).toHaveCount(20);
    await expect(queueItems(page).first()).toContainText(
      'The night I stopped running',
    );
    await expect(queueItems(page).first()).toContainText(
      'Video · sent 1 November 2026 at 09:05',
    );
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(queueItems(page)).toHaveCount(24);
    await expect(queueItems(page).last()).toContainText('Waiting story 24');
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(
      0,
    );

    // A written story sent back once with a note, then sent again.
    await page.locator('[data-queue-item="mod_written"]').click();
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
      page.getByRole('img', { name: 'A church in the snow' }),
    ).toBeVisible();
    const history = page.locator('[data-history-entry]');
    await expect(history).toHaveCount(3);
    await expect(history.nth(1)).toContainText(
      'Sent back for changes by a moderator',
    );
    await expect(history.nth(1)).toContainText(
      'Thank you for sharing this. Could you say a little more about what changed that winter?',
    );
    await expect(
      page.getByRole('button', { name: /approve|reject/i }),
    ).toHaveCount(0);

    // A video plays in Bunny's player with its speed menu on.
    await page.getByRole('link', { name: '← Back to the queue' }).click();
    await page.locator('[data-queue-item="mod_video"]').click();
    const player = page.locator('[data-player] iframe');
    await expect(player).toHaveAttribute('src', /[?&]showSpeed=true(&|$)/);
    await expect(player).toHaveAttribute('src', /[?&]autoplay=false(&|$)/);
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

  // Part 1a (Joel, 2026-11-10): what moderators see of a file that couldn't be used.
  test('the queue says when a story can’t be reviewed yet because of a problem on our side', async ({
    page,
  }) => {
    await useSession(page, 'moderator-ours');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
    await expect(queueItems(page)).toHaveCount(20);
    const problems = page.locator('[data-queue-problem]');
    await expect(problems).toHaveCount(1);
    await expect(problems).toHaveText(
      'Can’t be reviewed yet: a problem on our side',
    );
    await expect(
      page.locator('[data-queue-item="mod_processing"] [data-queue-problem]'),
    ).toBeVisible();
  });

  test('a story sent back automatically shows it in its history, and an open page says when it leaves', async ({
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
    await expect(page.locator('[data-review-left]')).toHaveCount(0);
    // Sent back while open: api-admin no longer has it under review, and the page checks
    // again when the tab is back in view.
    await page.route('**/v1/moderation/stories/mod_video', (route) =>
      route.request().method() === 'OPTIONS'
        ? route.continue()
        : route.fulfill({
            status: 404,
            headers: { 'access-control-allow-origin': '*' },
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'about:blank',
              title: 'Not Found',
              status: 404,
              code: 'not_found',
            }),
          }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[data-review-left]')).toContainText(
      'This story is no longer waiting for review',
    );
    await expect(
      page.locator('[data-review-left]').getByRole('link', {
        name: 'Back to the queue',
      }),
    ).toHaveAttribute('href', '/moderation');
  });

  test('a story no longer waiting for review says so', async ({ page }) => {
    await useSession(page, 'moderator-gone');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/no_such_story`);
    await expect(page.locator('[data-review-gone]')).toContainText(
      'This story isn’t waiting for review.',
    );
  });

  test('when api-admin fails, the page says only to try again later', async ({
    page,
  }) => {
    await useSession(page, 'moderator-fails');
    await page.route('**/v1/moderation/queue', (route) =>
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
      await expect(page.locator('[data-queue-item]')).toHaveCount(0);
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
    await expect(queueItems(page)).toHaveCount(20);
    await expect(
      page.getByRole('navigation', { name: 'Admin pages' }).getByRole('link'),
    ).toHaveText([
      'Moderation',
      'Consent & legal',
      'Submission limits',
      'Themes',
      'Staff',
    ]);
  });
});

test('the stub api-admin’s moderation answers fit the contract', async ({
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
  const contract = new Contract('api-admin.yaml');
  const check = async (path: string, session = 'moderator-contract') => {
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
  const first = await check('/v1/moderation/queue');
  const second = await check(
    `/v1/moderation/queue?cursor=${first.body.nextCursor}`,
  );
  for (const s of [...first.body.data, ...second.body.data]) {
    expect((await check(`/v1/moderation/stories/${s.id}`)).status).toBe(200);
  }
  expect((await check('/v1/moderation/queue?limit=0')).status).toBe(400);
  expect((await check('/v1/moderation/stories/no_such')).status).toBe(404);
  expect((await check('/v1/moderation/queue', 'user-x')).status).toBe(403);
});

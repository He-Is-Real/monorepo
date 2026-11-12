import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { Contract } from '@heisreal/contracts/testing';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// The moderators' pages (M3 plan PRs 1 and 6): /moderation lists the stories waiting for review,
// oldest sent first, and /moderation/{id} shows one as the public would see it (the story page's
// own parts, with the player's speed menu), what the moderator can do with it, and its history
// with moderators' notes. Approve, Send back and Reject a waiting story (a note for the last two),
// Take down a published one and Show it again (G5); refusals in plain words; the first decision
// wins (D-1); only an Admin approves anyway, never in the upload-link hour (G11 B, G24).
// Moderators and up only; the admin menu shows Moderation to them. The pages fit every device;
// the behaviour runs on one phone and one desktop. The stub api-admin (stub-api-user.mjs) serves
// one fixed queue and keeps each session's decisions; sessions starting `moderator` are
// Moderators, `admin` Admins.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

/** A session of its own (the stub keeps each session's decisions): `prefix` sets the role. */
const fresh = (prefix: string) => `${prefix}-${randomUUID()}`;

const queueItems = (page: Page) => page.locator('[data-queue-item]');

test('/moderation and a story under review fit, with 44 px targets', async ({
  page,
}) => {
  await useSession(page, 'moderator-fit');
  await page.goto(`${WEB_SIGNED_IN_URL}/moderation`);
  await expect(queueItems(page)).toHaveCount(20);
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
    await expect(history.nth(1)).toContainText('Sent back by a moderator');
    await expect(history.nth(1)).toContainText(
      'Thank you for sharing this. Could you say a little more about what changed that winter?',
    );
    await expect(history.nth(2)).toContainText('Sent again by the person');

    // A video plays in Bunny's player with its speed menu on.
    await page.getByRole('link', { name: '← Back to the queue' }).click();
    await page.locator('[data-queue-item="mod_video"]').click();
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
      'Approved by a moderator',
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
    await expect(page.locator('[data-review-gone]')).toBeVisible();

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
    await expect(page.locator('[data-review-gone]')).toBeVisible();
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
    await expect(last).toContainText('Taken down by a moderator');
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
      'Block list',
    ]);
  });

  test('an admin, never a moderator, sees the address a story was sent from, with a link to block it', async ({
    page,
  }) => {
    await useSession(page, 'moderator-no-ip');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    await expect(page.locator('[data-history-entry]').first()).toBeVisible();
    await expect(page.locator('[data-sender-ip]')).toHaveCount(0);

    await useSession(page, 'admin-sees-ip');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    const ip = page.locator('[data-sender-ip]');
    await expect(ip).toContainText(
      'Sent from IP address 203.0.113.7. Only admins see this, for 30 days.',
    );
    await ip.getByRole('link', { name: 'Block this address' }).click();
    await expect(page).toHaveURL(/\/admin\/block-list\?ip=203\.0\.113\.7$/);
    await expect(page.getByLabel('IP address', { exact: true })).toHaveValue(
      '203.0.113.7',
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
  const first = await check('/v1/moderation/queue');
  const second = await check(
    `/v1/moderation/queue?cursor=${first.body.nextCursor}`,
  );
  for (const s of [...first.body.data, ...second.body.data]) {
    expect((await check(`/v1/moderation/stories/${s.id}`)).status).toBe(200);
  }
  // An Admin's view carries the address it was sent from (block list).
  expect(
    (await check('/v1/moderation/stories/mod_video', 'admin-contract')).body
      .senderIp,
  ).toBe('203.0.113.7');
  for (const id of ['mod_published', 'mod_taken_down']) {
    expect((await check(`/v1/moderation/stories/${id}`)).status).toBe(200);
  }
  expect((await check('/v1/moderation/queue?limit=0')).status).toBe(400);
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
  expect((await check('/v1/moderation/queue', 'user-x')).status).toBe(403);
});

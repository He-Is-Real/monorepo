import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  shots,
} from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// My profile (M2 plan PR 8), on the signed-in server against the stub api-user
// (stub-api-user.mjs, checked against api-user.yaml in contract.e2e.ts). Each test is its own
// person, seeded in the stub. The real api-user and database behind these answers (what may be
// withdrawn or deleted, and that a delete reaches every copy) is
// apps/api-user/integration/my-stories.int-spec.ts.

const PROFILE = `${WEB_SIGNED_IN_URL}/account`;
const FEEDBACK =
  'Thank you for sharing this. We felt it needs a little more about what changed for you.';
const LONG =
  'When everything I had built came apart in a single winter and I could not find a reason to carry on Supercalifragilisticexpialidociously';

/** A story of each status, as the stub keeps them. */
const EVERY_STATUS = [
  // Last changed 29 October 2026: kept 186 days (api-user's draftExpiresAt; the stub's 6 months).
  {
    id: 's_draft',
    status: 'draft',
    title: 'My draft',
    updatedAt: '2026-10-29T12:00:00.000Z',
  },
  { id: 's_pending', status: 'pending', title: 'Waiting one' },
  { id: 's_review', status: 'in_review', title: 'In review one' },
  {
    id: 's_live',
    status: 'approved',
    title: 'Published one',
    slug: 'published-one',
  },
  {
    id: 's_changes',
    status: 'changes_requested',
    title: 'Sent back one',
    rejectionFeedback: FEEDBACK,
  },
  { id: 's_rejected', status: 'rejected', title: 'Not accepted one' },
  { id: 's_withdrawn', status: 'withdrawn', title: 'Withdrawn one' },
].map((s, i) => ({
  ...s,
  tagSlugs: ['healing'],
  // Newest first in the list: the stub lists in reverse order of seeding.
  createdAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
}));

/** A new person for this test: their session in the stub, and in the page's storage. */
async function person(
  page: Page,
  request: APIRequestContext,
  seed: Record<string, unknown>,
  prefix = '',
) {
  const id = `${prefix}${randomUUID().replace(/-/g, '')}`;
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: { signupAccepted: true, ...seed },
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  const auth = { authorization: `Bearer ${fixtureToken(id)}` };
  const read = async (path: string) =>
    (await request.get(`${STUB_USER_URL}${path}`, { headers: auth })).json();
  return {
    id,
    stories: async () =>
      (
        (await read('/v1/account/stories')).data as {
          id: string;
          status: string;
        }[]
      ).map((s) => [s.id, s.status]),
    /** O4: the stories whose sharing beyond heisreal.today is granted. */
    shared: async () =>
      (
        (await read('/v1/account/stories')).data as {
          id: string;
          sharing: { granted: boolean };
        }[]
      )
        .filter((s) => s.sharing.granted)
        .map((s) => s.id),
    granted: async () =>
      (
        (await read('/v1/account/consents')).current as {
          type: string;
          granted: boolean;
        }[]
      )
        .filter((c) => c.granted)
        .map((c) => c.type),
  };
}

const row = (page: Page, title: string): Locator =>
  page.locator('[data-submission]').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('from the account menu: every status, its feedback and what each one offers', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: EVERY_STATUS,
    });
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    await page.getByRole('button', { name: /^Account: / }).click();
    await page.getByRole('link', { name: 'My profile' }).click();
    await expect(page).toHaveURL(PROFILE);
    await expect(page.locator('[data-submission]')).toHaveCount(7);

    const offers = async (title: string) => {
      const r = row(page, title);
      return {
        status: await r.locator('[data-status]').innerText(),
        actions: await r
          .locator('a, button')
          .evaluateAll((els) => els.map((e) => e.textContent?.trim())),
      };
    };
    expect(await offers('My draft')).toEqual({
      status: 'Draft',
      actions: ['Continue', 'Delete'],
    });
    // O4: every submitted story can be shared beyond heisreal.today, each on its own.
    const SHARE = 'Share beyond heisreal.today';
    expect(await offers('Waiting one')).toEqual({
      status: 'Waiting for review',
      actions: [SHARE, 'Withdraw'],
    });
    expect(await offers('In review one')).toEqual({
      status: 'In review',
      actions: [SHARE, 'Withdraw'],
    });
    expect(await offers('Published one')).toEqual({
      status: 'Published',
      actions: [SHARE, 'View', 'Withdraw'],
    });
    expect(await offers('Sent back one')).toEqual({
      status: 'Changes requested',
      actions: [SHARE, 'Withdraw', 'Delete'],
    });
    expect(await offers('Not accepted one')).toEqual({
      status: 'Not published',
      actions: ['Delete'],
    });
    expect(await offers('Withdrawn one')).toEqual({
      status: 'Withdrawn',
      actions: ['Delete'],
    });
    await expect(
      row(page, 'Sent back one').locator('[data-feedback]'),
    ).toContainText(FEEDBACK);
    // Only a draft says when it goes if nobody touches it.
    await expect(
      row(page, 'My draft').locator('[data-draft-expiry]'),
    ).toHaveText(
      'We’ll keep this draft until 3 May 2027. If you don’t change it before then, it will be deleted.',
    );
    await expect(page.locator('[data-draft-expiry]')).toHaveCount(1);
    await expect(
      row(page, 'Published one').getByRole('link', { name: 'View' }),
    ).toHaveAttribute('href', '/stories/published-one');
    await expect(
      row(page, 'My draft').getByRole('link', { name: 'Continue' }),
    ).toHaveAttribute('href', '/share?draft=s_draft');
  });

  test('download my data: a file of everything of mine, and nobody else’s', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: [
        {
          id: 'm1',
          status: 'approved',
          title: 'Only mine',
          slug: 'only-mine',
          shared: true,
        },
        { id: 'm2', status: 'draft', title: 'My draft' },
      ],
    });
    // Someone else in the stub, with a story of their own.
    const other = randomUUID().replace(/-/g, '');
    expect(
      (
        await request.post(`${STUB_USER_URL}/__e2e/sessions/${other}`, {
          data: {
            signupAccepted: true,
            stories: [{ id: 'o1', title: 'Someone else’s story' }],
          },
        })
      ).status(),
    ).toBe(204);
    await page.goto(PROFILE);
    const card = page.locator('[data-download-data]');
    const saving = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download my data' }).click();
    const download = await saving;
    expect(download.suggestedFilename()).toMatch(
      /^he-is-real-my-data-\d{4}-\d{2}-\d{2}\.json$/,
    );
    const text = await readFile(await download.path(), 'utf8');
    const file = JSON.parse(text) as {
      about: { sections: Record<string, string> };
      stories: {
        title: string;
        status: string;
        sharing: { granted: boolean };
      }[];
      consents: { type: string; storyId: string | null }[];
    };
    // O4: each story's own sharing choice, and the ledger event naming the story.
    expect(
      file.stories.map((s) => [s.title, s.status, s.sharing.granted]),
    ).toEqual([
      ['My draft', 'draft', false],
      ['Only mine', 'approved', true],
    ]);
    expect(file.consents.map((c) => [c.type, c.storyId])).toEqual([
      ['special_category_religious', null],
      ['publish', null],
      ['share_socials', 'm1'],
    ]);
    expect(Object.keys(file.about.sections).length).toBeGreaterThan(0);
    expect(text).not.toContain('Someone else');
    // Laid out to be read, not one long line.
    expect(text.split('\n').length).toBeGreaterThan(20);
    await expect(card.getByRole('status')).toHaveText(
      /^Your file he-is-real-my-data-.+\.json is saved to your downloads\. Its links to your videos and pictures work for one hour\.$/,
    );
  });

  test('download my data when it can’t be prepared: it says so, and trying again is possible', async ({
    page,
    request,
  }) => {
    await person(page, request, {}, 'export-fails');
    await page.goto(PROFILE);
    const card = page.locator('[data-download-data]');
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    await card.getByRole('button', { name: 'Download my data' }).click();
    await expect(card.getByRole('alert')).toHaveText(
      'We couldn’t prepare your file just now. Please try again in a moment.',
    );
    await expect(
      card.getByRole('button', { name: 'Download my data' }),
    ).toBeEnabled();
    expect(downloads).toBe(0);
  });

  test('withdraw a story waiting for review', async ({ page, request }) => {
    const me = await person(page, request, {
      stories: [{ id: 'w1', status: 'pending', title: 'Waiting one' }],
    });
    await page.goto(PROFILE);
    const story = row(page, 'Waiting one');
    await story.getByRole('button', { name: 'Withdraw' }).click();
    await story.getByRole('button', { name: 'Withdraw story' }).click();
    await expect(page.locator('[data-notice]')).toContainText(
      '“Waiting one” is withdrawn.',
    );
    await expect(story.locator('[data-status]')).toHaveText('Withdrawn');
    await expect(story.getByRole('button', { name: 'Delete' })).toBeVisible();
    expect(await me.stories()).toEqual([['w1', 'withdrawn']]);
  });

  test('delete a story sent back for changes, without withdrawing it first', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      stories: [
        {
          id: 'cr1',
          status: 'changes_requested',
          title: 'Sent back one',
          rejectionFeedback: FEEDBACK,
        },
      ],
    });
    await page.goto(PROFILE);
    const story = row(page, 'Sent back one');
    await story.getByRole('button', { name: 'Delete' }).click();
    await expect(story.locator('[data-confirm]')).toContainText(
      'Delete this story for good?',
    );
    await story.getByRole('button', { name: 'Delete story' }).click();
    await expect(page.locator('[data-notice]')).toContainText(
      '“Sent back one” is deleted.',
    );
    await expect(page.locator('[data-submission]')).toHaveCount(0);
    expect(await me.stories()).toEqual([]);
  });

  test('delete a draft, after saying so; “Keep it” keeps it', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      stories: [
        { id: 'd1', title: 'Keep me' },
        { id: 'd2', title: 'Delete me' },
      ],
    });
    await page.goto(PROFILE);
    const keep = row(page, 'Keep me');
    await keep.getByRole('button', { name: 'Delete' }).click();
    await keep.getByRole('button', { name: 'Keep it' }).click();
    await expect(keep.getByRole('button', { name: 'Delete' })).toBeVisible();

    const gone = row(page, 'Delete me');
    await gone.getByRole('button', { name: 'Delete' }).click();
    await expect(gone.locator('[data-confirm]')).toContainText(
      'This can’t be undone.',
    );
    await gone.getByRole('button', { name: 'Delete draft' }).click();
    await expect(page.locator('[data-notice]')).toContainText(
      '“Delete me” is deleted.',
    );
    await expect(page.locator('[data-submission]')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: 'My submissions' }),
    ).toBeFocused();
    expect(await me.stories()).toEqual([['d1', 'draft']]);
  });

  test('once the person signs out, what they did is never shown: not a notice, not one finishing late', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      stories: [
        { id: 'o1', title: 'Gone first' },
        { id: 'o2', title: 'Gone later' },
      ],
    });
    await page.goto(PROFILE);
    const first = row(page, 'Gone first');
    await first.getByRole('button', { name: 'Delete' }).click();
    await first.getByRole('button', { name: 'Delete draft' }).click();
    await expect(page.locator('[data-notice]')).toContainText(
      '“Gone first” is deleted.',
    );

    // The next delete is held on its way while the person signs out (here, or in another tab).
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`${STUB_USER_URL}/v1/stories/o2`, async (route) => {
      await held;
      await route.continue();
    });
    const later = row(page, 'Gone later');
    await later.getByRole('button', { name: 'Delete' }).click();
    const answered = page.waitForResponse(`${STUB_USER_URL}/v1/stories/o2`);
    await later.getByRole('button', { name: 'Delete draft' }).click();
    await page.getByRole('button', { name: /^Account: / }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('link', { name: 'Sign in' }).first(),
    ).toBeVisible();
    await expect(page.locator('[data-notice]')).toBeEmpty();

    release();
    await (await answered).finished();
    // Let the page take the answer in before looking.
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    expect(await me.stories()).toEqual([]);
    await expect(page.locator('[data-notice]')).toBeEmpty();
    await expect(page.getByText(/Gone (first|later)/)).toHaveCount(0);
  });

  test('a story that changed elsewhere isn’t deleted: the list catches up and says so', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      stories: [{ id: 'c1', title: 'Busy one' }],
    });
    await page.goto(PROFILE);
    const story = row(page, 'Busy one');
    await story.getByRole('button', { name: 'Delete' }).click();
    // Another tab submits it meanwhile.
    await page.route(`${STUB_USER_URL}/v1/stories/c1`, (route) =>
      route.fulfill({
        status: 412,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Precondition failed',
          status: 412,
          code: 'stale_version',
        }),
      }),
    );
    await story.getByRole('button', { name: 'Delete draft' }).click();
    await expect(story.getByRole('alert')).toContainText(
      'This story changed since the page loaded.',
    );
    expect(await me.stories()).toEqual([['c1', 'draft']]);
  });

  test('the one account-wide withdrawal is Delete my account; each story is taken down on its own', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: [
        { id: 't1', status: 'approved', title: 'Live one', slug: 'live-one' },
      ],
    });
    await page.goto(PROFILE);
    await expect(
      row(page, 'Live one').getByRole('button', { name: 'Withdraw' }),
    ).toBeVisible();
    // O4 (Joel, 2026-10-31): no "take all my stories off the site", and no account-wide sharing.
    await expect(
      page.getByRole('button', { name: /take all my stories off/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Privacy and consent' }),
    ).toHaveCount(0);
    const card = page.locator('[data-delete-account]');
    await expect(card).toContainText(
      'Withdraw your consent and delete your account',
    );
    await card.getByRole('button', { name: 'Delete my account' }).click();
    await expect(card).toContainText('It withdraws every consent you gave us');
  });

  test('share one story beyond heisreal.today and not another, then stop as easily', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: [
        { id: 'h1', status: 'approved', title: 'Home only', slug: 'home' },
        { id: 'h2', status: 'approved', title: 'Further', slug: 'further' },
      ],
    });
    await page.goto(PROFILE);
    const further = row(page, 'Further');
    const home = row(page, 'Home only');
    await expect(further.locator('[data-sharing="off"]')).toBeVisible();
    // Granting shows the box's words, what sharing means and the privacy policy it names.
    await further
      .getByRole('button', { name: 'Share beyond heisreal.today' })
      .click();
    await expect(further.locator('[data-confirm="share"]')).toContainText(
      'For this story only.',
    );
    await expect(
      further.getByText('What sharing beyond heisreal.today means'),
    ).toBeVisible();
    // "Not now" changes nothing.
    await further.getByRole('button', { name: 'Not now' }).click();
    expect(await me.shared()).toEqual([]);
    await further
      .getByRole('button', { name: 'Share beyond heisreal.today' })
      .click();
    await further
      .getByRole('button', { name: 'Yes, share this story' })
      .click();
    await expect(further.locator('[data-sharing="on"]')).toBeVisible();
    await expect(home.locator('[data-sharing="off"]')).toBeVisible();
    expect(await me.shared()).toEqual(['h2']);
    // The person's own consents are unchanged: sharing isn't one of them.
    expect(await me.granted()).toEqual([
      'special_category_religious',
      'publish',
    ]);

    // Stopping is two presses too, and leaves the story on heisreal.today.
    await further
      .getByRole('button', { name: 'Stop sharing beyond heisreal.today' })
      .click();
    await further.getByRole('button', { name: 'Keep sharing' }).click();
    expect(await me.shared()).toEqual(['h2']);
    await further
      .getByRole('button', { name: 'Stop sharing beyond heisreal.today' })
      .click();
    await further.getByRole('button', { name: 'Yes, stop sharing' }).click();
    await expect(further.locator('[data-sharing="off"]')).toBeVisible();
    expect(await me.shared()).toEqual([]);
    await expect(further.locator('[data-status]')).toHaveText('Published');
  });

  test('a withdrawn story that was shared can still stop being shared, and a draft isn’t offered it', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: [
        { id: 'g1', status: 'withdrawn', title: 'Taken down', shared: true },
        { id: 'g2', status: 'draft', title: 'Still writing' },
      ],
    });
    await page.goto(PROFILE);
    await expect(
      row(page, 'Still writing').locator('[data-sharing]'),
    ).toHaveCount(0);
    const down = row(page, 'Taken down');
    await down
      .getByRole('button', { name: 'Stop sharing beyond heisreal.today' })
      .click();
    await down.getByRole('button', { name: 'Yes, stop sharing' }).click();
    // Once stopped, a withdrawn story isn't offered sharing again.
    await expect(down.locator('[data-sharing]')).toHaveCount(0);
    expect(await me.shared()).toEqual([]);
  });

  test('a list whose story has no sharing yes or no isn’t shown as “only on heisreal.today”', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: [
        { id: 'u1', status: 'approved', title: 'Shared one', shared: true },
      ],
    });
    const list = `${STUB_USER_URL}/v1/account/stories?*`;
    await page.route(list, async (route) => {
      const answer = await route.fetch();
      const body = await answer.json();
      for (const story of body.data) delete story.sharing;
      return route.fulfill({ response: answer, json: body });
    });
    await page.goto(PROFILE);
    await expect(page.getByText('Your stories couldn’t load')).toBeVisible();
    await expect(page.locator('[data-sharing]')).toHaveCount(0);

    await page.unroute(list);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      row(page, 'Shared one').locator('[data-sharing="on"]'),
    ).toBeVisible();
  });

  test('delete my account, by keyboard: it asks for the word, then the account is gone', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      stories: [{ id: 'x1', status: 'approved', title: 'Mine', slug: 'mine' }],
    });
    await page.goto(PROFILE);
    // Loaded (and so hydrated) before the keyboard starts.
    await expect(page.locator('[data-submission]')).toHaveCount(1);
    const card = page.locator('[data-delete-account]');
    await card.getByRole('button', { name: 'Delete my account' }).focus();
    await page.keyboard.press('Enter');
    const word = card.getByLabel('Type delete to confirm');
    await expect(word).toBeFocused();
    const go = card.getByRole('button', { name: 'Delete my account for good' });
    await page.keyboard.type('delet');
    await expect(go).toBeDisabled();
    await page.keyboard.press('Enter');
    await expect(card.locator('[data-deleted]')).toHaveCount(0);
    // Keep my account closes it and forgets the word.
    await card.getByRole('button', { name: 'Keep my account' }).click();
    await card.getByRole('button', { name: 'Delete my account' }).click();
    await expect(word).toHaveValue('');
    await page.keyboard.type('Delete');
    await expect(go).toBeEnabled();
    await page.keyboard.press('Enter');
    // Signed out (here, the fixtures go home in Clerk's place) and the token works no more.
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
    const gone = await request.get(`${STUB_USER_URL}/v1/account`, {
      headers: { authorization: `Bearer ${fixtureToken(me.id)}` },
    });
    expect(gone.status()).toBe(401);
  });

  test('delete my account when the server fails after deleting it: it checks, finds it gone, and signs out', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      granted: ['special_category_religious', 'publish'],
      eraseThenFail: true,
    });
    await page.goto(PROFILE);
    await expect(
      page.getByText('You haven’t shared a story yet.', { exact: false }),
    ).toBeVisible();
    const card = page.locator('[data-delete-account]');
    await card.getByRole('button', { name: 'Delete my account' }).click();
    await card.getByLabel('Type delete to confirm').fill('delete');
    await card
      .getByRole('button', { name: 'Delete my account for good' })
      .click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
    const gone = await request.get(`${STUB_USER_URL}/v1/account`, {
      headers: { authorization: `Bearer ${fixtureToken(me.id)}` },
    });
    expect(gone.status()).toBe(401);
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('My profile fits the screen with long titles and feedback, with 44 px targets', async ({
      page,
      request,
    }, info) => {
      await person(page, request, {
        granted: ['special_category_religious', 'publish'],
        stories: EVERY_STATUS.map((s) => ({
          ...s,
          shared: s.status === 'approved',
          title: `${s.title}: ${LONG}`,
          ...(s.rejectionFeedback
            ? { rejectionFeedback: `${FEEDBACK} ${LONG}` }
            : {}),
        })),
      });
      await page.goto(PROFILE);
      await expect(page.locator('[data-submission]')).toHaveCount(7);
      await expect(page.locator('[data-sharing="on"]')).toBeVisible();
      // Open one confirmation too: it's part of the page someone sees, and a sharing choice
      // with its words and privacy policy.
      await page
        .locator('[data-submission="draft"]')
        .getByRole('button', { name: 'Delete' })
        .click();
      const pending = page.locator('[data-submission="pending"]');
      await pending
        .getByRole('button', { name: 'Share beyond heisreal.today' })
        .click();
      await pending
        .getByText('What sharing beyond heisreal.today means')
        .click();
      await page
        .locator('[data-delete-account]')
        .getByRole('button', { name: 'Delete my account' })
        .click();
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'profile', {
        signedIn: true,
      });
    });
  });
}

test('200% text on the smallest phone: My profile still fits', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'phone-320', 'the smallest phone');
  await enlargeText(page);
  await person(page, request, {
    stories: EVERY_STATUS.map((s) => ({
      ...s,
      shared: s.status === 'approved',
      title: `${s.title}: ${LONG}`,
    })),
  });
  await page.goto(PROFILE);
  await expect(page.locator('[data-submission]')).toHaveCount(7);
  await expectNoHorizontalOverflow(page);
});

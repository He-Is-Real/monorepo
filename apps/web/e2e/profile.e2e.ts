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
  { id: 's_draft', status: 'draft', title: 'My draft' },
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
) {
  const id = randomUUID().replace(/-/g, '');
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
    stories: async () =>
      (
        (await read('/v1/account/stories')).data as {
          id: string;
          status: string;
        }[]
      ).map((s) => [s.id, s.status]),
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
    await person(page, request, { stories: EVERY_STATUS });
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
    expect(await offers('Waiting one')).toEqual({
      status: 'Waiting for review',
      actions: ['Withdraw'],
    });
    expect(await offers('In review one')).toEqual({
      status: 'In review',
      actions: ['Withdraw'],
    });
    expect(await offers('Published one')).toEqual({
      status: 'Published',
      actions: ['View', 'Withdraw'],
    });
    expect(await offers('Sent back one')).toEqual({
      status: 'Changes requested',
      actions: ['Withdraw'],
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
    await expect(
      row(page, 'Published one').getByRole('link', { name: 'View' }),
    ).toHaveAttribute('href', '/stories/published-one');
    await expect(
      row(page, 'My draft').getByRole('link', { name: 'Continue' }),
    ).toHaveAttribute('href', '/share?draft=s_draft');
    // Download and deletion come later (M2 plan PRs 11 and 12): a place, nothing to press.
    await expect(page.locator('[data-coming-soon]')).toHaveCount(2);
    await expect(
      page.locator('[data-coming-soon]').getByRole('button'),
    ).toHaveCount(0);
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

  test('withdraw sharing beyond heisreal.today', async ({ page, request }) => {
    const me = await person(page, request, {
      granted: ['special_category_religious', 'publish', 'share_socials'],
    });
    await page.goto(PROFILE);
    await page
      .getByRole('button', { name: 'Withdraw sharing beyond heisreal.today' })
      .click();
    await page.getByRole('button', { name: 'Yes, withdraw' }).click();
    await expect(page.locator('[data-sharing="off"]')).toBeVisible();
    await expect(
      page.getByText('We won’t share your stories beyond heisreal.today'),
    ).toBeVisible();
    expect(await me.granted()).toEqual([
      'special_category_religious',
      'publish',
    ]);
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
        granted: ['special_category_religious', 'publish', 'share_socials'],
        stories: EVERY_STATUS.map((s) => ({
          ...s,
          title: `${s.title}: ${LONG}`,
          ...(s.rejectionFeedback
            ? { rejectionFeedback: `${FEEDBACK} ${LONG}` }
            : {}),
        })),
      });
      await page.goto(PROFILE);
      await expect(page.locator('[data-submission]')).toHaveCount(7);
      await expect(page.locator('[data-sharing="on"]')).toBeVisible();
      // Open one confirmation too: it's part of the page someone sees.
      await page
        .locator('[data-submission="draft"]')
        .getByRole('button', { name: 'Delete' })
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
    granted: ['share_socials'],
    stories: EVERY_STATUS.map((s) => ({ ...s, title: `${s.title}: ${LONG}` })),
  });
  await page.goto(PROFILE);
  await expect(page.locator('[data-submission]')).toHaveCount(7);
  await expectNoHorizontalOverflow(page);
});

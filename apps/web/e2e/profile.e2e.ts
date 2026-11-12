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
  countFetches,
  enlargeText,
  expectAllTargets,
  expectNoHorizontalOverflow,
  fetchesTakenIn,
  shots,
} from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// My profile (M2 plan PR 8), on the signed-in server against the stub api-user
// (stub-api-user.mjs, checked against api-user.yaml in contract.e2e.ts). Each test is its own
// person, seeded in the stub. The real api-user and database behind these answers (what may be
// edited or deleted, and that a delete reaches every copy) is
// apps/api-user/integration/my-stories.int-spec.ts.

const PROFILE = `${WEB_SIGNED_IN_URL}/account`;
const FEEDBACK =
  'Thank you for sharing this. We felt it needs a little more about what changed for you.';
const LONG =
  'When everything I had built came apart in a single winter and I could not find a reason to carry on Supercalifragilisticexpialidociously';

const SENT = '2026-10-20T12:00:00.000Z';
/** A story of each owner label, as the stub keeps them (Story states: five states, seven labels). */
const EVERY_STATUS = [
  // Never sent. Last changed 29 October 2026: kept 186 days (api-user's deletesAt; the
  // stub's 6 months).
  {
    id: 's_draft',
    status: 'editing',
    title: 'My draft',
    updatedAt: '2026-10-29T12:00:00.000Z',
  },
  {
    id: 's_pending',
    status: 'pending',
    title: 'Waiting one',
    submittedAt: SENT,
  },
  // Sent, then taken down to edit; last changed 1 November 2026: kept 186 days (G3 B).
  {
    id: 's_editing',
    status: 'editing',
    title: 'Being edited one',
    submittedAt: SENT,
    updatedAt: '2026-11-01T12:00:00.000Z',
  },
  {
    id: 's_live',
    status: 'approved',
    title: 'Published one',
    slug: 'published-one',
    submittedAt: SENT,
  },
  {
    id: 's_changes',
    status: 'editing',
    title: 'Sent back one',
    submittedAt: SENT,
    rejectionFeedback: FEEDBACK,
    updatedAt: '2026-11-02T12:00:00.000Z',
  },
  {
    id: 's_hidden',
    status: 'hidden',
    title: 'Hidden one',
    submittedAt: SENT,
  },
  {
    id: 's_taken_down',
    status: 'hidden',
    title: 'Taken down one',
    submittedAt: SENT,
    takenDown: true,
  },
  {
    id: 's_rejected',
    status: 'rejected',
    title: 'Not accepted one',
    submittedAt: SENT,
    rejectionFeedback: FEEDBACK,
    // Rejected 3 November 2026: deleted 90 days later (G3 B).
    decidedAt: '2026-11-03T12:00:00.000Z',
  },
].map((s, i) => ({
  ...s,
  themeIds: ['healing'],
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
    data: seed,
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
    /** Changes a story as another tab does, at the version it has now. */
    editElsewhere: async (story: string, patch: object) => {
      const { version } = await read(`/v1/account/stories/${story}`);
      return (
        await request.patch(`${STUB_USER_URL}/v1/stories/${story}`, {
          headers: {
            ...auth,
            'content-type': 'application/merge-patch+json',
            'if-match': `"${version}"`,
          },
          data: patch,
        })
      ).status();
    },
    stories: async () =>
      (
        (await read('/v1/account/stories')).data as {
          id: string;
          status: string;
        }[]
      ).map((s) => [s.id, s.status]),
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
      testimony: 3,
      stories: EVERY_STATUS,
    });
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    await page.getByRole('button', { name: /^Account: / }).click();
    await page.getByRole('link', { name: 'My profile' }).click();
    await expect(page).toHaveURL(PROFILE);
    await expect(page.locator('[data-submission]')).toHaveCount(8);

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
      actions: ['Continue', 'Preview', 'Delete'],
    });
    expect(await offers('Waiting one')).toEqual({
      status: 'Waiting for review',
      actions: ['Preview', 'Edit', 'Delete'],
    });
    expect(await offers('Being edited one')).toEqual({
      status: 'Being edited',
      actions: ['Continue editing', 'Preview', 'Delete'],
    });
    expect(await offers('Published one')).toEqual({
      status: 'Published',
      actions: ['View', 'Edit', 'Delete'],
    });
    expect(await offers('Sent back one')).toEqual({
      status: 'Sent back',
      actions: ['Continue editing', 'Preview', 'Delete'],
    });
    // G2: a hidden story shows as it is.
    expect(await offers('Hidden one')).toEqual({
      status: 'Not on the site right now',
      actions: ['Preview', 'Edit', 'Delete'],
    });
    // G5: one a moderator took down says so.
    expect(await offers('Taken down one')).toEqual({
      status: 'Taken down by our team',
      actions: ['Preview', 'Edit', 'Delete'],
    });
    // Rejected stories can only be deleted.
    expect(await offers('Not accepted one')).toEqual({
      status: 'Not accepted',
      actions: ['Preview', 'Delete'],
    });
    // The moderator's note, under "What our team said", while sent back or not accepted.
    for (const title of ['Sent back one', 'Not accepted one']) {
      await expect(row(page, title).locator('[data-feedback]')).toContainText(
        `What our team said${FEEDBACK}`,
      );
    }
    await expect(page.locator('[data-feedback]')).toHaveCount(2);
    // A draft or a story being edited says when it goes if nobody touches it, and a rejected
    // story when it goes (G3 B); nothing waiting, published or hidden does.
    await expect(
      row(page, 'My draft').locator('[data-draft-expiry]'),
    ).toHaveText(
      'If you don’t change this draft, we’ll delete it after 3 May 2027.',
    );
    await expect(
      row(page, 'Being edited one').locator('[data-draft-expiry]'),
    ).toHaveText(
      'If you don’t change this story, we’ll delete it after 6 May 2027.',
    );
    await expect(
      row(page, 'Sent back one').locator('[data-draft-expiry]'),
    ).toHaveText(
      'If you don’t change this story, we’ll delete it after 7 May 2027.',
    );
    await expect(
      row(page, 'Not accepted one').locator('[data-draft-expiry]'),
    ).toHaveText(
      'We’ll delete this story after 1 February 2027. To keep our team’s note, download your data before then.',
    );
    await expect(page.locator('[data-draft-expiry]')).toHaveCount(4);
    await expect(
      row(page, 'Published one').getByRole('link', { name: 'View' }),
    ).toHaveAttribute('href', '/stories/published-one');
    await expect(
      row(page, 'My draft').getByRole('link', { name: 'Continue' }),
    ).toHaveAttribute('href', '/share?draft=s_draft');
    // Anything not on the site is previewed as others would see it (M3 plan PR 2).
    await expect(
      row(page, 'Waiting one').getByRole('link', { name: 'Preview' }),
    ).toHaveAttribute('href', '/account/stories/s_pending/preview');
  });

  test('download my data: a file of everything of mine, and nobody else’s', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      testimony: 3,
      stories: [
        {
          id: 'm1',
          status: 'approved',
          title: 'Only mine',
          slug: 'only-mine',
          socialMediaSharingConsent: {
            version: 1,
            agreedAt: '2026-10-31T12:00:00.000Z',
          },
        },
        { id: 'm2', title: 'My draft' },
      ],
    });
    // Someone else in the stub, with a story of their own.
    const other = randomUUID().replace(/-/g, '');
    expect(
      (
        await request.post(`${STUB_USER_URL}/__e2e/sessions/${other}`, {
          data: {
            stories: [{ id: 'o1', title: 'Someone else’s story' }],
          },
        })
      ).status(),
    ).toBe(204);
    await page.goto(PROFILE);
    // Plan 4e: a story's sharing consent is shown, read only (it can't be withdrawn).
    await expect(
      row(page, 'Only mine').locator('[data-shared-on-social]'),
    ).toHaveText(
      'You allowed us to share it on social media (on 31 Oct 2026).',
    );
    await expect(page.locator('[data-shared-on-social]')).toHaveCount(1);
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
        socialMediaSharingConsent: { version: number } | null;
      }[];
      agreements: {
        termsOfUse: { version: number } | null;
        testimonyConsent: { version: number } | null;
      };
    };
    // Plan 4e: each story's own sharing consent, and the versions the person agreed to.
    expect(
      file.stories.map((s) => [
        s.title,
        s.status,
        s.socialMediaSharingConsent?.version ?? null,
      ]),
    ).toEqual([
      ['My draft', 'editing', null],
      ['Only mine', 'approved', 1],
    ]);
    expect(file.agreements).toMatchObject({
      termsOfUse: { version: 2 },
      testimonyConsent: { version: 3 },
    });
    expect(Object.keys(file.about.sections).length).toBeGreaterThan(0);
    expect(text).not.toContain('Someone else');
    // Laid out to be read, not one long line.
    expect(text.split('\n').length).toBeGreaterThan(20);
    await expect(card.getByRole('status')).toHaveText(
      /^Your file he-is-real-my-data-.+\.json is saved to your downloads\. Its links to your videos and pictures work for 7 days\.$/,
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
      'Something went wrong. Please try again later.',
    );
    await expect(
      card.getByRole('button', { name: 'Download my data' }),
    ).toBeEnabled();
    expect(downloads).toBe(0);
  });

  test('Edit a published story: it asks first, takes it down and opens it to edit', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      testimony: 3,
      stories: [
        {
          id: 'p1',
          status: 'approved',
          title: 'Live one',
          slug: 'live-one',
          submittedAt: SENT,
        },
      ],
    });
    await page.goto(PROFILE);
    const story = row(page, 'Live one');
    await story.getByRole('button', { name: 'Edit' }).click();
    await expect(story.locator('[data-confirm]')).toContainText(
      'It comes off the site straight away',
    );
    // "Keep it" leaves it on the site.
    await story.getByRole('button', { name: 'Keep it' }).click();
    expect(await me.stories()).toEqual([['p1', 'approved']]);
    await story.getByRole('button', { name: 'Edit' }).click();
    await story.getByRole('button', { name: 'Edit story' }).click();
    await expect(page).toHaveURL(/\/share\?draft=p1$/);
    expect(await me.stories()).toEqual([['p1', 'editing']]);
    // Back on the profile, it is being edited: continue it, or delete it.
    await page.goto(PROFILE);
    await expect(row(page, 'Live one').locator('[data-status]')).toHaveText(
      'Being edited',
    );
  });

  test('Edit a story waiting for review: it opens to edit at once', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      testimony: 3,
      stories: [
        {
          id: 'w1',
          status: 'pending',
          title: 'Waiting one',
          submittedAt: SENT,
        },
      ],
    });
    await page.goto(PROFILE);
    await row(page, 'Waiting one')
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(page).toHaveURL(/\/share\?draft=w1$/);
    expect(await me.stories()).toEqual([['w1', 'editing']]);
  });

  test('delete a published story, after “This can’t be undone”', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      stories: [
        {
          id: 'l1',
          status: 'approved',
          title: 'Live one',
          slug: 'live-one',
          submittedAt: SENT,
        },
      ],
    });
    await page.goto(PROFILE);
    const story = row(page, 'Live one');
    await story.getByRole('button', { name: 'Delete' }).click();
    await expect(story.locator('[data-confirm]')).toContainText(
      'Delete this story for good? Its text and any video or audio go too, and it comes off the site. This can’t be undone.',
    );
    await story.getByRole('button', { name: 'Delete story' }).click();
    await expect(page.locator('[data-notice]')).toContainText(
      '“Live one” is deleted.',
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
    expect(await me.stories()).toEqual([['d1', 'editing']]);
  });

  test('once the person signs out, what they did is never shown: not a notice, not one finishing late', async ({
    page,
    request,
  }) => {
    await countFetches(page);
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
    await fetchesTakenIn(page);
    expect(await me.stories()).toEqual([]);
    await expect(page.locator('[data-notice]')).toBeEmpty();
    await expect(page.getByText(/Gone (first|later)/)).toHaveCount(0);
  });

  test('a story that changed elsewhere isn’t deleted: the list catches up and says so', async ({
    page,
    request,
  }) => {
    // Agreed to the testimony consent, so the other tab may edit the story.
    const me = await person(page, request, {
      testimony: 3,
      stories: [{ id: 'c1', title: 'Busy one' }],
    });
    await page.goto(PROFILE);
    const story = row(page, 'Busy one');
    await story.getByRole('button', { name: 'Delete' }).click();
    // Another tab edits it meanwhile, so the stub refuses the page's version (412).
    expect(
      await me.editElsewhere('c1', { description: 'From the other tab' }),
    ).toBe(200);
    await story.getByRole('button', { name: 'Delete draft' }).click();
    await expect(story.getByRole('alert')).toContainText(
      'This story changed since the page loaded.',
    );
    expect(await me.stories()).toEqual([['c1', 'editing']]);
  });

  test('the one account-wide withdrawal is Delete my account; each story is taken down on its own', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      testimony: 3,
      stories: [
        { id: 't1', status: 'approved', title: 'Live one', slug: 'live-one' },
      ],
    });
    await page.goto(PROFILE);
    await expect(
      row(page, 'Live one').getByRole('button', { name: 'Edit' }),
    ).toBeVisible();
    // Plan 4e (8b P4): deleting the account is the withdrawal; no "take all my stories off the
    // site", and no account-wide sharing.
    await expect(
      page.getByRole('button', { name: /take all my stories off/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Privacy and consent' }),
    ).toHaveCount(0);
    const card = page.locator('[data-delete-account]');
    await expect(card).toContainText(
      'This withdraws your consent and deletes your stories',
    );
    await card.getByRole('button', { name: 'Delete my account' }).click();
    await expect(card).toContainText('It withdraws your consent');
    // Nothing kept afterwards suggests consent: no "record of your consents" is promised.
    await expect(card).not.toContainText('record of the consents');
  });

  test('delete my account, by keyboard: it asks for the word, then the account is gone', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      testimony: 3,
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
      testimony: 3,
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
        testimony: 3,
        stories: EVERY_STATUS.map((s) => ({
          ...s,
          ...(s.status === 'approved'
            ? {
                socialMediaSharingConsent: {
                  version: 1,
                  agreedAt: '2026-10-31T12:00:00.000Z',
                },
              }
            : {}),
          title: `${s.title}: ${LONG}`,
          ...(s.rejectionFeedback
            ? { rejectionFeedback: `${FEEDBACK} ${LONG}` }
            : {}),
        })),
      });
      await page.goto(PROFILE);
      await expect(page.locator('[data-submission]')).toHaveCount(8);
      await expect(page.locator('[data-shared-on-social]')).toBeVisible();
      // Open one confirmation too: it's part of the page someone sees.
      await page
        .locator('[data-submission="draft"]')
        .getByRole('button', { name: 'Delete' })
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
      title: `${s.title}: ${LONG}`,
    })),
  });
  await page.goto(PROFILE);
  await expect(page.locator('[data-submission]')).toHaveCount(8);
  await expectNoHorizontalOverflow(page);
});

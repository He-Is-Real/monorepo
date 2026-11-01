import { randomUUID } from 'node:crypto';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  enlargeText,
  expectAllTargets,
  expectTarget,
  expectNoHorizontalOverflow,
  shots,
} from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// Share your story (M2 plan PR 4, written stories), on the signed-in server against the stub
// api-user (stub-api-user.mjs, checked against api-user.yaml in contract.e2e.ts). Each test is
// its own person: a session seeded in the stub and set in the page's localStorage, so tests
// running at once share nothing (T4). The real api-user and database behaviour behind these
// answers is apps/api-user/integration/stories.int-spec.ts.

const SHARE = `${WEB_SIGNED_IN_URL}/share`;
const TEXT =
  'I was lost for years, and I did not think anyone could reach me. '.repeat(5);
const ART9 = /storing and processing my story/;
const PUBLISH = /Publish my story on heisreal\.today/;
const SOCIAL = /share my published story in the ways this form lists/;

interface Seed {
  settings?: Record<string, number>;
  signupAccepted?: boolean;
  granted?: string[];
  trusted?: boolean;
  stories?: Record<string, unknown>[];
}

/** A new person for this test: their session in the stub, and in the page's storage. */
async function person(page: Page, request: APIRequestContext, seed: Seed) {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: seed,
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  const auth = { authorization: `Bearer ${fixtureToken(id)}` };
  return {
    /** An admin deletes a theme (in this person's stub session). */
    deleteTheme: async (theme: string) =>
      expect(
        (
          await request.post(
            `${STUB_USER_URL}/__e2e/sessions/${id}/delete-theme?id=${theme}`,
          )
        ).status(),
      ).toBe(204),
    /** The person's stories as api-user has them. */
    stories: async () =>
      (
        await (
          await request.get(`${STUB_USER_URL}/v1/account/stories`, {
            headers: auth,
          })
        ).json()
      ).data as {
        id: string;
        version: number;
        status: string;
        title: string;
        description: string;
        body: string;
        bylineName: string | null;
        themes: { id: string }[];
        sharing: { granted: boolean };
      }[],
    consents: async () =>
      (
        await (
          await request.get(`${STUB_USER_URL}/v1/account/consents`, {
            headers: auth,
          })
        ).json()
      ).current
        .filter((c: { granted: boolean }) => c.granted)
        .map((c: { type: string }) => c.type) as string[],
    /** Another tab: a merge patch at the version it read. */
    editElsewhere: async (id: string, version: number, patch: object) =>
      request.patch(`${STUB_USER_URL}/v1/stories/${id}`, {
        headers: {
          ...auth,
          'content-type': 'application/merge-patch+json',
          'if-match': `"${version}"`,
        },
        data: patch,
      }),
  };
}

const SIGNED_UP: Seed = {
  signupAccepted: true,
  granted: ['age_18plus', 'account_data'],
};
const step = (page: Page, name: string | RegExp) =>
  expect(
    page.getByRole('heading', {
      level: 2,
      name,
      exact: typeof name === 'string',
    }),
  ).toBeFocused();
/** Ticks a consent box: the page's own box (D114), not the words in the document. */
const tick = (page: Page, words: RegExp) =>
  page.locator('label').filter({ hasText: words }).click();
const saved = (page: Page) =>
  expect(page.locator('[data-save-state]')).toHaveAttribute(
    'data-save-state',
    'saved',
  );

async function toWrite(page: Page) {
  await page.goto(SHARE);
  await page.getByRole('button', { name: 'Write my story' }).click();
  await step(page, 'Your story and your data');
  await tick(page, ART9);
  await page.getByRole('button', { name: 'I agree, continue' }).click();
  await step(page, 'Prepare your story');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await step(page, 'Write your story');
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the whole written flow fits every step, to “waiting for review”', async ({
      page,
      request,
    }, info) => {
      const me = await person(page, request, SIGNED_UP);
      const fits = async (name: string) => {
        await expectNoHorizontalOverflow(page);
        await expectAllTargets(page);
        await shots(page, info.project.name, scheme, `share-${name}`, {
          signedIn: true,
        });
      };
      await page.goto(SHARE);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Share your story',
      );
      await expect(
        page.getByRole('heading', { name: 'How would you like to share?' }),
      ).toBeVisible();
      await fits('choose');
      await page.getByRole('button', { name: 'Write my story' }).click();
      await step(page, 'Your story and your data');
      await fits('consent');
      await tick(page, ART9);
      await page.getByRole('button', { name: 'I agree, continue' }).click();
      await step(page, 'Prepare your story');
      await fits('prepare');
      await page.getByRole('button', { name: 'Start writing' }).click();
      await step(page, 'Write your story');
      await page.getByLabel('Title').fill('How I found hope');
      await page.getByLabel('Your story').fill(TEXT);
      await fits('write');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await step(page, 'Add some details');
      await page.getByText('Healing', { exact: true }).click();
      await fits('details');
      // A theme pill is a label round a hidden checkbox, which expectAllTargets skips; a
      // one-letter theme is the narrowest.
      await expectTarget(
        page,
        page.locator('label', {
          has: page.getByRole('checkbox', { name: 'A', exact: true }),
        }),
      );
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await step(page, 'Review and submit');
      await expect(page.getByText('Anonymous')).toBeVisible();
      await tick(page, PUBLISH);
      await fits('review');
      await page.getByRole('button', { name: 'Submit for review' }).click();
      await step(page, 'Thank you for sharing your story');
      await fits('done');
      expect(await me.stories()).toMatchObject([
        { status: 'pending', title: 'How I found hope', bylineName: null },
      ]);
    });
  });
}

// WCAG 1.4.4 on the smallest phone: at 200% text the consent boxes' wording keeps a readable
// column (round 3 review: it had ~44 px, two or three letters a line, which the overflow check
// can't see because the words wrap anywhere). Measured, not just "fits".
test('at 200% text on a 320 px phone, every consent box’s wording has room to read', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'phone-320', 'the smallest phone');
  const MIN_LABEL = 160;
  const labelWidths = () =>
    page
      .locator('[data-box-label]')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  await enlargeText(page);
  await person(page, request, SIGNED_UP);
  await page.goto(SHARE);
  await page.getByRole('button', { name: 'Write my story' }).click();
  await step(page, 'Your story and your data');
  const consent = await labelWidths();
  expect(consent).toHaveLength(1);
  for (const w of consent) expect(w).toBeGreaterThanOrEqual(MIN_LABEL);
  await expectNoHorizontalOverflow(page);

  await tick(page, ART9);
  await page.getByRole('button', { name: 'I agree, continue' }).click();
  await page.getByRole('button', { name: 'Start writing' }).click();
  await page.getByLabel('Title').fill('Wide enough');
  await page.getByLabel('Your story').fill(TEXT);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Hope', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await step(page, 'Review and submit');
  // The publish box and the optional social sharing box, shown once the story's sharing is read.
  await expect(
    page.locator('[data-grant="share_socials"]').getByRole('checkbox'),
  ).toBeVisible();
  const review = await labelWidths();
  expect(review).toHaveLength(2);
  for (const w of review) expect(w).toBeGreaterThanOrEqual(MIN_LABEL);
  await expectNoHorizontalOverflow(page);
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('the story is saved as it’s written, with the first name chosen', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await toWrite(page);
    // Nothing is stored before it has a title and some text.
    await page.getByLabel('Title').fill('Found');
    await expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'unsaved',
    );
    expect(await me.stories()).toEqual([]);
    await page.getByLabel('Your story').fill(TEXT);
    await saved(page);
    await expect(page).toHaveURL(/\/share\?draft=/);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel(/Your first name/).fill('  Sam ');
    await saved(page);
    expect(await me.stories()).toMatchObject([
      {
        status: 'draft',
        title: 'Found',
        body: TEXT,
        bylineName: 'Sam',
      },
    ]);
    // The prompts were guidance only: nothing of them is stored.
    expect(JSON.stringify(await me.stories())).not.toContain(
      'life like before',
    );
  });

  test('refusing the testimony consent stops before anything is stored', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await page.goto(SHARE);
    await page.getByRole('button', { name: 'Write my story' }).click();
    await step(page, 'Your story and your data');
    // The privacy policy is there to read.
    await page.getByText('Read the privacy policy', { exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Cookies and storage' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'I agree, continue' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Without it we don’t store anything you write',
    );
    await page.getByRole('button', { name: 'Back' }).click();
    await step(page, 'How would you like to share?');
    expect(await me.stories()).toEqual([]);
    expect(await me.consents()).not.toContain('special_category_religious');
  });

  test('someone already on the testimony form skips the consent step, and Review shows the newer privacy policy its grants name', async ({
    page,
    request,
  }) => {
    // Their Art 9 consent named privacy policy version 1 (the stub's seeded grants); version 2
    // has been published since, and the publishing grant names it.
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [...(SIGNED_UP.granted ?? []), 'special_category_religious'],
    });
    await page.goto(SHARE);
    await expect(
      page.getByRole('navigation', { name: 'Steps' }),
    ).not.toContainText('Your data');
    await page.getByRole('button', { name: 'Write my story' }).click();
    await step(page, 'Prepare your story');
    await page.getByRole('button', { name: 'Start writing' }).click();
    await page.getByLabel('Title').fill('Shown what I agree to');
    await page.getByLabel('Your story').fill(TEXT);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    // Beside the publishing box: version 2, to read and on its own page.
    const publish = page.locator('[data-grant="publish"]');
    await publish.getByText('Read the privacy policy', { exact: true }).click();
    const policy = publish.locator('[data-privacy-document="dev_policy"]');
    await expect(
      policy.getByRole('heading', { name: 'Cookies and storage' }),
    ).toBeVisible();
    await expect(
      policy.getByRole('link', { name: /^Version 2, on its own page/ }),
    ).toHaveAttribute('href', '/privacy/versions/2');
    // The social sharing grant names the same version, already shown, so it isn't repeated.
    await expect(page.locator('[data-privacy-document]')).toHaveCount(1);
    await tick(page, PUBLISH);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    // The stub accepts only grants naming version 2 (dev_policy).
    await step(page, 'Thank you for sharing your story');
    expect(await me.consents()).toContain('publish');
  });

  test('sharing beyond heisreal.today is offered unticked, and ticking it is for this story only', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await toWrite(page);
    await page.getByLabel('Title').fill('Further afield');
    await page.getByLabel('Your story').fill(TEXT);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    const social = page.locator('[data-grant="share_socials"]');
    await expect(social).toContainText('(optional, for this story only)');
    await expect(social.getByRole('checkbox')).not.toBeChecked();
    await tick(page, PUBLISH);
    await tick(page, SOCIAL);
    // The box is part of the submission: no grant of its own (O4, both or neither).
    const grants: unknown[] = [];
    const submits: unknown[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST') return;
      if (r.url() === `${STUB_USER_URL}/v1/account/consents`)
        grants.push(r.postDataJSON());
      if (r.url().endsWith('/submit')) submits.push(r.postDataJSON());
    });
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
    const [story] = await me.stories();
    expect([story.status, story.sharing.granted]).toEqual(['pending', true]);
    expect(submits).toEqual([
      {
        shareBeyondSite: {
          formVersion: 'v2',
          privacyPolicyVersion: 'dev_policy',
        },
      },
    ]);
    expect(grants).toEqual([expect.objectContaining({ statement: 'publish' })]);
    // It's the story's choice (O4), not one of the person's own consents.
    expect(await me.consents()).not.toContain('share_socials');
  });

  test('a story already shared beyond heisreal.today never shows an unticked box, even when its sharing can’t be read', async ({
    page,
    request,
  }) => {
    // Its sharing was granted at an earlier try at submitting (O4: for this story only).
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      stories: [
        {
          id: 'shared',
          title: 'Already shared',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
          shared: true,
        },
      ],
    });
    await page.goto(SHARE);
    await page
      .getByRole('button', { name: 'Continue “Already shared”' })
      .click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // Review's read of the story fails.
    const read = `${STUB_USER_URL}/v1/account/stories/shared`;
    await page.route(read, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, body: '' })
        : route.fallback(),
    );
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    await expect(page.locator('[data-sharing="error"]')).toContainText(
      'can’t be submitted yet',
    );
    await expect(page.locator('[data-grant="share_socials"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Submit for review' }),
    ).toBeDisabled();

    // Trying again once it can be read shows the story's own choice, still with no box.
    await page.unroute(read);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('[data-shared]')).toBeVisible();
    await expect(page.locator('[data-sharing="error"]')).toHaveCount(0);
    await expect(page.locator('[data-grant="share_socials"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
    const [story] = await me.stories();
    expect([story.status, story.sharing.granted]).toEqual(['pending', true]);
  });

  test('a submission with sharing whose answer is lost is sent again exactly as it was, and both go through once', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      stories: [
        {
          id: 'lost',
          title: 'Lost answer',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
        },
      ],
    });
    await page.goto(SHARE);
    await page.getByRole('button', { name: 'Continue “Lost answer”' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    // The first submission goes through (the story and its sharing), but its answer is lost.
    const submit = `${STUB_USER_URL}/v1/stories/lost/submit`;
    const sent: { key: string | null; body: unknown }[] = [];
    await page.route(submit, async (route) => {
      sent.push({
        key: await route.request().headerValue('idempotency-key'),
        body: route.request().postDataJSON(),
      });
      if (sent.length > 1) return route.fallback();
      await route.fetch();
      return route.fulfill({ status: 503, body: '' });
    });
    await tick(page, SOCIAL);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(
      page.getByText('Your story couldn’t be submitted. Please try again.'),
    ).toBeVisible();
    // Nothing is shown as decided: the box stays as it was sent, and can't change.
    const box = page
      .locator('[data-grant="share_socials"]')
      .getByRole('checkbox');
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    expect(await me.stories()).toMatchObject([
      { status: 'pending', sharing: { granted: true } },
    ]);

    // Trying again replays the same submission: the same key and body, "Thank you".
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0].body).toEqual({
      shareBeyondSite: {
        formVersion: 'v2',
        privacyPolicyVersion: 'dev_policy',
      },
    });
  });

  test('stopping a story’s sharing on Review never submits it', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      stories: [
        {
          id: 'stay',
          title: 'Stays a draft',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
          shared: true,
        },
      ],
    });
    const submits: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/submit'))
        submits.push(r.url());
    });
    await page.goto(SHARE);
    await page
      .getByRole('button', { name: 'Continue “Stays a draft”' })
      .click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    const shared = page.locator('[data-shared]');
    await expect(shared).toContainText('Already shared beyond heisreal.today');
    await expect(page.locator('[data-grant="share_socials"]')).toHaveCount(0);
    // Review's one submit button is "Submit for review": every other button in its form, at
    // every stage of stopping, is a plain button (Chromium happens not to submit for one that
    // is replaced or disabled as it's pressed, so this is checked as well as what's sent).
    const form = page.locator('form');
    const onlySubmit = async () => {
      await expect(form.locator('button:not([type="button"])')).toHaveCount(1);
      await expect(form.locator('button[type="submit"]')).toHaveText(
        'Submit for review',
      );
    };
    await onlySubmit();

    // Opening, then "Keep sharing": nothing is sent.
    await shared
      .getByRole('button', { name: 'Stop sharing beyond heisreal.today' })
      .click();
    await onlySubmit();
    await shared.getByRole('button', { name: 'Keep sharing' }).click();
    await expect(shared.locator('[data-sharing="on"]')).toBeVisible();
    // Opening, then "Yes, stop sharing": only the withdrawal; the box comes back unticked.
    await shared
      .getByRole('button', { name: 'Stop sharing beyond heisreal.today' })
      .click();
    await shared.getByRole('button', { name: 'Yes, stop sharing' }).click();
    const social = page.locator('[data-grant="share_socials"]');
    await expect(social.getByRole('checkbox')).not.toBeChecked();
    await expect(
      page.getByRole('heading', { name: 'Review and submit' }),
    ).toBeVisible();
    expect(submits).toEqual([]);
    expect(await me.stories()).toMatchObject([
      { status: 'draft', sharing: { granted: false } },
    ]);
  });

  test('an answer without the story’s sharing yes or no is never read as “not shared”', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      stories: [
        {
          id: 'unclear',
          title: 'Unclear',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
          shared: true,
        },
      ],
    });
    await page.goto(SHARE);
    await page.getByRole('button', { name: 'Continue “Unclear”' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // Reads of the story answer 200, first with `{}`, then the story without `sharing` (the
    // picture panel reads it too, so the answers go by phase, not by count).
    const read = `${STUB_USER_URL}/v1/account/stories/unclear`;
    let unclear: 'empty' | 'no-sharing' = 'empty';
    let reads = 0;
    await page.route(read, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      reads += 1;
      if (unclear === 'empty') return route.fulfill({ json: {} });
      const answer = await route.fetch();
      const { sharing: _, ...story } = await answer.json();
      return route.fulfill({ response: answer, json: story });
    });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    const error = page.locator('[data-sharing="error"]');
    await expect(error).toContainText('can’t be submitted yet');
    await expect(page.locator('[data-grant="share_socials"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Submit for review' }),
    ).toBeDisabled();
    unclear = 'no-sharing';
    const before = reads;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(error).toBeVisible();
    await expect(page.locator('[data-grant="share_socials"]')).toHaveCount(0);

    await page.unroute(read);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('[data-shared]')).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  test('without the sign-up consent, the page sends people to finish setting up', async ({
    page,
    request,
  }) => {
    await person(page, request, { signupAccepted: false });
    await page.goto(SHARE);
    // The site's own prompt (consent-prompts.tsx) takes them to the sign-up consent step, set
    // to come back here; the share page's "Finish setting up" link is only its fallback.
    await expect(page).toHaveURL(/\/consent\/sign-up\?redirect_url=%2Fshare$/);
  });

  test('the 200-character minimum is explained, not just refused', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await toWrite(page);
    await page.getByLabel('Title').fill('Short');
    await page.getByLabel('Your story').fill('Only a few words.');
    await expect(page.getByText('17 / 10,000 characters')).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    await page.getByText('Healing', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await tick(page, PUBLISH);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'needs at least 200 characters',
    );
    await page.getByRole('button', { name: 'Keep writing' }).click();
    await step(page, 'Write your story');
    expect((await me.stories())[0].status).toBe('draft');
  });

  test('the page shows and applies the admin’s limits, not numbers of its own (W3)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [...(SIGNED_UP.granted ?? []), 'publish'],
      settings: { storyTextMin: 50, storyTextMax: 400 },
    });
    await toWrite(page);
    await expect(page.getByLabel('Your story')).toHaveAttribute(
      'maxlength',
      '400',
    );
    await page.getByLabel('Title').fill('Short and allowed');
    await page.getByLabel('Your story').fill('x'.repeat(60));
    await expect(
      page.getByText('60 / 400 characters. At least 50 to submit.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Hope', { exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
    expect((await me.stories())[0].status).toBe('pending');
  });

  // Themes plan v3 (mockup 2): each category's highlighted themes first; "More themes" unfolds
  // the rest in place, in their own category (Joel, 2026-11-01), with a search; a chosen theme
  // stays in view when folded; the count is the admin's, checked at submit; a theme deleted
  // while someone is choosing asks them to choose again (A7).
  test('choosing themes: highlighted first, More themes unfolds in place with a search, the admin’s count, and a deleted theme asks to choose again', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [...(SIGNED_UP.granted ?? []), 'publish'],
      settings: { themesMin: 2, themesMax: 3 },
    });
    await toWrite(page);
    await page.getByLabel('Title').fill('Choosing themes');
    await page.getByLabel('Your story').fill(TEXT);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Add some details');
    const themes = page.getByRole('group', {
      name: 'Which themes fit your story?',
    });
    await expect(themes).toContainText('Choose 2–3 themes.');
    await expect(themes.getByRole('heading', { level: 3 })).toHaveText([
      'Feelings',
      'Topics',
    ]);
    await expect(themes.getByRole('checkbox', { name: 'Doubt' })).toHaveCount(
      0,
    );
    await themes.getByText('Hope', { exact: true }).click();
    // One is too few: said before the review step.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      page.getByText('Choose 2–3 themes.', { exact: true }),
    ).toBeVisible();

    await themes.getByRole('button', { name: 'More themes' }).click();
    const headings = themes.getByRole('heading', { level: 3 });
    // Each category once, its hidden themes inside its own row.
    await expect(headings).toHaveText(['Feelings', 'Journeys', 'Topics']);
    await expect(
      themes
        .getByRole('list', { name: 'Journeys' })
        .getByRole('checkbox', { name: 'Doubt' }),
    ).toHaveCount(1);
    await themes.getByRole('searchbox', { name: 'Search themes' }).fill('DOU');
    await expect(
      themes.getByRole('checkbox', { name: 'Addiction' }),
    ).toHaveCount(0);
    // Hope is chosen, so it stays in view whatever the search says.
    await expect(headings).toHaveText(['Feelings', 'Journeys']);
    await expect(themes.getByRole('checkbox', { name: 'Hope' })).toBeChecked();
    await themes.getByText('Doubt', { exact: true }).click();
    // Ticked while open, so un-ticking it under a search it doesn't match leaves it where it is,
    // with the keyboard focus, until the list folds or unfolds (Joel, 2026-11-01).
    await themes
      .getByRole('searchbox', { name: 'Search themes' })
      .fill('hope');
    const doubt = themes.getByRole('checkbox', { name: 'Doubt' });
    await doubt.focus();
    await page.keyboard.press('Space');
    await expect(doubt).not.toBeChecked();
    await expect(doubt).toBeFocused();
    await expect(headings).toHaveText(['Feelings', 'Journeys']);
    await page.keyboard.press('Space');
    await expect(doubt).toBeChecked();
    await expectNoHorizontalOverflow(page);
    await themes.getByRole('button', { name: 'Fewer themes' }).click();
    // Chosen, so still in view with the highlighted ones.
    await expect(themes.getByRole('checkbox', { name: 'Doubt' })).toBeChecked();
    await expect(themes).toContainText('2 of 3 chosen.');
    await saved(page);

    // An admin deletes Doubt before the person submits: it comes off the draft, whose version
    // moves on, so the submission is stale; the page says why.
    await me.deleteTheme('doubt');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    const alert = page.getByRole('main').getByRole('alert');
    await expect(alert).toContainText(
      'Themes have changed, please choose again',
    );
    await expect(alert).not.toContainText('another tab');
    await page.getByRole('button', { name: 'Choose themes' }).click();
    await step(page, 'Add some details');
    await themes.getByRole('button', { name: 'More themes' }).click();
    await expect(themes.getByRole('checkbox', { name: 'Doubt' })).toHaveCount(
      0,
    );
    await expect(
      themes.getByRole('checkbox', { name: 'Hope' }),
    ).not.toBeChecked();
    expect((await me.stories())[0].status).toBe('draft');
  });

  test('a draft resumes after a reload, and the drafts list offers it', async ({
    page,
    request,
  }) => {
    await person(page, request, SIGNED_UP);
    await toWrite(page);
    await page.getByLabel('Title').fill('Still writing');
    await page.getByLabel('Your story').fill(TEXT);
    await saved(page);
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Write your story' }),
    ).toBeVisible();
    await expect(page.getByLabel('Your story')).toHaveValue(TEXT);

    await page.goto(SHARE);
    await page
      .getByRole('button', { name: 'Continue “Still writing”' })
      .click();
    await step(page, 'Write your story');
    await expect(page.getByLabel('Title')).toHaveValue('Still writing');
  });

  test('an edit in another tab: a different field is kept silently, the same field is asked about', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await toWrite(page);
    await page.getByLabel('Title').fill('Mine');
    await page.getByLabel('Your story').fill(TEXT);
    await saved(page);
    let [story] = await me.stories();

    // Another tab changes the title; this one changes the text: no question, both kept.
    await me.editElsewhere(story.id, story.version, { title: 'Other tab' });
    await page.getByLabel('Your story').fill(`${TEXT} More.`);
    await saved(page);
    [story] = await me.stories();
    expect(story).toMatchObject({ title: 'Other tab', body: `${TEXT} More.` });

    // Both change the text: the person chooses, and their text is never lost.
    await me.editElsewhere(story.id, story.version, {
      body: `${TEXT} Theirs.`,
    });
    await page.getByLabel('Your story').fill(`${TEXT} Mine.`);
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'This story was changed in another tab or window',
    );
    await expect(page.getByLabel('Your story')).toHaveValue(`${TEXT} Mine.`);
    await page.getByRole('button', { name: 'Keep what’s here' }).click();
    await saved(page);
    // The choice settled the text only: the other tab's title, merged earlier, stays.
    expect((await me.stories())[0]).toMatchObject({
      body: `${TEXT} Mine.`,
      title: 'Other tab',
    });
  });

  for (const [choice, button, body] of [
    ['the other version', 'Use the other version', 'Theirs.'],
    ['what’s here', 'Keep what’s here', 'Mine.'],
  ] as const) {
    test(`settling a clash with “${choice}” changes only the clashing field: both tabs’ other changes are kept (Codex #118, 2)`, async ({
      page,
      request,
    }) => {
      const me = await person(page, request, SIGNED_UP);
      await toWrite(page);
      await page.getByLabel('Title').fill('Mine');
      await page.getByLabel('Your story').fill(TEXT);
      await saved(page);
      const [story] = await me.stories();

      // Another tab changes the text and the description.
      await me.editElsewhere(story.id, story.version, {
        body: `${TEXT} Theirs.`,
        description: 'From the other tab',
      });
      // This tab changes the title and the text, held back so both go in one save.
      const PATCH = `${STUB_USER_URL}/v1/stories/${story.id}`;
      await page.route(PATCH, (route) => route.abort('connectionrefused'));
      await page.getByLabel('Title').fill('Mine, renamed');
      await page.getByLabel('Your story').fill(`${TEXT} Mine.`);
      await expect(page.locator('[data-save-state]')).toHaveAttribute(
        'data-save-state',
        'offline',
      );
      await page.unroute(PATCH);
      await page.getByRole('button', { name: 'Try saving again' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toContainText(
        'This story was changed in another tab or window',
      );
      // While asked, what merged cleanly is already on screen; this tab's text is kept.
      await expect(page.getByLabel('Title')).toHaveValue('Mine, renamed');
      await expect(page.getByLabel('Your story')).toHaveValue(`${TEXT} Mine.`);

      await page.getByRole('button', { name: button }).click();
      await saved(page);
      await expect(page.getByLabel('Your story')).toHaveValue(
        `${TEXT} ${body}`,
      );
      expect((await me.stories())[0]).toMatchObject({
        body: `${TEXT} ${body}`, // the clash, as chosen
        title: 'Mine, renamed', // this tab's other change
        description: 'From the other tab', // the other tab's other change
      });
    });
  }

  test('a create whose answer is lost is recovered, and later typing is saved to the same draft (Codex #118, 3)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await toWrite(page);
    // The first create reaches api-user and is stored; its answer never arrives.
    let dropped = false;
    await page.route(`${STUB_USER_URL}/v1/stories`, async (route) => {
      if (route.request().method() !== 'POST' || dropped)
        return route.fallback();
      dropped = true;
      await route.fetch();
      return route.abort('connectionreset');
    });
    await page.getByLabel('Title').fill('Lost answer');
    await page.getByLabel('Your story').fill(TEXT);
    await expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'offline',
    );
    expect(await me.stories()).toHaveLength(1);

    // Typing on: the retry replays the same create (same key, same body), then saves the rest.
    await page.getByLabel('Your story').fill(`${TEXT} More.`);
    await saved(page);
    const stories = await me.stories();
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({
      title: 'Lost answer',
      body: `${TEXT} More.`,
    });
    await expect(page).toHaveURL(new RegExp(`draft=${stories[0].id}`));
  });

  test('a submit whose answer is lost is confirmed by trying again (Codex #118, 5)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      stories: [
        {
          id: 'lost',
          title: 'Almost there',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
        },
      ],
    });
    await page.goto(SHARE);
    await page.getByRole('button', { name: 'Continue “Almost there”' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    // The submit reaches api-user and goes through; its answer never arrives.
    let dropped = false;
    await page.route(
      `${STUB_USER_URL}/v1/stories/lost/submit`,
      async (route) => {
        if (dropped) return route.fallback();
        dropped = true;
        await route.fetch();
        return route.abort('connectionreset');
      },
    );
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'can’t reach our server',
    );
    expect((await me.stories())[0].status).toBe('pending');
    // Trying again replays the same submission and confirms it, rather than a refusal.
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
  });

  test('api-user down: a clear message, and the text is kept until it’s back', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, SIGNED_UP);
    await toWrite(page);
    await page.route(`${STUB_USER_URL}/v1/stories**`, (route) =>
      route.abort('connectionrefused'),
    );
    await page.getByLabel('Title').fill('Offline');
    await page.getByLabel('Your story').fill(TEXT);
    await expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'offline',
    );
    await expect(page.locator('[data-save-state]')).toContainText(
      'Your story is kept on this device',
    );
    // A reload while it's down keeps the text (this tab's storage).
    await page.reload();
    await page.getByRole('button', { name: 'Write my story' }).click();
    await page.getByRole('button', { name: 'Start writing' }).click();
    await expect(page.getByLabel('Your story')).toHaveValue(TEXT);
    expect(await me.stories()).toEqual([]);

    await page.unroute(`${STUB_USER_URL}/v1/stories**`);
    await page.getByLabel('Your story').fill(`${TEXT}!`);
    await saved(page);
    expect((await me.stories())[0]).toMatchObject({ title: 'Offline' });
  });

  test('text one person left in a shared tab is never shown to the next person', async ({
    page,
    request,
  }) => {
    await person(page, request, SIGNED_UP);
    await toWrite(page);
    // Not saved to the server yet (no text): kept in this tab only.
    await page.getByLabel('Title').fill('Something private');
    await expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'unsaved',
    );
    // Someone else signs in in the same tab.
    const other = randomUUID().replace(/-/g, '');
    await request.post(`${STUB_USER_URL}/__e2e/sessions/${other}`, {
      data: {
        ...SIGNED_UP,
        granted: [...(SIGNED_UP.granted ?? []), 'special_category_religious'],
      },
    });
    await page.evaluate((s) => {
      window.localStorage.setItem('e2e-session', s);
    }, other);
    await page.addInitScript((s) => {
      window.localStorage.setItem('e2e-session', s);
    }, other);
    await page.reload();
    await page.getByRole('button', { name: 'Write my story' }).click();
    await page.getByRole('button', { name: 'Start writing' }).click();
    await expect(page.getByLabel('Title')).toHaveValue('');
    expect(
      await page.evaluate(() => JSON.stringify(window.sessionStorage)),
    ).not.toContain('Something private');
  });

  /** A person with one draft ready to submit, on its Review step. */
  async function atReview(page: Page, request: APIRequestContext, id: string) {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      stories: [
        {
          id,
          title: 'Almost there',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
        },
      ],
    });
    await page.goto(SHARE);
    await page.getByRole('button', { name: 'Continue “Almost there”' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    return me;
  }
  /** The submit reaches api-user and goes through; the browser gets `answer` instead. */
  const loseSubmitAnswer = (
    page: Page,
    id: string,
    answer: 'none' | 'truncated',
  ) => {
    let lost = false;
    return page.route(
      `${STUB_USER_URL}/v1/stories/${id}/submit`,
      async (route) => {
        if (lost) return route.fallback();
        lost = true;
        const response = await route.fetch();
        if (answer === 'none') return route.abort('connectionreset');
        // A 200 whose body is cut off: what was done can't be read from it.
        return route.fulfill({ response, body: '{"id":"' });
      },
    );
  };

  test('after a lost submit answer, Back and Review again replays the same submission (Codex #118 round 2)', async ({
    page,
    request,
  }) => {
    const me = await atReview(page, request, 'back');
    await loseSubmitAnswer(page, 'back', 'none');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'can’t reach our server',
    );
    expect((await me.stories())[0].status).toBe('pending');
    // Leaving Review and coming back, changing nothing, keeps the unresolved submission.
    await page.getByRole('button', { name: 'Back' }).click();
    await step(page, 'Add some details');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await step(page, 'Review and submit');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
  });

  test('after a lost submit answer, a reload shows the story was submitted (Codex #118 round 2)', async ({
    page,
    request,
  }) => {
    await atReview(page, request, 'reload');
    await loseSubmitAnswer(page, 'reload', 'none');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'can’t reach our server',
    );
    await page.goto(`${SHARE}?draft=reload`);
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'Thank you for sharing your story',
      }),
    ).toBeVisible();
  });

  test('a submit answer cut off after its 200 is an unknown outcome: trying again replays it (Codex #118 round 2)', async ({
    page,
    request,
  }) => {
    const me = await atReview(page, request, 'cutoff');
    await loseSubmitAnswer(page, 'cutoff', 'truncated');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'can’t reach our server',
    );
    expect((await me.stories())[0].status).toBe('pending');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
  });

  test('a draft over a newly lowered maximum is refused at submit, says the limit, and can be trimmed and submitted (Joel, 2026-10-30)', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      ...SIGNED_UP,
      granted: [
        ...(SIGNED_UP.granted ?? []),
        'special_category_religious',
        'publish',
      ],
      settings: { storyTextMax: 300 },
      stories: [
        {
          id: 'over',
          title: 'Written before the change',
          body: TEXT,
          primaryFormat: 'written',
          themeIds: ['hope'],
        },
      ],
    });
    expect(TEXT.length).toBeGreaterThan(300);
    await page.goto(SHARE);
    await page
      .getByRole('button', { name: 'Continue “Written before the change”' })
      .click();
    await step(page, 'Write your story');
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'over the current limit of 300 characters',
    );
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'longer than the current limit of 300 characters',
    );
    await page.getByRole('button', { name: 'Shorten it' }).click();
    await step(page, 'Write your story');
    // A first trim, still over: saved all the same, so it can be fixed bit by bit.
    await page.getByLabel('Your story').fill(TEXT.slice(0, 310));
    await saved(page);
    await page.getByLabel('Your story').fill(TEXT.slice(0, 250));
    await saved(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
    expect((await me.stories())[0].status).toBe('pending');
  });

  test('after a lost submit answer, going Back and typing shows “Thank you”, not an error (round 3)', async ({
    page,
    request,
  }) => {
    await atReview(page, request, 'typed');
    await loseSubmitAnswer(page, 'typed', 'none');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'can’t reach our server',
    );
    await page.getByRole('button', { name: 'Back' }).click();
    await step(page, 'Add some details');
    // The save is refused (the story was submitted): the page says so.
    await page.getByLabel(/Brief description/).fill('One more thought');
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'Thank you for sharing your story',
      }),
    ).toBeVisible();
  });

  test('after a lost submit answer whose key is gone, submitting again shows “Thank you” (round 3)', async ({
    page,
    request,
  }) => {
    await atReview(page, request, 'nokey');
    await loseSubmitAnswer(page, 'nokey', 'none');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'can’t reach our server',
    );
    // The kept submission is lost too (e.g. storage cleared): a new key, refused.
    await page.evaluate(() => {
      for (const k of Object.keys(window.sessionStorage)) {
        if (k.includes(':submit:')) window.sessionStorage.removeItem(k);
      }
    });
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await step(page, 'Thank you for sharing your story');
  });

  test('a draft that isn’t theirs says so and offers a new story', async ({
    page,
    request,
  }) => {
    await person(page, request, {
      ...SIGNED_UP,
      granted: [...(SIGNED_UP.granted ?? []), 'special_category_religious'],
    });
    await page.goto(`${SHARE}?draft=someone-elses`);
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'This draft isn’t available',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Start a new story' }),
    ).toHaveAttribute('href', '/share');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(
      0,
    );
  });

  test('clearing the title to rewrite it shows a calm hint, not an error', async ({
    page,
    request,
  }) => {
    await person(page, request, SIGNED_UP);
    await toWrite(page);
    await page.getByLabel('Title').fill('First go');
    await page.getByLabel('Your story').fill(TEXT);
    await saved(page);
    await page.getByLabel('Title').fill('');
    await expect(page.locator('[data-save-state]')).toHaveAttribute(
      'data-save-state',
      'unsaved',
    );
    await expect(page.getByText(/aren’t valid/)).toHaveCount(0);
    await page.getByLabel('Title').fill('Second go');
    await saved(page);
  });

  test('signed out, the page asks people to sign in and come back', async ({
    page,
  }) => {
    await page.goto('/share');
    await expect(
      page.getByRole('link', { name: 'Sign in' }).last(),
    ).toHaveAttribute('href', '/sign-in?redirect_url=%2Fshare');
  });

  // Chromium with JavaScript turned off by Playwright still parses <noscript> as script-on,
  // so the message is checked in the page as the server sends it.
  test('without JavaScript, the page says sharing needs it', async ({
    request,
  }) => {
    const html = await (await request.get(SHARE)).text();
    expect(html).toContain('Sharing needs JavaScript');
  });

  test('the header’s Share your story leads here', async ({ page }) => {
    await page.goto(`${WEB_SIGNED_IN_URL}/get-ready`);
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Share your story' })
      .click();
    await expect(page).toHaveURL(SHARE);
  });
});

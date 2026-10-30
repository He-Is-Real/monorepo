import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, type Request, test } from '@playwright/test';
import { Contract } from '@heisreal/contracts/testing';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  enlargeText,
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
  shots,
} from './helpers';
import { STUB_USER_URL, WEB_LIVE_URL, WEB_SIGNED_IN_URL } from './servers';

// The consent prompts after sign-in, on the signed-in server (E2E_FIXTURES; the browser calls
// the stub api-user with the fixtures' token):
// - D73, the sign-up step: someone who hasn't accepted the sign-up form in force is taken to
//   /consent/sign-up, ticks both boxes of the published form (dev's v1, served by the stub
//   api-public-read from libs/legal), and goes back to where they were. Nothing is recorded
//   until both are ticked; each box is one grant on the version shown.
// - D85, the banner: someone whose testimony version was replaced by one requiring acceptance
//   is asked to read and accept it; their stories and the site stay as they are (D93).
// The stub's account bootstrap says everything is accepted, so these tests answer it
// themselves, with bodies checked against api-user.yaml. The grants go to the stub api-user,
// which checks them like the real service (contract.e2e.ts checks its answers).

const contract = new Contract('api-user.yaml');
const ACCOUNT_URL = `${STUB_USER_URL}/v1/account`;
const CONSENTS_URL = `${STUB_USER_URL}/v1/account/consents`;
const isGrant = (r: Request) =>
  r.url() === CONSENTS_URL && r.method() === 'POST';

/** The bootstrap answers this account state for the rest of the test. */
async function answerAccount(
  page: Page,
  state: { signup: boolean; testimony?: boolean },
) {
  const body = {
    id: 'e2efixture',
    version: null,
    role: 'User',
    createdAt: '2026-10-25T12:00:00.000Z',
    signupConsent: { accepted: state.signup },
    testimonyConsent: { acceptanceRequired: state.testimony ?? false },
  };
  expect(
    contract.problems({
      method: 'GET',
      path: '/v1/account',
      status: 200,
      contentType: 'application/json',
      body,
    }),
  ).toEqual([]);
  const origin = new URL(WEB_SIGNED_IN_URL).origin;
  await page.route(ACCOUNT_URL, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'access-control-allow-origin': origin,
            'cache-control': 'private, no-store',
          },
          body: JSON.stringify(body),
        })
      : route.fallback(),
  );
}

/** Every grant the page sends, with its body and key. */
function recordGrants(page: Page) {
  const grants: { body: Record<string, string>; key: string }[] = [];
  page.on('request', (r) => {
    if (!isGrant(r)) return;
    grants.push({
      body: r.postDataJSON(),
      key: r.headers()['idempotency-key'] ?? '',
    });
  });
  return grants;
}

const box = (page: Page, name: RegExp) => page.getByRole('checkbox', { name });
const AGE = /I am 18 or over/;
const ACCOUNT_DATA = /Store my account and the stories I save/;
/** Ticks a box by clicking its words, as a person does (the boxes' group, not the document). */
const tick = (page: Page, words: RegExp) =>
  page.locator('form fieldset').getByText(words).click();

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the sign-up step fits, with its two boxes unticked', async ({
      page,
    }, info) => {
      await answerAccount(page, { signup: false });
      await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Before you use your account',
        }),
      ).toBeVisible();
      await expect(box(page, AGE)).not.toBeChecked();
      await expect(box(page, ACCOUNT_DATA)).not.toBeChecked();
      await page
        .getByText('Read the privacy document', { exact: true })
        .click();
      await expect(page.locator('[data-privacy-document]')).toContainText(
        'Privacy document: development placeholder',
      );
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'consent-sign-up', {
        signedIn: true,
      });
    });

    test('the testimony banner and its page fit', async ({ page }, info) => {
      await answerAccount(page, { signup: true, testimony: true });
      await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
      const banner = page.locator('[data-consent-banner]');
      await expect(banner).toBeVisible();
      await expectNoHorizontalOverflow(page);
      for (const control of [
        banner.getByRole('link', { name: 'Read and accept' }),
        banner.getByRole('button', { name: 'Not now' }),
      ]) {
        await expectTarget(page, control);
      }
      await shots(page, info.project.name, scheme, 'consent-banner', {
        signedIn: true,
      });

      await page.goto(`${WEB_SIGNED_IN_URL}/consent/testimony`);
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Your story and your data',
        }),
      ).toBeVisible();
      await expect(page.getByRole('checkbox')).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'consent-testimony', {
        signedIn: true,
      });
    });
  });
}

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('D73: signed in without sign-up consent, the person is taken to the step and back afterwards', async ({
    page,
  }) => {
    await answerAccount(page, { signup: false });
    const grants = recordGrants(page);
    await page.goto(`${WEB_SIGNED_IN_URL}/stories?tag=healing`);
    await expect(page).toHaveURL(
      `${WEB_SIGNED_IN_URL}/consent/sign-up?redirect_url=${encodeURIComponent('/stories?tag=healing')}`,
    );
    const agree = page.getByRole('button', { name: 'Agree and continue' });

    // Nothing is recorded until both boxes are ticked.
    await agree.click();
    await expect(page.getByText('Tick both boxes to continue.')).toBeVisible();
    await expect(box(page, AGE)).toBeFocused();
    await tick(page, AGE);
    await agree.click();
    await expect(page.getByText('Tick both boxes to continue.')).toBeVisible();
    await expect(box(page, ACCOUNT_DATA)).toBeFocused();
    expect(grants).toEqual([]);

    await tick(page, ACCOUNT_DATA);
    const answered = page.waitForResponse(
      (r) =>
        isGrant(r.request()) &&
        r.request().postDataJSON().statement === 'account_data',
    );
    await agree.click();
    const last = await answered;
    expect(last.status()).toBe(201);
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/stories?tag=healing`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // One grant per box, on the version shown, each with its own key.
    expect(grants.map((g) => g.body)).toEqual([
      {
        form: 'signup',
        formVersion: 'v1',
        statement: 'age_18plus',
        mechanism: 'web_form_submission',
      },
      {
        form: 'signup',
        formVersion: 'v1',
        statement: 'account_data',
        mechanism: 'web_form_submission',
      },
    ]);
    expect(new Set(grants.map((g) => g.key)).size).toBe(2);

    // Accepted: moving around the site doesn't ask again.
    await page.getByRole('link', { name: 'He Is Real Today, home' }).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(grants).toHaveLength(2);
  });

  test('accepting before the account check answers: its late “not accepted” doesn’t send the person back', async ({
    page,
  }) => {
    // The bootstrap's answer is held until the person has accepted, then released: it was
    // sent before the grants, so it still says the sign-up form isn't accepted.
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const origin = new URL(WEB_SIGNED_IN_URL).origin;
    await page.route(ACCOUNT_URL, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await held;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin },
        body: JSON.stringify({
          id: 'e2efixture',
          version: null,
          role: 'User',
          createdAt: '2026-10-25T12:00:00.000Z',
          signupConsent: { accepted: false },
          testimonyConsent: { acceptanceRequired: false },
        }),
      });
    });
    const grants = recordGrants(page);
    await page.goto(
      `${WEB_SIGNED_IN_URL}/consent/sign-up?redirect_url=%2Fabout`,
    );
    await tick(page, AGE);
    await tick(page, ACCOUNT_DATA);
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/about`);
    expect(grants).toHaveLength(2);

    const late = page.waitForResponse(
      (r) => r.url() === ACCOUNT_URL && r.request().method() === 'GET',
    );
    release();
    await late;
    // A click handled after it means React has run every effect the late answer caused.
    const account = page.getByRole('button', { name: /^Account: / });
    await account.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/about`);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(grants).toHaveLength(2);
  });

  test('D114: the boxes and their words come from the statements data, outside the document', async ({
    page,
  }) => {
    const file = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          '../../../libs/legal/forms/signup/v1.statements.json',
        ),
        'utf8',
      ),
    ) as { statements: { key: string; label: string }[] };
    await answerAccount(page, { signup: false });
    await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
    const document = page.locator('[data-legal-document]');
    await expect(document).toContainText('Sign-up consent, version 1');
    // The document is only words: no box is inside it.
    await expect(document.getByRole('checkbox')).toHaveCount(0);
    // The boxes, in the file's order, each named by exactly its words.
    const boxes = page.locator('form fieldset').getByRole('checkbox');
    await expect(boxes).toHaveCount(file.statements.length);
    for (const [i, { label }] of file.statements.entries()) {
      await expect(boxes.nth(i)).toHaveAccessibleName(label);
      await expect(boxes.nth(i)).not.toBeChecked();
    }
  });

  test('a save that fails part-way can be retried without recording a box twice', async ({
    page,
  }) => {
    await answerAccount(page, { signup: false });
    const grants = recordGrants(page);
    let failed = false;
    await page.route(CONSENTS_URL, async (route) => {
      const req = route.request();
      if (
        req.method() === 'POST' &&
        req.postDataJSON().statement === 'account_data' &&
        !failed
      ) {
        failed = true;
        return route.abort('connectionrefused');
      }
      return route.fallback();
    });
    await page.goto(
      `${WEB_SIGNED_IN_URL}/consent/sign-up?redirect_url=%2Fabout`,
    );
    await tick(page, AGE);
    await tick(page, ACCOUNT_DATA);
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText(
      'We couldn’t save your answer',
    );
    await expect(page).toHaveURL(/\/consent\/sign-up/);

    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/about`);
    // The retry sent each box again with the key it had before, so the first is a replay.
    const keyOf = (statement: string) =>
      new Set(
        grants.filter((g) => g.body.statement === statement).map((g) => g.key),
      );
    expect(keyOf('age_18plus').size).toBe(1);
    expect(keyOf('account_data').size).toBe(1);
  });

  test('a form updated while the person reads it asks them to read the new one', async ({
    page,
  }) => {
    await answerAccount(page, { signup: false });
    const origin = new URL(WEB_SIGNED_IN_URL).origin;
    await page.route(CONSENTS_URL, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            headers: { 'access-control-allow-origin': origin },
            body: JSON.stringify({
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'form_version_not_in_force',
            }),
          })
        : route.fallback(),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
    await tick(page, AGE);
    await tick(page, ACCOUNT_DATA);
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText(
      'This form was updated while you were reading it.',
    );
    await expect(
      page.getByRole('link', { name: 'Reload the page' }),
    ).toBeVisible();
  });

  test('declining: a plain explanation and Sign out, adults only, and the legal pages stay open', async ({
    page,
  }) => {
    await answerAccount(page, { signup: false });
    await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
    const decline = page.getByRole('region', { name: 'If you’d rather not' });
    await expect(decline).toContainText('every story stays open to read');
    await expect(decline).toContainText('if you’re under 18, please sign out');
    await expect(
      decline.getByRole('button', { name: 'Sign out' }),
    ).toBeVisible();
    // D77: no parental-consent route.
    await expect(page.getByText(/parent|guardian/i)).toHaveCount(0);

    // The privacy and terms pages can be read first without being sent to the step.
    for (const path of ['/privacy', '/terms']) {
      await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
      await expect(
        page.getByRole('button', { name: /^Account: / }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}${path}`);
    }
  });

  test('someone who has accepted goes straight on from the step, and never round in a loop', async ({
    page,
  }) => {
    // The stub's own bootstrap: accepted.
    await page.goto(
      `${WEB_SIGNED_IN_URL}/consent/sign-up?redirect_url=%2Fabout`,
    );
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/about`);
    await page.goto(
      `${WEB_SIGNED_IN_URL}/consent/sign-up?redirect_url=${encodeURIComponent('/consent/sign-up')}`,
    );
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
  });

  test('D85: the banner asks for the newer testimony form; accepting it records Art 9 consent on it, and stories stay', async ({
    page,
  }) => {
    await answerAccount(page, { signup: true, testimony: true });
    const grants = recordGrants(page);
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    const banner = page.locator('[data-consent-banner]');
    await expect(banner).toContainText('Your stories stay on the site');
    // The page is untouched: stories are listed as usual (D93).
    await expect(page.locator('main article').first()).toBeVisible();

    await banner.getByRole('link', { name: 'Read and accept' }).click();
    await expect(page).toHaveURL(
      `${WEB_SIGNED_IN_URL}/consent/testimony?redirect_url=%2Fstories`,
    );
    await expect(banner).toHaveCount(0);
    // One box, the Art 9 one; publishing is asked again at the next submission.
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    await expect(
      page.getByText('Publish my story on heisreal.today'),
    ).toBeVisible();
    await tick(
      page,
      /I agree to He Is Real Today storing and processing my story/,
    );
    await page.getByRole('button', { name: 'Accept' }).click();
    // Back on browse. On a tall screen browse may already have loaded its next page by itself
    // (D55), which adds ?pages=2 to the address.
    await expect(page).toHaveURL(
      new RegExp(`^${WEB_SIGNED_IN_URL}/stories(\\?pages=\\d+)?$`),
    );
    await expect(page.locator('main article').first()).toBeVisible();
    await expect(banner).toHaveCount(0);
    expect(grants.map((g) => g.body)).toEqual([
      {
        form: 'testimony',
        formVersion: 'v1',
        statement: 'special_category_religious',
        mechanism: 'reconsent_prompt',
      },
    ]);
  });

  test('“Not now” hides the banner until the next page load', async ({
    page,
  }) => {
    await answerAccount(page, { signup: true, testimony: true });
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    const banner = page.locator('[data-consent-banner]');
    await banner.getByRole('button', { name: 'Not now' }).click();
    await expect(banner).toHaveCount(0);
    await page.getByRole('link', { name: 'He Is Real Today, home' }).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(banner).toBeVisible();
  });

  test('signed out, the step shows the words but asks to sign in first', async ({
    page,
  }) => {
    await page.goto('/consent/sign-up?redirect_url=%2Fabout');
    await expect(
      page.getByText('Before you use your account, we need'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Agree and continue' }),
    ).toHaveCount(0);
    const signIn = page.getByRole('link', { name: 'Sign in to continue' });
    await expect(signIn).toHaveAttribute(
      'href',
      `/sign-in?redirect_url=${encodeURIComponent('/consent/sign-up?redirect_url=%2Fabout')}`,
    );
  });

  test('where no form is published, the step says so and nothing can be ticked', async ({
    page,
  }) => {
    await page.goto(`${WEB_LIVE_URL}/consent/sign-up`);
    await expect(page.locator('[data-consent-unavailable]')).toContainText(
      'isn’t available on this site yet',
    );
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });

  // Chromium with JavaScript turned off by Playwright still parses <noscript> as script-on,
  // so the message is checked in the page as the server sends it.
  test('without JavaScript, the step says it needs it', async ({ request }) => {
    const html = await (await request.get('/consent/sign-up')).text();
    expect(html).toMatch(
      /<noscript>[^]*?This step needs JavaScript[^]*?<\/noscript>/,
    );
  });
});

test('200% text: the step, the banner and the testimony page fit a 320 px phone, signed in', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'phone-320', 'the smallest phone');
  await enlargeText(page);
  await answerAccount(page, { signup: false });
  await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
  await expect(box(page, AGE)).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);

  await page.unroute(ACCOUNT_URL);
  await answerAccount(page, { signup: true, testimony: true });
  await page.goto(`${WEB_SIGNED_IN_URL}/about`);
  await expect(page.locator('[data-consent-banner]')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto(`${WEB_SIGNED_IN_URL}/consent/testimony`);
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

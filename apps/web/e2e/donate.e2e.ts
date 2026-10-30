import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
  MIN_TARGET,
  shots,
} from './helpers';
import { STRIPE_E2E, WEB_LIVE_URL, WEB_SIGNED_IN_URL } from './servers';

// Giving (Joel, 2026-10-29): Stripe's Buy Buttons on /donate behind a "One-off | Monthly" choice,
// for whichever buttons OpenTofu sets: both on the Go live server, only Monthly on the signed-in
// server, none on dev's server (the placeholder; its fit on every device: pages.e2e.ts).
// Stripe's script is answered by a stand-in that draws each button as Stripe's does (a 288 px box
// in the element's shadow DOM), so no test reaches Stripe.

const SCRIPT = 'https://js.stripe.com/v3/buy-button.js';

const STAND_IN = `
customElements.define('stripe-buy-button', class extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const button = document.createElement('button');
    button.textContent = 'Stripe: ' + this.getAttribute('buy-button-id') + ' with ' + this.getAttribute('publishable-key');
    button.style.cssText = 'display:block;width:288px;max-width:100%;min-height:44px';
    this.attachShadow({ mode: 'open' }).append(button);
  }
});
`;

/** Answers js.stripe.com with the stand-in and refuses any other Stripe host; returns the URLs asked for. */
async function standInStripe(page: Page) {
  const requested: string[] = [];
  await page.route(
    /^https:\/\/([a-z0-9-]+\.)*stripe\.(com|network)\//,
    (route) => {
      requested.push(route.request().url());
      return route.request().url() === SCRIPT
        ? route.fulfill({ contentType: 'text/javascript', body: STAND_IN })
        : route.abort();
    },
  );
  return requested;
}

/** The stand-in's button for a Buy Button ID: proof Stripe's script drew that element. */
const stripeButton = (page: Page, id: string) =>
  page.getByRole('button', {
    name: `Stripe: ${id} with ${STRIPE_E2E.publishableKey}`,
  });
const frequency = (page: Page) =>
  page.getByRole('radiogroup', { name: 'How often would you like to give?' });
const option = (page: Page, name: 'One-off' | 'Monthly') =>
  frequency(page).getByRole('radio', { name });

async function expectShown(page: Page, id: string) {
  // Visible, at least 44 px, and wholly inside the viewport's width (Stripe's button is 288 px).
  await expectTarget(page, stripeButton(page, id));
  await expect(page.locator('stripe-buy-button')).toHaveCount(1);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme, baseURL: WEB_LIVE_URL });

    test('giving fits: the One-off | Monthly choice and each Stripe button', async ({
      page,
    }, info) => {
      await standInStripe(page);
      await page.goto('/donate');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Support this work' }),
      ).toBeVisible();
      // Each option's whole label is the 44 px target (the radio itself is visually hidden).
      for (const label of await frequency(page).locator('label').all()) {
        const box = await label.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
      }
      await expectShown(page, STRIPE_E2E.oneOffButtonId);
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'donate-one-off');

      await frequency(page).getByText('Monthly').click();
      await expectShown(page, STRIPE_E2E.monthlyButtonId);
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'donate-monthly');
    });
  });
}

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'behaviour, not layout',
    );
  });

  test('One-off by default; the choice shows only its Stripe button and stays in the address', async ({
    page,
  }) => {
    const requested = await standInStripe(page);
    await page.goto(`${WEB_LIVE_URL}/donate`);

    await expect(option(page, 'One-off')).toBeChecked();
    const once = page.getByRole('region', { name: 'Give once' });
    await expect(once.getByText('Choose any amount from £1.')).toBeVisible();
    await expect(
      once.locator(
        `stripe-buy-button[buy-button-id="${STRIPE_E2E.oneOffButtonId}"][publishable-key="${STRIPE_E2E.publishableKey}"]`,
      ),
    ).toHaveCount(1);
    await expect(stripeButton(page, STRIPE_E2E.oneOffButtonId)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Give monthly' }),
    ).toHaveCount(0);

    await frequency(page).getByText('Monthly').click();
    await expect(option(page, 'Monthly')).toBeChecked();
    await expect(page).toHaveURL(`${WEB_LIVE_URL}/donate?frequency=monthly`);
    const monthly = page.getByRole('region', { name: 'Give monthly' });
    await expect(
      monthly.getByText('Choose how many £1s a month: 10 is £10 a month.'),
    ).toBeVisible();
    await expect(
      monthly.locator(
        `stripe-buy-button[buy-button-id="${STRIPE_E2E.monthlyButtonId}"][publishable-key="${STRIPE_E2E.publishableKey}"]`,
      ),
    ).toHaveCount(1);
    await expect(stripeButton(page, STRIPE_E2E.monthlyButtonId)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Give once' })).toHaveCount(
      0,
    );
    await expect(
      monthly.getByRole('link', { name: 'manage your monthly gift' }),
    ).toHaveAttribute('href', STRIPE_E2E.donorPortalUrl);

    await frequency(page).getByText('One-off').click();
    await expect(page).toHaveURL(`${WEB_LIVE_URL}/donate`);
    await expect(stripeButton(page, STRIPE_E2E.oneOffButtonId)).toBeVisible();

    // A sandbox key says so; Stripe and the privacy policy are named.
    await expect(page.getByRole('note')).toContainText(
      'no real money is taken',
    );
    await expect(
      page
        .getByRole('main')
        .getByRole('link', { name: 'privacy policy', exact: true }),
    ).toHaveAttribute('href', '/privacy#donations');
    // Stripe's script, once however often the choice changes, and nothing else from Stripe.
    expect(requested).toEqual([SCRIPT]);
  });

  test('the choice works from the keyboard', async ({ page }) => {
    await standInStripe(page);
    await page.goto(`${WEB_LIVE_URL}/donate`);
    await option(page, 'One-off').focus();
    await page.keyboard.press('ArrowRight');
    await expect(option(page, 'Monthly')).toBeChecked();
    await expect(option(page, 'Monthly')).toBeFocused();
    await expect(page).toHaveURL(`${WEB_LIVE_URL}/donate?frequency=monthly`);
    await expect(stripeButton(page, STRIPE_E2E.monthlyButtonId)).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(option(page, 'One-off')).toBeChecked();
    await expect(stripeButton(page, STRIPE_E2E.oneOffButtonId)).toBeVisible();
  });

  test('a link with ?frequency=monthly opens Monthly', async ({ page }) => {
    await standInStripe(page);
    await page.goto(`${WEB_LIVE_URL}/donate?frequency=monthly`);
    await expect(option(page, 'Monthly')).toBeChecked();
    await expect(stripeButton(page, STRIPE_E2E.monthlyButtonId)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Give once' })).toHaveCount(
      0,
    );
  });

  test('the header’s Donate link, from Monthly, opens One-off again', async ({
    page,
  }) => {
    await standInStripe(page);
    await page.goto(`${WEB_LIVE_URL}/donate`);
    await frequency(page).getByText('Monthly').click();
    await expect(page).toHaveURL(`${WEB_LIVE_URL}/donate?frequency=monthly`);
    // A client-side navigation to the same page (Next's Link), not a reload.
    const header = page.getByRole('banner');
    const menu = header.getByRole('button', { name: 'Menu' });
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole('navigation', { name: /^(Main navigation|Menu)$/ })
      .getByRole('link', { name: 'Donate' })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(`${WEB_LIVE_URL}/donate`);
    await expect(option(page, 'One-off')).toBeChecked();
    await expect(stripeButton(page, STRIPE_E2E.oneOffButtonId)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Give monthly' }),
    ).toHaveCount(0);
  });

  test('an option without a button is hidden: Monthly only, no choice to make', async ({
    page,
  }) => {
    await standInStripe(page);
    for (const query of ['', '?frequency=one-off']) {
      await page.goto(`${WEB_SIGNED_IN_URL}/donate${query}`);
      await expect(
        stripeButton(page, STRIPE_E2E.monthlyButtonId),
      ).toBeVisible();
      await expect(page.getByRole('radiogroup')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Give once' })).toHaveCount(
        0,
      );
    }
  });

  test('Stripe’s script loads on /donate only', async ({ page }) => {
    const requested = await standInStripe(page);
    for (const path of ['/', '/about', '/privacy']) {
      await page.goto(`${WEB_LIVE_URL}${path}`);
      await expect(page.locator('main')).toBeVisible();
    }
    expect(requested).toEqual([]);
  });

  test('without Stripe settings: the placeholder, and no Stripe at all', async ({
    page,
  }) => {
    const requested = await standInStripe(page);
    await page.goto('/donate');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Giving isn’t open yet' }),
    ).toBeVisible();
    await expect(
      page.locator('stripe-buy-button, [role=radiogroup]'),
    ).toHaveCount(0);
    expect(requested).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  enlargeText as enlarge,
  expectFocusedAndUncovered,
  expectNoHorizontalOverflow,
} from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// T7 (WCAG 1.4.4): with text at 200% on the smallest phone, every page still fits without
// sideways scrolling and nothing is cut off. A reader's text-size setting scales rem, and so
// does a 200% root font size here; the site sizes its text in rem (never px), and the first
// test proves the prose that matters really doubles (Codex review of #74). Whole-page zoom is covered by the device
// matrix (a 1280 px desktop at 200% is a 640 px viewport).
const PAGES = [
  '/',
  '/stories',
  '/stories?theme=healing',
  '/stories/video-story',
  '/stories/long-words',
  '/stories/long-story',
  '/stories/image-story',
  '/about',
  '/greatest-story',
  '/get-ready',
  '/next-steps',
  '/faqs',
  '/contact',
  '/privacy',
  '/terms',
  '/donate',
  '/stories/no-such-story',
];

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  // The limits page's save bar is also checked on the shortest screen (Codex review of #237).
  const devices = info.title.includes('/admin/limits')
    ? ['phone-320', 'phone-320-landscape']
    : ['phone-320'];
  test.skip(!devices.includes(info.project.name), 'the smallest phone');
});

const fontSize = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test('200% text doubles the prose: FAQ answers, story text, page text', async ({
  page,
}) => {
  const sizes = async () => {
    await page.goto('/faqs');
    const question = page.getByRole('button', {
      name: 'What kind of stories can I submit?',
    });
    await question.click();
    const faq = await fontSize(
      page.locator(`#${await question.getAttribute('aria-controls')} p`),
    );
    await page.goto('/stories/long-story');
    await page.getByRole('button', { name: 'Continue reading' }).click();
    const story = await fontSize(
      page.getByText('The last sentence of the long test story.'),
    );
    await page.goto('/privacy');
    const body = await fontSize(page.locator('main p').nth(1));
    return { faq, story, body };
  };
  const normal = await sizes();
  await enlarge(page);
  const doubled = await sizes();
  for (const key of ['faq', 'story', 'body'] as const)
    expect({ [key]: doubled[key] }).toEqual({ [key]: normal[key] * 2 });
});

for (const path of PAGES) {
  test(`200% text: ${path} fits on a 320 px phone`, async ({ page }) => {
    await enlarge(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      ),
    ).toBe(32);
    await expectNoHorizontalOverflow(page);
    // No heading runs out of its box (a cut-off or overlapping word). Screen-reader-only
    // headings are clipped on purpose.
    const clipped = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main h1, main h2, main h3'))
        .filter((el) => !el.closest('.sr-only'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => (el.textContent ?? '').trim().slice(0, 40)),
    );
    expect(clipped, 'headings cut off').toEqual([]);
  });
}

test('200% text: /admin/limits with its save bar and confirmation fits on the smallest phone', async ({
  page,
}) => {
  await enlarge(page);
  // A session of its own (the stub keeps each session's limits), never shared with a repeat.
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    `admin-text-zoom-limits-${randomUUID()}`,
  );
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
  // The box being typed in stays visible above the save bar as it appears (Codex review of
  // #237): the bar keeps to one line with its list of changes folded away.
  const longest = page.getByLabel('Longest story');
  await longest.fill('12000');
  const bar = page.locator('[data-save-bar]');
  await expect(bar).toContainText('1 change not saved yet');
  await expectFocusedAndUncovered(longest);
  // SL-1 C: one group at a time, from the "Group" drop-down on a phone.
  const group = page.getByLabel('Group', { exact: true });
  await group.selectOption({ label: 'Video and audio' });
  await page.getByLabel('Largest video file').fill('10240');
  await group.selectOption({ label: 'How often' });
  const uploads = page.getByLabel('Upload attempts one person can start');
  await uploads.fill('10000');
  await expect(bar).toContainText('3 changes not saved yet');
  await expectFocusedAndUncovered(uploads);
  // The list of changes opens from its button, and fits too.
  const list = bar.getByRole('list', { name: 'Changes not saved yet' });
  await expect(list).toBeHidden();
  const show = bar.getByRole('button', { name: 'Show changes' });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  const hide = bar.getByRole('button', { name: 'Hide changes' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  // Shown, the list keeps the bar to its share of the screen; going back to a box folds it
  // away, so the box is never under the bar (Codex review of #237, round 2).
  await page.keyboard.press('Shift+Tab');
  const box = page.locator('input:focus');
  await expect(box).toHaveCount(1);
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  await expectFocusedAndUncovered(box);
  const { height, viewport } = await bar.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    viewport: window.innerHeight,
  }));
  expect(height).toBeLessThanOrEqual(viewport * 0.4);
  for (const name of ['Undo', 'Save'])
    await expect(bar.getByRole('button', { name, exact: true })).toBeInViewport(
      {
        ratio: 1,
      },
    );
  await show.click();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toContainText('Longest story: 10,000 → 12,000 characters');
  await expectNoHorizontalOverflow(page);
  await bar.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

// Plan 4e: the agreement steps (first time and with a redline) and /admin/consent with its
// confirmation, each as its own person at the stub api-user.
for (const [name, seed, path, prefix] of [
  ['first terms', { terms: null }, '/consent/terms', 'unaccepted-text-zoom'],
  ['changed terms', { terms: 0 }, '/consent/terms', 'text-zoom-terms'],
  [
    'testimony consent',
    { testimony: 1 },
    '/consent/testimony',
    'text-zoom-testimony',
  ],
  ['admin consent', {}, '/admin/consent', 'admin-text-zoom-consent'],
] as const) {
  test(`200% text: ${path} (${name}) fits on a 320 px phone`, async ({
    page,
    request,
  }) => {
    // A session of its own, never shared with a repeat; the prefix keeps its role.
    const session = `${prefix}-${randomUUID()}`;
    await request.post(`${STUB_USER_URL}/__e2e/sessions/${session}`, {
      data: seed,
    });
    await enlarge(page);
    await page.addInitScript(
      (s) => window.localStorage.setItem('e2e-session', s),
      session,
    );
    await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (path === '/admin/consent') {
      await page.getByRole('textbox').fill('A new version.');
      await page.getByRole('button', { name: /^Save as version/ }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
    } else {
      await expect(page.locator('[data-agreement]')).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
  });
}

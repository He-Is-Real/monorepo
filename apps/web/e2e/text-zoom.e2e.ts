import { expect, test } from '@playwright/test';
import { enlargeText as enlarge, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// T7 (WCAG 1.4.4): with text at 200% on the smallest phone, every page still fits without
// sideways scrolling and nothing is cut off. A reader's text-size setting scales rem, and so
// does a 200% root font size here; the site sizes its text in rem (never px), and the first
// test proves the prose that matters really doubles (Codex review of #74). Whole-page zoom is covered by the device
// matrix (a 1280 px desktop at 200% is a 640 px viewport).
const PAGES = [
  '/',
  '/stories',
  '/stories?tag=healing',
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
  '/consent/sign-up',
  '/consent/testimony',
  '/stories/no-such-story',
];

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'phone-320', 'the smallest phone');
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

test('200% text: /admin/legal with its preview and confirmation fits on a 320 px phone', async ({
  page,
}) => {
  await enlarge(page);
  // An admin (stub-api-user.mjs: sessions starting `admin` are Admins), signed in.
  await page.addInitScript(() =>
    window.localStorage.setItem('e2e-session', 'admin-text-zoom'),
  );
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/legal`);
  // The editor and its preview, with a table and a long code name, and the confirmation.
  await page
    .getByLabel('The text')
    .fill(
      '## Storage\n\n| Name | Set by |\n| --- | --- |\n| `bunny_stream_settings_long_name` | This site |\n',
    );
  await page.getByRole('button', { name: /^Publish as version/ }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

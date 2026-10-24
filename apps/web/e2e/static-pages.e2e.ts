import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, expectTarget, shots } from './helpers';

// M1 step 6b-2: the static pages on every device in the matrix and in both colour schemes,
// the site footer, keyboard use of the FAQ accordion, and robots.txt and the sitemap while
// indexing is off (no INDEXING=allow, as in dev; playwright.config.ts).

const PAGES = [
  {
    path: '/about',
    h1: 'The heart behind He Is Real',
    cta: 'Get ready to share',
  },
  {
    path: '/greatest-story',
    h1: 'The Greatest Story Ever Told',
    cta: 'Explore next steps',
  },
  { path: '/get-ready', h1: 'Get ready to share', cta: 'Read the FAQs' },
  { path: '/next-steps', h1: 'Next steps', cta: 'Send us a message' },
  { path: '/faqs', h1: 'Frequently asked questions', cta: 'Get in touch' },
  { path: '/contact', h1: 'Get in touch', cta: 'Email info@heisreal.today' },
  { path: '/privacy', h1: 'Privacy policy' },
  { path: '/terms', h1: 'Terms of use' },
] as const;

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    for (const p of PAGES) {
      test(`${p.path}: fits, with its landmarks, heading and targets`, async ({
        page,
      }, info) => {
        const response = await page.goto(p.path);
        expect(response?.status()).toBe(200);
        expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          'href',
          new RegExp(`${p.path}$`),
        );

        await expect(page.getByRole('banner')).toHaveCount(1);
        await expect(page.getByRole('main')).toHaveCount(1);
        await expect(page.getByRole('contentinfo')).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.h1);

        await expectNoHorizontalOverflow(page);
        if ('cta' in p) {
          await expectTarget(
            page,
            page.getByRole('main').getByRole('link', { name: p.cta }).first(),
          );
        }
        const footer = page.getByRole('contentinfo');
        await expectTarget(
          page,
          footer.getByRole('link', { name: 'Privacy policy' }),
        );
        await expectTarget(page, footer.getByRole('link', { name: 'Terms' }));
        await expectTarget(
          page,
          footer.getByRole('link', { name: 'How we use cookies' }),
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await shots(page, info.project.name, scheme, p.path.slice(1));
      });
    }

    test('FAQs: an opened answer fits too', async ({ page }, info) => {
      await page.goto('/faqs');
      for (const button of await page
        .getByRole('main')
        .getByRole('button')
        .all()) {
        await button.click();
      }
      await expect(
        page.getByText(/real stories from real people/),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shots(page, info.project.name, scheme, 'faqs-open');
    });
  });
}

test('FAQ accordion works from the keyboard', async ({ page }) => {
  await page.goto('/faqs');
  const first = page.getByRole('button', {
    name: 'What kind of stories can I submit?',
  });
  const answer = page.getByText(/It doesn’t have to be dramatic/);
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(answer).toBeHidden();

  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(answer).toBeVisible();
  await page.keyboard.press('Space');
  await expect(first).toHaveAttribute('aria-expanded', 'false');

  // Tab skips the collapsed answer and lands on the next question.
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Can I submit anonymously?' }),
  ).toBeFocused();
});

test('About loads no video or third-party frame; Contact collects nothing', async ({
  page,
}) => {
  await page.goto('/about');
  await expect(page.locator('main iframe, main video')).toHaveCount(0);
  await page.goto('/contact');
  await expect(
    page.locator('main form, main input, main textarea, main select'),
  ).toHaveCount(0);
});

test('structured data: the organisation and website on every page, the FAQs as an FAQPage', async ({
  page,
}) => {
  await page.goto('/faqs');
  const data = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((els) => els.map((e) => JSON.parse(e.textContent ?? '{}')));
  const types = data.flatMap((d) =>
    d['@graph']
      ? d['@graph'].map((g: { '@type': string }) => g['@type'])
      : [d['@type']],
  );
  expect(types).toEqual(
    expect.arrayContaining(['Organization', 'WebSite', 'FAQPage']),
  );
  const faq = data.find((d) => d['@type'] === 'FAQPage');
  const questions = faq.mainEntity.map((q: { name: string }) => q.name);
  expect(questions).toContain('What proof is there that God exists?');
  // The page and its structured data say what the consent model says: socials are a choice.
  const where = faq.mainEntity.find(
    (q: { name: string }) => q.name === 'Where will my story appear?',
  );
  expect(where.acceptedAnswer.text).toMatch(/only if you say yes/);
  expect(questions).toHaveLength(
    await page.getByRole('main').getByRole('button').count(),
  );
});

test('the footer’s cookie notice leads to the cookie list', async ({
  page,
}) => {
  await page.goto('/about');
  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: 'How we use cookies' })
    .click();
  await expect(page).toHaveURL(/\/privacy#cookies$/);
  const section = page.locator('#cookies');
  await expect(
    section.getByRole('heading', { name: 'Cookies and storage' }),
  ).toBeInViewport();
  await expect(section.getByRole('rowheader')).toContainText([
    'theme',
    '__client_uat',
    '__session',
    '__clerk_environment',
    '__cf_bm, _cfuvid',
    'bunny_stream_settings_…',
    '__clerk_db_jwt',
  ]);
});

test('Contact’s email button writes to the right address', async ({ page }) => {
  await page.goto('/contact');
  await expect(
    page.getByRole('main').getByRole('link', {
      name: 'Email info@heisreal.today',
    }),
  ).toHaveAttribute('href', 'mailto:info@heisreal.today');
});

test('the footer links the site’s pages', async ({ page }) => {
  await page.goto('/about');
  const nav = page.getByRole('navigation', { name: 'Footer' });
  await nav.getByRole('link', { name: 'FAQs' }).click();
  await expect(page).toHaveURL(/\/faqs$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Frequently asked questions',
  );
});

test('dev isn’t indexed: robots.txt turns crawlers away and there is no sitemap', async ({
  request,
}) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  expect(text).toMatch(/User-Agent: \*\s+Disallow: \//i);
  expect(text).not.toMatch(/sitemap/i);

  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(404);
  expect(sitemap.headers()['x-robots-tag']).toBe('noindex, nofollow');
});

test.describe('as a real visitor’s browser', () => {
  // Clerk turns its telemetry off for automated browsers (navigator.webdriver) and robot user
  // agents, so look like an ordinary Chrome, or this test would pass whatever the setting.
  test.use({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });

  test('no optional Clerk telemetry: collector off, no request to clerk-telemetry.com, nothing stored', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false,
      });
    });
    const telemetry: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).hostname.endsWith('clerk-telemetry.com'))
        telemetry.push(r.url());
    });
    await page.goto('/about');
    // Deterministic, no waiting for a flush: once Clerk has loaded, its telemetry collector is
    // either absent (telemetry={false}) or would report itself enabled (it did before the fix).
    await page.waitForFunction(
      () => (window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true,
    );
    const collector = await page.evaluate(() => {
      const t = (window as { Clerk?: { telemetry?: { isEnabled?: boolean } } })
        .Clerk?.telemetry;
      return t ? { enabled: t.isEnabled === true } : null;
    });
    expect(collector?.enabled ?? false).toBe(false);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const keys = await page.evaluate(() => [
      ...Object.keys(localStorage),
      ...Object.keys(sessionStorage),
    ]);
    expect(keys.filter((k) => k.startsWith('clerk_telemetry'))).toEqual([]);
    expect(telemetry).toEqual([]);
  });
});

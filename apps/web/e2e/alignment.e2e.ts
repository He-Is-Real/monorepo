import { expect, type Locator, type Page, test } from '@playwright/test';

// The reading column (Joel, R1 option A, 2026-10-24): pages narrow their whole content column,
// never the text inside it, so the heading, the divider and share row, the text and the
// boxes in the column share its left and right edges (within 1 px), and from 1024 px the story
// sidebar sits one design gap (3rem) from the text. Every device, light only (the colour scheme
// doesn't change sizes).

const DESIGN_GAP = 48; // gap-x-12

async function edges(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('not rendered');
  return { left: box.x, right: box.x + box.width };
}

async function expectAligned(
  page: Page,
  column: Locator,
  parts: Record<string, Locator>,
) {
  const col = await edges(column);
  for (const [name, part] of Object.entries(parts)) {
    const e = await edges(part);
    expect(
      Math.abs(e.left - col.left),
      `${name}: left edge`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(e.right - col.right),
      `${name}: right edge`,
    ).toBeLessThanOrEqual(1);
  }
}

for (const slug of ['browse-test-02', 'video-story']) {
  test(`story ${slug}: one column, the sidebar one gap from the text`, async ({
    page,
  }, info) => {
    await page.goto(`/stories/${slug}`);
    const column = page.locator('[data-story-column]');
    const text = page.locator('[data-story-text]');
    await expectAligned(page, column, {
      breadcrumb: page.getByRole('navigation', { name: 'Breadcrumb' }),
      'header (title block)': page.locator('article header'),
      'share row and divider': page
        .getByRole('button', { name: 'Share' })
        .locator('..'),
      text,
      'first paragraph': text.locator('p').first(),
    });
    const sidebar = await edges(
      page.getByRole('complementary', { name: 'Keep exploring' }),
    );
    const t = await edges(text);
    const width = info.project.use.viewport?.width ?? 0;
    if (width >= 1024) {
      expect(
        sidebar.left - t.right,
        'gap between text and sidebar',
      ).toBeCloseTo(DESIGN_GAP, 0);
    } else {
      // Below the text, in the same column.
      expect(Math.abs(sidebar.left - t.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(sidebar.right - t.right)).toBeLessThanOrEqual(1);
    }
    // The composition is centred in the page.
    const article = await edges(page.locator('article'));
    const viewport = page.viewportSize()?.width ?? 0;
    expect(
      Math.abs(article.left - (viewport - article.right)),
      'centred',
    ).toBeLessThanOrEqual(1);
  });
}

test('privacy: heading, notice, text and table share the column', async ({
  page,
}, info) => {
  await page.goto('/privacy');
  const column = page.locator('main [data-reading-column]');
  await expectAligned(page, column, {
    'draft notice': page.getByRole('note'),
    heading: page.getByRole('heading', { level: 1 }),
    'first paragraph': page.locator('main p').nth(1),
    'cookies heading': page.getByRole('heading', {
      name: 'Cookies and storage',
    }),
  });
  // The table breaks out from 1024 px, by the same amount on both sides.
  const col = await edges(column);
  const table = await edges(page.locator('main table').locator('..'));
  const width = info.project.use.viewport?.width ?? 0;
  if (width >= 1024) {
    expect(
      Math.abs(col.left - table.left - (table.right - col.right)),
    ).toBeLessThanOrEqual(1);
  } else {
    expect(Math.abs(table.left - col.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(table.right - col.right)).toBeLessThanOrEqual(1);
  }
});

test('FAQs: the header and every question share the column', async ({
  page,
}) => {
  await page.goto('/faqs');
  const column = page.locator('main [data-reading-column]');
  const questions = page.locator('main [data-reading-column] li');
  await expectAligned(page, column, {
    header: page.locator('main header'),
    heading: page.getByRole('heading', { level: 1 }),
    'first question': questions.first(),
    'last question': questions.last(),
  });
});

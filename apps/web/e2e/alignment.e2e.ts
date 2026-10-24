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

// Story pages (Joel, 2026-10-24: "not off centre to the left"): the hero (title block, media,
// share row) spans the whole composition, the text column plus the gap and the
// sidebar from 1024 px, so the hero and its media are centred on the page. Below it the text
// starts at the composition's left edge and the sidebar ends at its right edge. Every kind of
// story: written with and without a picture (portrait, panorama), video (landscape, tall),
// audio, and long titles.
const STORIES: Record<string, { media: boolean }> = {
  'browse-test-02': { media: false }, // written, no picture
  'long-words': { media: false }, // written, a long title of unbreakable words
  'browse-test-12': { media: true }, // written, portrait picture
  'browse-test-09': { media: true }, // written, panorama picture
  'browse-test-03': { media: true }, // video, landscape, long title
  'video-story': { media: true }, // video, tall
  'browse-test-04': { media: true }, // audio
};

for (const [slug, { media: hasMedia }] of Object.entries(STORIES)) {
  test(`story ${slug}: the hero is centred on the page, the text and sidebar under it`, async ({
    page,
  }, info) => {
    await page.goto(`/stories/${slug}`);
    const hero = page.locator('[data-story-hero]');
    const text = page.locator('[data-story-text]');
    const media = page.locator('[data-story-media]');
    // The hero, and the picture or player in it, are centred on the page.
    const centre =
      (await page.evaluate(() => document.documentElement.clientWidth)) / 2;
    const middle = (e: { left: number; right: number }) =>
      (e.left + e.right) / 2;
    const h = await edges(hero);
    expect(Math.abs(middle(h) - centre), 'hero: centred').toBeLessThanOrEqual(
      1,
    );
    if (hasMedia) {
      const m = await edges(media);
      expect(
        Math.abs(middle(m) - centre),
        'media: centred',
      ).toBeLessThanOrEqual(1);
      expect(m.left, 'media: inside the hero').toBeGreaterThanOrEqual(
        h.left - 1,
      );
      expect(m.right, 'media: inside the hero').toBeLessThanOrEqual(
        h.right + 1,
      );
    }
    await expectAligned(page, hero, {
      'header (title block)': page.locator('article header'),
      'share row and divider': page
        .getByRole('button', { name: 'Share' })
        .locator('..'),
      'the composition (article)': page.locator('article'),
    });
    const article = await edges(page.locator('article'));
    const t = await edges(text);
    const p = await edges(text.locator('p').first());
    expect(
      Math.abs(t.left - article.left),
      'text: left edge',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(p.left - t.left),
      'first paragraph: left edge',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(p.right - t.right),
      'first paragraph: right edge',
    ).toBeLessThanOrEqual(1);
    const sidebar = await edges(
      page.getByRole('complementary', { name: 'Keep exploring' }),
    );
    const width = info.project.use.viewport?.width ?? 0;
    if (width >= 1024) {
      expect(
        sidebar.left - t.right,
        'gap between text and sidebar',
      ).toBeCloseTo(DESIGN_GAP, 0);
      expect(
        Math.abs(sidebar.right - article.right),
        'sidebar: right edge',
      ).toBeLessThanOrEqual(1);
    } else {
      // Below the text, in the same column.
      expect(Math.abs(sidebar.left - t.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(sidebar.right - t.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(t.right - article.right)).toBeLessThanOrEqual(1);
    }
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
